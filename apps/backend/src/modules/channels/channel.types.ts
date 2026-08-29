import { OutboundUsageOptions } from '../usage/entitlements';

/**
 * What a channel can and cannot do.
 *
 * This exists so the UI never branches on channel *type*. A composer asking
 * "is this WHATSAPP_CLOUD?" has to be edited every time a channel is added, and
 * in the meantime it either forbids something OpenWA allows or permits
 * something Meta will reject. Asking "does this channel require a service
 * window?" is a question about the rule, and a new channel answers it by
 * existing rather than by being special-cased.
 *
 * Every field here is a capability, never an identity. If a consumer needs to
 * know which channel it is talking to in order to decide behaviour, the missing
 * capability belongs in this type instead.
 */
export type ChannelCapabilities = {
  kind: ChannelKind;

  /**
   * Meta only permits free-form messages within 24 hours of the customer's last
   * message; outside it, only approved templates. OpenWA has no such rule.
   * False here means "send whatever, whenever", which is why this is stated as
   * a requirement rather than assumed absent.
   */
  requiresServiceWindow: boolean;

  /** Pre-approved message templates, the only thing sendable outside the window. */
  supportsTemplates: boolean;

  /** A human scans a QR code to connect. True for OpenWA, false for Meta. */
  supportsQrPairing: boolean;

  /**
   * Business-initiated recipients per rolling 24 hours, or null for no
   * platform-imposed ceiling. Meta caps unverified businesses at 250; OpenWA
   * has no tier, only the pacing that keeps a number from being banned.
   */
  maxUniqueRecipientsPer24h: number | null;
};

export type ChannelKind = 'OPENWA' | 'WHATSAPP_CLOUD';

/**
 * The result of a send, normalised across channels.
 *
 * `providerMessageId` matters more than it looks: delivery and read acks arrive
 * later keyed by it, so a send that cannot report its own id produces a message
 * whose status can never advance past SENT.
 */
export type ChannelSendResult = {
  providerMessageId: string | null;
  /** The provider's raw response, for callers that still need channel detail. */
  raw: unknown;
};

export type SendMediaOptions = OutboundUsageOptions & {
  mediaType?: string | null;
  fileName?: string | null;
};

/**
 * One outbound messaging channel for one organization.
 *
 * Deliberately small. Gateway management - QR pairing, session lifecycle,
 * webhook reconciliation, media fetch - is NOT here, because those are OpenWA
 * concepts with no Meta equivalent, and inventing shared names for them would
 * produce an interface half of whose methods throw on half of its
 * implementations. Those stay on the channel-specific service that owns them.
 *
 * `routingKey` is whatever identifies the sending identity to the provider: an
 * OpenWA session name today, a Meta phone number ID later. Callers pass through
 * what the conversation already carries; only the adapter interprets it.
 */
export interface ChannelAdapter {
  readonly capabilities: ChannelCapabilities;

  sendText(
    routingKey: string,
    to: string,
    message: string,
  ): Promise<ChannelSendResult>;

  sendMedia(
    routingKey: string,
    to: string,
    url: string,
    caption: string | undefined,
    options: { mediaType?: string | null; fileName?: string | null },
  ): Promise<ChannelSendResult>;
}
