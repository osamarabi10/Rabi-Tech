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
 * The gateway a number sends through.
 *
 * **An outbound message leaves through the gateway of the session its
 * conversation belongs to.** Not a default, not the organization's channel, not
 * a resolution step that can return more than one answer.
 *
 * ## What this replaced, and why the replacement is smaller
 *
 * This used to ask the organization: read every channel row, keep the ACTIVE
 * ones, and raise CHANNEL_AMBIGUOUS if there were two — because with two ACTIVE
 * channels there was genuinely no way to know which of a business's numbers a
 * reply should leave from, and guessing would send a customer an answer from a
 * number they have never seen. That is unrecoverable and reads as a scam.
 *
 * The invariant that made the guess safe — at most one ACTIVE channel per
 * organization — was also the invariant that made a Growth subscriber unable to
 * run OpenWA on one number and Meta's Cloud API on another. Both are gone. The
 * binding now lives on WhatsappSession, so there is nothing left to
 * disambiguate: **ambiguity is impossible by construction rather than caught.**
 *
 * ## No fallback, deliberately
 *
 * A session with no channel raises. It does not fall back to the
 * organization's channel, to OpenWA, or to the first row found — every one of
 * those is the mistake this design exists to prevent, and the differential
 * proof for this commit mutates exactly that fallback back in to watch the
 * assertion go red.
 *
 * The routing key is the session *name*, which is what all sixteen send call
 * sites already pass. Nothing about their signatures changed; the information
 * needed to route per number was always at the call site and was being
 * discarded here.
 */
async function channelForSession(routingKey: string): Promise<{ id: string; kind: ChannelKind }> {
  const organizationId = getTenantId();
  const session = await prisma.whatsappSession.findUnique({
    where: { organizationId_sessionName: { organizationId, sessionName: routingKey } },
    select: { channel: { select: { id: true, kind: true, status: true } } },
  });

  if (!session) {
    throw new ChannelSendError(
      'SESSION_UNKNOWN',
      'ما لقينا الرقم اللي المفروض تنبعت منه هالرسالة. حدّث الصفحة، وإذا ضلّت المشكلة راجع إعدادات القنوات.',
      { routingKey },
    );
  }

  if (!session.channel) {
    /*
      A number with no gateway. Legacy rows only: the backfill in
      20261017090000_session_channel_binding left null exactly where an
      organization had no channel to bind to, and every creation path since
      sets it — check:session-channel fails on a new one.

      Named distinctly rather than reported as a gateway fault, because the
      remedy is a person choosing a gateway for this number, not anybody
      debugging a container that is fine.
    */
    throw new ChannelSendError(
      'SESSION_NOT_BOUND',
      'هالرقم مش مربوط بأي بوابة إرسال، وما منخمّن من أي بوابة تنبعت الرسالة. افتح إعدادات القنوات واختار بوابة لهالرقم.',
      { routingKey },
    );
  }

  if (session.channel.status !== 'ACTIVE') {
    /*
      The number has a gateway and the gateway is switched off.

      This error survived the move from organization-level routing, and it had
      to: the alternative is what happens without it — OpenWA's transport
      throws "Active OpenWA channel is not configured", which sends an agent to
      debug a gateway that is fine when the real answer is that this number's
      channel is disabled. Same distinction as before, now asked about one
      number instead of the whole organization.
    */
    throw new ChannelSendError(
      'CHANNEL_NOT_ACTIVE',
      'البوابة المربوطة بهالرقم مش مفعّلة حالياً. إذا كنت عم تعدّل إعدادات القنوات جرّب بعد لحظة، وإلا فعّل البوابة من الإعدادات.',
      { routingKey, kind: session.channel.kind },
    );
  }

  return { id: session.channel.id, kind: session.channel.kind as ChannelKind };
}

/**
 * Resolve a *number's* outbound adapter, cached per channel within the tenant
 * scope.
 *
 * Keyed by channel id rather than by organization, which is the whole point: an
 * organization with two channels now has two adapters, and one entry per tenant
 * would hand a Meta number the OpenWA adapter for the rest of the request. Two
 * numbers on the same channel still share one entry.
 */
async function adapter(routingKey: string): Promise<ChannelAdapter> {
  const channel = await channelForSession(routingKey);
  const cache = getTenantCache();
  const cacheKey = `channel-adapter:${channel.id}`;
  const cached = cache.get(cacheKey) as ChannelAdapter | undefined;
  if (cached) return cached;

  const kind = channel.kind;

  let instance: ChannelAdapter;
  switch (kind) {
    case 'OPENWA':
      instance = OpenWASendAdapter;
      break;
    case 'WHATSAPP_CLOUD': {
      // Scoped to this session's channel, not to the organization. Equivalent
      // today, because OrganizationChannel is unique on (organizationId, kind)
      // and there is therefore one Meta channel at most — but correct by
      // construction rather than by a uniqueness constraint somewhere else.
      const credential = await activeMetaCredential(channel.id);
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

/**
 * What a given number's channel can do. For UI gating and send-time rules.
 *
 * Takes the session, because capabilities are the channel's and the channel is
 * the number's. An organization-level answer would have to pick one of a Growth
 * subscriber's channels and would be wrong about the others — telling a
 * composer there is no service window on a Meta number, say, which is how a
 * send gets refused by Meta after the agent was told it was fine.
 */
export async function channelCapabilities(routingKey: string) {
  return (await adapter(routingKey)).capabilities;
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
    const instance = await adapter(routingKey);
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
    const instance = await adapter(routingKey);
    await assertSendable(to, instance);
    return meteredSend(to, usage, () =>
      instance.sendMedia(routingKey, to, url, caption, { mediaType, fileName }));
  },
};
