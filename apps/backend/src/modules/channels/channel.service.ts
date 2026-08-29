import { getTenantCache, getTenantId } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  OutboundUsageOptions,
  prepareOutboundSend,
  recordSuccessfulOutboundSend,
} from '../usage/entitlements';
import { OpenWASendAdapter } from '../whatsapp/openwa.adapter';
import { ChannelAdapter, ChannelKind, ChannelSendResult, SendMediaOptions } from './channel.types';

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

/** Resolve the organization's outbound adapter, cached per tenant request. */
async function adapter(): Promise<ChannelAdapter> {
  const organizationId = getTenantId();
  const cache = getTenantCache();
  const cacheKey = `channel-adapter:${organizationId}`;
  const cached = cache.get(cacheKey) as ChannelAdapter | undefined;
  if (cached) return cached;

  // Today every organization is OPENWA. The lookup exists so that stops being
  // an assumption baked into ten call sites and becomes one row to read.
  const channel = await prisma.organizationChannel.findFirst({
    where: { organizationId, status: 'ACTIVE' },
    select: { kind: true },
  });
  const kind = (channel?.kind || 'OPENWA') as ChannelKind;

  let instance: ChannelAdapter;
  switch (kind) {
    case 'OPENWA':
      instance = OpenWASendAdapter;
      break;
    default:
      // A channel kind the code does not implement must fail loudly at the send
      // rather than fall back to OpenWA, which would route one tenant's message
      // through another transport entirely.
      throw new Error(`No send adapter for channel kind "${kind}"`);
  }

  cache.set(cacheKey, instance);
  return instance;
}

/** What this organization's channel can do. For UI gating and send-time rules. */
export async function channelCapabilities() {
  return (await adapter()).capabilities;
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
  ): Promise<ChannelSendResult> =>
    meteredSend(to, options, async () => (await adapter()).sendText(routingKey, to, message)),

  sendMedia: async (
    routingKey: string,
    to: string,
    url: string,
    caption?: string,
    options: SendMediaOptions = {},
  ): Promise<ChannelSendResult> => {
    const { mediaType, fileName, ...usage } = options;
    return meteredSend(to, usage, async () =>
      (await adapter()).sendMedia(routingKey, to, url, caption, { mediaType, fileName }));
  },
};
