import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import {
  MetaApiError,
  sendTemplateMessage,
  type MetaTemplateSendComponent,
} from '../channels/meta.client';
import { activeMetaCredential } from '../channels/meta.service';
import { channelCapabilities } from '../channels/channel.service';
import { isMetaTemplateSendable } from './meta-templates.service';

/** Meta's tier ceiling is per rolling 24 hours, not per calendar day. */
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse a business-initiated send once the tier's 24-hour ceiling is spent.
 *
 * D-24 recorded `maxUniqueRecipientsPer24h` as modelled, surfaced and enforced
 * by nothing — and recorded that this was acceptable *only because* no
 * business-initiated conversation could start. Template sending is exactly what
 * makes one start, so landing it removes the reasoning the gap rested on. This
 * is the enforcement point.
 *
 * ## What is counted
 *
 * **Unique recipients, not sends.** Meta caps how many distinct customers a
 * business opens a conversation with, so a second template to somebody already
 * messaged inside the window costs nothing. Blocking that would refuse the
 * follow-up while permitting the first contact, which is backwards.
 *
 * **Reservations included, releases excluded.** A row is counted while
 * `releasedAt` is null. The reservation is written before the provider call, so
 * two concurrent sends cannot both read a count below the ceiling and both
 * proceed; and a send Meta refused sets `releasedAt`, returning the slot,
 * because a refused send opened no conversation. The model already carried
 * `releasedAt` for exactly this — nothing new is stored.
 *
 * ## Where the ceiling comes from
 *
 * `channelCapabilities()`, whose own comment says it is for "UI gating and
 * send-time rules". Not from re-deriving the number out of `messagingTier`
 * here: that mapping lives in `meta.adapter.ts`, and a second copy would be
 * free to disagree with the one the console shows the customer.
 *
 * A null ceiling means the tier is unknown or unlimited and **nothing is
 * enforced**. That is deliberate rather than fail-closed: the value is absent
 * when Meta has not told us the tier yet, and refusing every send because a
 * status field has not synced would take the product down to enforce a limit
 * that may not apply.
 *
 * ## This is the per-24h tier limit only
 *
 * There are two 250s and they are not the same cap. The other one — the
 * 250-contact ceiling for *unverified businesses* — has a different
 * denominator (**per broadcast**, not per rolling day), is lifted by business
 * verification rather than by messaging tier, is modelled nowhere in this
 * schema, and belongs to the broadcast path rather than here.
 *
 * **It is deliberately not implemented, and satisfying this cap does not
 * satisfy it.** §2 of docs/HANDOVER.md documents both and exists precisely
 * because they were being read as one thing. A broadcast of 5,000 contacts
 * from an unverified number still stops after the 250th with no explanation
 * anywhere in the product.
 */
async function assertWithinRecipientCap(
  organizationId: string,
  recipientPhone: string,
): Promise<void> {
  const { maxUniqueRecipientsPer24h: ceiling } = await channelCapabilities();
  if (ceiling === null || ceiling === undefined) return;

  const since = new Date(Date.now() - CAP_WINDOW_MS);
  const held = await prisma.metaTemplateSend.findMany({
    where: {
      organizationId,
      businessInitiated: true,
      releasedAt: null,
      reservedAt: { gte: since },
    },
    select: { recipientPhone: true },
    distinct: ['recipientPhone'],
  });

  // Already inside the window: no new conversation, so no new slot.
  if (held.some((row) => row.recipientPhone === recipientPhone)) return;

  if (held.length >= ceiling) {
    throw new TemplateSendError(
      429,
      'RECIPIENT_CAP_REACHED',
      `This number may start ${ceiling} conversations per 24 hours and has reached that limit. It rises as the number's messaging tier does.`,
    );
  }
}

/**
 * Sending an approved Meta template — the only way to start a conversation.
 *
 * ## Why this is the most consequential gap that was open
 *
 * Meta permits free-form messages only inside the 24-hour window that opens
 * when the *customer* writes. Outside it — which includes every contact who has
 * never written — an approved template is the sole permitted message.
 *
 * `assertSendable` in the channel service enforces that correctly and refuses
 * with `SERVICE_WINDOW_NEVER_OPENED`. With no template path, that refusal was
 * absolute: a Meta-only workspace could reply and could never initiate. No
 * onboarding, no order notification, no re-engagement, no broadcast to a list
 * that had not written first.
 *
 * And `GROWTH`, `BUSINESS` and `ENTERPRISE` are `['WHATSAPP_CLOUD']` only. So it
 * was not a missing feature on a side channel — it was a ceiling on the three
 * paying tiers, and the reason `MetaMessageTemplate` carried the note *"Only
 * the exact string APPROVED is sendable in a later phase."*
 *
 * ## This deliberately bypasses the service window
 *
 * Every other send path must not. A template is the documented exemption, and
 * routing it through `assertSendable` would refuse the one message type that
 * exists precisely to be sent when the window is shut.
 *
 * ## Rejected sends are not free
 *
 * They depress the number's quality rating, which governs its messaging tier.
 * So everything checkable is checked locally first — approved status, the
 * template not archived, consent, blocking — rather than letting Meta refuse.
 */

export class TemplateSendError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type TemplateSendInput = {
  templateId: string;
  contactId: string;
  /** Positional values for the body's `{{1}}`, `{{2}}`. */
  variables?: string[];
  source?: 'MANUAL' | 'CAMPAIGN' | 'WORKFLOW' | 'API';
};

/**
 * Build the components Meta expects from positional variables.
 *
 * Positional because that is what a template is: `{{1}}` is the first value,
 * not a named one. A friendlier named API here would need a mapping the
 * template itself does not carry, and getting it wrong sends the customer the
 * wrong words rather than erroring.
 */
export function buildComponents(variables: string[]): MetaTemplateSendComponent[] {
  const values = variables.filter((value) => value !== undefined && value !== null);
  if (!values.length) return [];
  return [{
    type: 'body',
    parameters: values.map((value) => ({ type: 'text', text: String(value).slice(0, 1024) })),
  }];
}

/**
 * How many `{{n}}` placeholders a template's body declares.
 *
 * Checked before sending because a count mismatch is the most common way a
 * template send fails, and Meta's error for it arrives after the number has
 * already been charged a rejection.
 */
export function bodyPlaceholderCount(components: unknown): number {
  if (!Array.isArray(components)) return 0;
  const body = components.find((component: any) => String(component?.type).toUpperCase() === 'BODY');
  const text = String((body as any)?.text ?? '');
  const matches = text.match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? new Set(matches.map((m) => m.replace(/\D/g, ''))).size : 0;
}

export async function sendMetaTemplate(input: TemplateSendInput) {
  const organizationId = getTenantId();

  const template = await prisma.metaMessageTemplate.findFirst({
    where: { id: input.templateId },
    select: {
      id: true, name: true, language: true, status: true,
      archivedAt: true, components: true, wabaId: true,
    },
  });
  if (!template) throw new TemplateSendError(404, 'TEMPLATE_NOT_FOUND', 'Template not found.');

  // The exact string APPROVED, and not archived. Anything else Meta refuses,
  // and a refusal costs quality rating.
  if (!isMetaTemplateSendable(template.status, template.archivedAt)) {
    throw new TemplateSendError(
      409,
      'TEMPLATE_NOT_SENDABLE',
      `This template is ${template.archivedAt ? 'archived' : template.status.toLowerCase()} and cannot be sent.`,
    );
  }

  const contact = await prisma.contact.findFirst({
    where: { id: input.contactId },
    select: { id: true, phone: true, marketingConsent: true, blockedAt: true },
  });
  if (!contact) throw new TemplateSendError(404, 'CONTACT_NOT_FOUND', 'Contact not found.');

  /*
    Consent and blocking are checked here, not left to the caller.

    A template send is business-initiated by definition — the customer has not
    written — which makes it exactly the send that most needs the check. An
    opted-out contact receiving an unsolicited template is the failure this
    product's consent model exists to prevent.
  */
  if (contact.blockedAt) {
    throw new TemplateSendError(403, 'CONTACT_BLOCKED', 'This contact is blocked.');
  }
  if (contact.marketingConsent === 'OPTED_OUT') {
    throw new TemplateSendError(403, 'CONTACT_OPTED_OUT', 'This contact has opted out.');
  }

  const expected = bodyPlaceholderCount(template.components);
  const provided = (input.variables ?? []).length;
  if (expected !== provided) {
    throw new TemplateSendError(
      400,
      'VARIABLE_COUNT_MISMATCH',
      `This template needs ${expected} value(s); ${provided} were given.`,
    );
  }

  /*
    Through activeMetaCredential, not a query of my own.

    It decrypts the token, refuses a credential already marked invalid, and is
    deliberately kept apart from the response-shaped reader so a careless
    res.json cannot compile into a leak. Reading the row here would have
    duplicated the decryption and quietly dropped the invalid-credential check —
    spending a known-dead token on a send that fails and costs quality rating.
  */
  const credential = await activeMetaCredential();
  if (!credential) {
    throw new TemplateSendError(409, 'NO_META_CHANNEL', 'No connected Meta channel to send from.');
  }

  /*
    Reserved before sending, completed after.

    MetaTemplateSend already modelled this — RESERVED, providerMessageId,
    releasedAt — and nothing had ever written a row. The order is the same
    persist-before-send rule the message path follows: a transport error after
    Meta accepted the message must not leave us with no record of a message the
    customer received.
  */
  /*
    Last refusal before the provider call, and deliberately after the cheap
    ones. Template status, consent, blocking and variable count are field reads;
    this is a query. Ordering the query first would spend a round trip to
    discover a template was archived.

    But it must come before the reservation, or the row written to hold a slot
    would itself be counted as one.
  */
  await assertWithinRecipientCap(organizationId, contact.phone);

  const reservation = await prisma.metaTemplateSend.create({
    data: {
      organizationId,
      templateId: template.id,
      contactId: contact.id,
      recipientPhone: contact.phone,
      source: input.source ?? 'MANUAL',
      businessInitiated: true,
      status: 'RESERVED',
    },
    select: { id: true },
  });

  try {
    const result = await sendTemplateMessage(
      credential.phoneNumberId,
      credential.accessToken,
      contact.phone,
      template.name,
      template.language,
      buildComponents(input.variables ?? []),
    );

    const providerMessageId = result?.messages?.[0]?.id ?? null;
    await prisma.metaTemplateSend.update({
      where: { id: reservation.id },
      data: { status: 'SENT', sentAt: new Date(), providerMessageId },
    });

    logger.info('Meta template sent', {
      templateId: template.id,
      contactId: contact.id,
      sendId: reservation.id,
    });
    return { sendId: reservation.id, providerMessageId, templateName: template.name };
  } catch (error) {
    const reason = error instanceof MetaApiError
      ? `${error.message}`.slice(0, 500)
      : String((error as Error)?.message || error).slice(0, 500);

    await prisma.metaTemplateSend.update({
      where: { id: reservation.id },
      data: { status: 'FAILED', failureReason: reason, releasedAt: new Date() },
    });

    logger.error('Meta template send failed', {
      templateId: template.id,
      contactId: contact.id,
      error: reason,
    });
    throw new TemplateSendError(502, 'PROVIDER_REFUSED', reason);
  }
}
