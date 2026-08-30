import { ChannelAdapter, ChannelSendResult } from '../channels/channel.types';
import { OpenWARawSend, responseMessageId } from './openwa.service';

/**
 * OpenWA as one implementation of the shared send interface.
 *
 * A thin wrapper on purpose. The transport logic already existed and worked;
 * moving it would have made a behaviour-preserving refactor into a rewrite, and
 * the whole point of extracting the interface separately was to be able to
 * prove nothing changed. All this does is normalise the response shape and
 * declare what OpenWA can do.
 */

const capabilities = {
  kind: 'OPENWA' as const,

  // OpenWA drives WhatsApp Web as a logged-in user, so there is no service
  // window and no template approval - the account may message anyone at any
  // time. That freedom is also why it can be banned for volume, which is what
  // the campaign pacing in the edition catalogue is defending against.
  requiresServiceWindow: false,
  supportsTemplates: false,

  // A person scans a QR code, and the session can drop and need re-pairing.
  supportsQrPairing: true,

  // No provider-imposed recipient ceiling. Pacing is a plan limit, not a
  // transport limit, so it is not represented here.
  maxUniqueRecipientsPer24h: null,

  // No window and no template gate, so this channel can open a conversation
  // with anyone. This is the capability a composer or campaign should read;
  // asking "is this OpenWA?" gets the right answer today and the wrong one the
  // moment a third channel exists.
  canInitiateConversations: true,

  // OpenWA has no provider standing to report - there is no tier and no quality
  // rating behind WhatsApp Web. Null means "this provider does not have one",
  // which is why these are nullable rather than defaulted to a flattering value.
  messagingTier: null,
  qualityRating: null,
};

export const OpenWASendAdapter: ChannelAdapter = {
  capabilities,

  async sendText(routingKey, to, message): Promise<ChannelSendResult> {
    const raw = await OpenWARawSend.sendText(routingKey, to, message);
    return { providerMessageId: responseMessageId(raw), raw };
  },

  async sendMedia(routingKey, to, url, caption, options): Promise<ChannelSendResult> {
    const raw = await OpenWARawSend.sendMedia(routingKey, to, url, caption, options);
    return { providerMessageId: responseMessageId(raw), raw };
  },
};
