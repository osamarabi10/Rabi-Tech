import { getTenantCache, getTenantId } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  OutboundUsageOptions,
  contactIdForAddress,
  prepareOutboundSend,
  recordSuccessfulOutboundSend,
} from '../usage/entitlements';
import { OpenWASendAdapter } from '../whatsapp/openwa.adapter';
import { ChannelAdapter, ChannelKind, ChannelSendResult, SendMediaOptions } from './channel.types';
import { createMetaAdapter } from './meta.adapter';
import { activeMetaCredential } from './meta.service';
import { serviceWindowFor } from './service-window';

/**
 * The one outbound send path.
 *
 * Before this, ten call sites imported OpenWAService directly, so "which
 * channel does this organization use" was answered identically everywhere by
 * not asking. Adding a second channel would have meant editing every automated
 * message the product sends - welcome, out-of-hours, CSAT, closing reply,
 * workflow, campaign, inbound auto-reply - and missing one would mean a
 * customer silently not receiving a reply on a channel that reported healthy.
 *
 * Quota accounting lives here rather than in an adapter, because it is a
 * property of the tenant's plan, not of the transport. A message costs the same
 * whether it left through OpenWA or Meta, and an adapter that could forget to
 * meter would be a way to send for free.
 */

/**
 * A send refused before it reached a provider.
 *
 * Carries an Arabic message because every one of these is shown to an agent
 * mid-conversation, and a stable code because the UI must be able to tell a
 * closed service window from a channel that is mid-switch without parsing prose.
 */
export class ChannelSendError extends Error {
  readonly code: string;
  /** Arabic, shown to the agent as-is. */
  readonly userMessage: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, userMessage: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${userMessage}`);
    this.name = 'ChannelSendError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}

export function isChannelSendError(error: unknown): error is ChannelSendError {
  return error instanceof ChannelSendError;
}

/**
 * Which channel this organization sends through.
 *
 * **Exactly one ACTIVE channel, or none.** The previous implementation took
 * `findFirst({ status: 'ACTIVE' })` with no ordering, which is fine while every
 * organization has one channel and becomes a coin-flip the moment one has two:
 * the same tenant could resolve to OpenWA on one request and Meta on the next,
 * with no error and no way to notice except customers receiving replies from a
 * number that is not the one they wrote to.
 *
 * Determinism here is an invariant, not an ordering. Ordering would make the
 * choice repeatable while leaving it arbitrary - the tenant still would not have
 * chosen it. Activation is therefore an explicit switch that deactivates the
 * other channel in the same transaction, and finding two ACTIVE rows is treated
 * as corruption and raised, because picking either would be guessing which
 * number a business meant to send from.
 */
async function resolveChannelKind(): Promise<ChannelKind> {
  const channels = await prisma.organizationChannel.findMany({
    select: { id: true, kind: true, status: true },
  });

  const active = channels.filter((channel) => channel.status === 'ACTIVE');

  if (active.length > 1) {
    throw new ChannelSendError(
      'CHANNEL_AMBIGUOUS',
      'مساحة العمل فيها أكثر من قناة مفعّلة، وما بنقدر نحزر من أي رقم لازم تنبعث الرسالة. راجع إعدادات القنوات.',
      { activeKinds: active.map((channel) => channel.kind) },
    );
  }

  if (active.length === 1) return active[0].kind as ChannelKind;

  // No ACTIVE channel, but the organization HAS channels. This is the window
  // the switch could leave open, and it must not present as a generic OpenWA
  // failure ("Active OpenWA channel is not configured") - that sends an agent
  // to debug a gateway that is fine. Named distinctly so the UI can say the
  // channel is between states and the send is worth retrying.
  if (channels.length > 0) {
    throw new ChannelSendError(
      'CHANNEL_NOT_ACTIVE',
      'ما في قناة مفعّلة حالياً لمساحة العمل. إذا كنت عم تبدّل بين القنوات، جرّب بعد لحظة؛ وإلا فعّل قناة من الإعدادات.',
      { channelKinds: channels.map((channel) => channel.kind) },
    );
  }

  // No channel rows at all. Organizations predating OrganizationChannel send
  // through OpenWA off their WhatsappSession, and that must keep working.
  return 'OPENWA';
}

/** Resolve the organization's outbound adapter, cached per tenant scope. */
async function adapter(): Promise<ChannelAdapter> {
  const organizationId = getTenantId();
  const cache = getTenantCache();
  const cacheKey = `channel-adapter:${organizationId}`;
  const cached = cache.get(cacheKey) as ChannelAdapter | undefined;
  if (cached) return cached;

  const kind = await resolveChannelKind();

  let instance: ChannelAdapter;
  switch (kind) {
    case 'OPENWA':
      instance = OpenWASendAdapter;
      break;
    case 'WHATSAPP_CLOUD': {
      const credential = await activeMetaCredential();
      if (!credential) {
        // The channel is ACTIVE but its credential is gone or already marked
        // invalid. Refusing here is the point of marking it: a known-dead token
        // should not be spent on a send that fails and costs quality rating.
        throw new ChannelSendError(
          'CHANNEL_CREDENTIAL_INVALID',
          'بيانات Meta لهالقناة ما عادت صالحة. افتح إعدادات القنوات وأعد ربط الرقم بتوكن جديد.',
        );
      }
      instance = createMetaAdapter(credential);
      break;
    }
    default:
      // A channel kind the code does not implement must fail loudly at the send
      // rather than fall back to OpenWA, which would route one tenant's message
      // through another transport entirely.
      throw new ChannelSendError(
        'CHANNEL_UNSUPPORTED',
        'نوع القناة المستخدم غير مدعوم في هذا الإصدار.',
        { kind },
      );
  }

  cache.set(cacheKey, instance);
  return instance;
}

/** What this organization's channel can do. For UI gating and send-time rules. */
export async function channelCapabilities() {
  return (await adapter()).capabilities;
}

/**
 * Refuse a send the provider would refuse anyway.
 *
 * Only runs for channels that declare a service window, so OpenWA pays nothing
 * for Meta's rule - the branch is on the capability, never on the channel's
 * identity.
 *
 * Refusing locally is not merely faster. The rejection is in Arabic, in the
 * composer, naming when the window closed; Meta's is an English code arriving
 * after the fact. And rejected sends are not free: they depress the number's
 * quality rating, which governs its messaging tier, so letting them through
 * degrades the customer's own number to tell them something already known.
 */
async function assertSendable(address: string, adapterInstance: ChannelAdapter): Promise<void> {
  if (!adapterInstance.capabilities.requiresServiceWindow) return;

  const contactId = await contactIdForAddress(address);
  const window = await serviceWindowFor(contactId);
  if (window.open) return;

  if (!window.lastInboundAt) {
    throw new ChannelSendError(
      'SERVICE_WINDOW_NEVER_OPENED',
      'ما فينا نبعث لهالرقم لأنه ما راسلنا من قبل. على قنوات Meta، لازم الزبون يبعث أول رسالة، وبعدها بيصير فينا نرد خلال ٢٤ ساعة.',
      { requiresServiceWindow: true },
    );
  }

  throw new ChannelSendError(
    'SERVICE_WINDOW_CLOSED',
    'انتهت مهلة الـ٢٤ ساعة للرد على هالزبون، وقناة Meta ما بتسمح بإرسال رسالة جديدة بعدها. لازم الزبون يراسلك من جديد حتى تفتح المهلة.',
    { lastInboundAt: window.lastInboundAt, expiredAt: window.expiresAt },
  );
}

/**
 * Meter, then send, then record.
 *
 * Unchanged from the behaviour it replaces, including the exemption: internal
 * traffic skips both the quota check that would block it and the usage record
 * that would bill for it.
 */
async function meteredSend(
  address: string,
  options: OutboundUsageOptions,
  send: () => Promise<ChannelSendResult>,
): Promise<ChannelSendResult> {
  if (options.internal) return send();

  const { contactId } = await prepareOutboundSend(address, options);
  const result = await send();
  await recordSuccessfulOutboundSend(contactId, result.providerMessageId, options);
  return result;
}

export const ChannelService = {
  sendText: async (
    routingKey: string,
    to: string,
    message: string,
    options: OutboundUsageOptions = {},
  ): Promise<ChannelSendResult> => {
    const instance = await adapter();
    // Window first, quota second. A send the channel will refuse must not
    // consume the tenant's allowance on its way to being refused.
    await assertSendable(to, instance);
    return meteredSend(to, options, () => instance.sendText(routingKey, to, message));
  },

  sendMedia: async (
    routingKey: string,
    to: string,
    url: string,
    caption?: string,
    options: SendMediaOptions = {},
  ): Promise<ChannelSendResult> => {
    const { mediaType, fileName, ...usage } = options;
    const instance = await adapter();
    await assertSendable(to, instance);
    return meteredSend(to, usage, () =>
      instance.sendMedia(routingKey, to, url, caption, { mediaType, fileName }));
  },
};

/**
 * Switch which channel this organization sends through.
 *
 * One transaction, deliberately. The invariant `resolveChannelKind` relies on -
 * at most one ACTIVE channel - is only safe if nothing can observe the moment
 * between deactivating one and activating the other. Postgres at READ COMMITTED
 * shows a concurrent reader either the state before this transaction or the
 * state after it, never the gap, so an in-flight send resolves to exactly one
 * channel throughout. Doing this as two statements outside a transaction would
 * open a real window in which sends fail with "no active channel" for no reason
 * the tenant could understand.
 *
 * A tenant that genuinely has no active channel - Meta connected but never
 * switched to, say - still gets CHANNEL_NOT_ACTIVE from the resolver, which is
 * a different and honest answer: nothing is mid-flight, they simply have not
 * chosen.
 */
export async function setActiveChannelKind(kind: ChannelKind): Promise<void> {
  const organizationId = getTenantId();

  await prisma.$transaction(async (tx) => {
    const target = await tx.organizationChannel.findUnique({
      where: { organizationId_kind: { organizationId, kind } },
      select: { id: true },
    });
    if (!target) {
      throw new ChannelSendError(
        'CHANNEL_NOT_CONNECTED',
        'ما في قناة من هالنوع مربوطة بمساحة العمل، فما فينا نفعّلها.',
        { kind },
      );
    }

    // Meta must not be made the sending channel on a dead token: every send
    // would fail and each failure costs the customer's own quality rating.
    if (kind === 'WHATSAPP_CLOUD') {
      const credential = await tx.metaChannelCredential.findFirst({
        where: { organizationId, channelId: target.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!credential) {
        throw new ChannelSendError(
          'CHANNEL_CREDENTIAL_INVALID',
          'ما فينا نفعّل قناة Meta قبل ما يكون فيها توكن صالح. أعد ربط الرقم أولاً.',
        );
      }
    }

    await tx.organizationChannel.updateMany({
      where: { organizationId, status: 'ACTIVE' },
      data: { status: 'INACTIVE' },
    });
    await tx.organizationChannel.update({
      where: { id: target.id },
      data: { status: 'ACTIVE', connectedAt: new Date() },
    });
  });
}
