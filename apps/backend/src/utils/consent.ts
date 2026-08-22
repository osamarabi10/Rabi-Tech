import { prisma } from '../prisma';
import logger from '../lib/logger';
import { getTenantId } from '../lib/tenant-context';

/**
 * Marketing consent.
 *
 * On the official WhatsApp Business Platform, Meta enforces opt-out on marketing
 * templates for you. RabiTech runs an unofficial gateway where **nothing does**,
 * so this module is the entire mechanism standing between a subscriber and
 * messaging someone who has asked them to stop.
 *
 * That makes opt-out a hard rule, not a preference: `audienceWhere()` excludes
 * OPTED_OUT unconditionally, with no override flag anywhere in the API.
 */

/**
 * Default opt-out keywords, covering the languages this platform serves.
 *
 * Matched on the *whole trimmed message*, not as a substring — "stop" inside
 * "please don't stop sending offers" is not an opt-out, and treating it as one
 * would silently mute a customer who wanted the opposite.
 */
export const DEFAULT_OPT_OUT_KEYWORDS = [
  // English
  'stop', 'unsubscribe', 'cancel',
  // Arabic
  'توقف', 'إلغاء', 'الغاء', 'ايقاف', 'إيقاف', 'لا اريد', 'لا أريد',
  // Hebrew
  'הפסק', 'הסר', 'ביטול',
] as const;

/** Opt-back-in keywords, so a customer can undo without contacting support. */
export const DEFAULT_OPT_IN_KEYWORDS = [
  'start', 'subscribe', 'اشتراك', 'ابدأ', 'הרשם', 'התחל',
] as const;

/** Strips punctuation and case so "STOP." and "stop" match alike. */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?،؛,:;"'()[\]{}<>*_~`-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type ConsentSignal = 'OPTED_OUT' | 'OPTED_IN' | null;

/**
 * Classifies an inbound message as an opt-out, an opt-in, or neither.
 *
 * Exact whole-message match only — see the note on DEFAULT_OPT_OUT_KEYWORDS.
 */
export function detectConsentSignal(body: string): ConsentSignal {
  const normalized = normalize(body || '');
  if (!normalized) return null;
  if ((DEFAULT_OPT_OUT_KEYWORDS as readonly string[]).includes(normalized)) return 'OPTED_OUT';
  if ((DEFAULT_OPT_IN_KEYWORDS as readonly string[]).includes(normalized)) return 'OPTED_IN';
  return null;
}

/** Who changed consent, when a person did. */
export type ConsentActor = { id: string; name: string } | null;

/**
 * Record one consent change.
 *
 * Kept beside the update rather than folded into it so both write paths — a
 * customer's keyword and an agent's toggle — go through the same code. The
 * contact row holds the current value; without this the previous one was
 * simply overwritten, and "who" was never recorded at all.
 *
 * Deliberately not fail-closed. Consent itself is the thing that must not be
 * lost, and refusing a customer's STOP because the history row failed to
 * write would be the worse outcome by a distance.
 */
async function recordConsentEvent(opts: {
  contactId: string;
  fromValue: string | null;
  toValue: string;
  source: 'keyword' | 'agent' | 'import' | 'api';
  actor: ConsentActor;
}): Promise<void> {
  try {
    await prisma.consentEvent.create({
      data: {
        organizationId: getTenantId(),
        contactId: opts.contactId,
        fromValue: opts.fromValue,
        toValue: opts.toValue,
        source: opts.source,
        actorUserId: opts.actor?.id ?? null,
        actorName: opts.actor?.name ?? null,
      },
    });
  } catch (error) {
    logger.warn('Consent history write failed', {
      contactId: opts.contactId,
      error: String(error),
    });
  }
}

/**
 * Applies an inbound consent signal to a contact.
 *
 * Returns true when consent actually changed, so the caller can decide whether
 * to confirm it to the customer. Re-sending "you're unsubscribed" every time
 * someone types STOP again is exactly the kind of noise opt-out exists to stop.
 */
export async function applyInboundConsentSignal(opts: {
  contactId: string;
  body: string;
}): Promise<{ changed: boolean; consent: ConsentSignal }> {
  const signal = detectConsentSignal(opts.body);
  if (!signal) return { changed: false, consent: null };

  const organizationId = getTenantId();
  const contact = await prisma.contact.findUnique({
    where: { id: opts.contactId },
    select: { marketingConsent: true },
  });
  if (!contact) return { changed: false, consent: signal };
  if (contact.marketingConsent === signal) return { changed: false, consent: signal };

  await prisma.contact.update({
    where: { id: opts.contactId },
    data: {
      marketingConsent: signal,
      consentSource: 'keyword',
      consentUpdatedAt: new Date(),
    },
  });

  await recordConsentEvent({
    contactId: opts.contactId,
    fromValue: contact.marketingConsent,
    toValue: signal,
    source: 'keyword',
    // No actor: the customer sent it themselves.
    actor: null,
  });

  logger.info('Marketing consent changed by keyword', {
    organizationId,
    contactId: opts.contactId,
    consent: signal,
  });

  return { changed: true, consent: signal };
}

/**
 * Sets consent explicitly — an agent toggling it, or a CSV import declaring it.
 */
export async function setContactConsent(
  contactId: string,
  consent: 'UNKNOWN' | 'OPTED_IN' | 'OPTED_OUT',
  source: 'agent' | 'import' | 'api',
  actor: ConsentActor = null,
): Promise<void> {
  // Read first: the previous value is only knowable before the write, and it
  // is half of what makes the history row readable.
  const before = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { marketingConsent: true },
  });

  await prisma.contact.update({
    where: { id: contactId },
    data: {
      marketingConsent: consent,
      consentSource: source,
      consentUpdatedAt: new Date(),
    },
  });

  // A no-op toggle writes nothing. An agent opening the dropdown and picking
  // the value that was already set has not changed anything, and a history
  // full of those is a history nobody reads.
  if (before?.marketingConsent === consent) return;

  await recordConsentEvent({
    contactId,
    fromValue: before?.marketingConsent ?? null,
    toValue: consent,
    source,
    actor,
  });
}
