import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { ChannelAdapter, ChannelCapabilities, ChannelSendResult } from './channel.types';
import { MetaApiError, sendMediaMessage, sendTextMessage } from './meta.client';
import { markMetaCredentialInvalid } from './meta.service';

/**
 * Meta Cloud API as an implementation of the shared send interface.
 *
 * **Per organization, unlike OpenWA's singleton.** OpenWA's adapter is one
 * frozen object because every organization's OpenWA channel behaves
 * identically. Meta's does not: the phone number id, the token, and the
 * messaging tier all belong to the customer's own account, and the tier moves
 * over time. An adapter shared between tenants would either have to look those
 * up on every call or report one tenant's standing to another.
 */

/** Meta's tier names, as a recipient ceiling. Null means the tier is unknown. */
function ceilingForTier(tier: string | null): number | null {
  switch (String(tier || '').toUpperCase()) {
    case 'TIER_50': return 50;
    case 'TIER_250': return 250;
    case 'TIER_1K': return 1000;
    case 'TIER_10K': return 10000;
    case 'TIER_100K': return 100000;
    case 'TIER_UNLIMITED': return null;
    default: return null;
  }
}

export type MetaAdapterCredential = {
  id: string;
  phoneNumberId: string;
  accessToken: string;
  messagingTier: string | null;
  qualityRating: string | null;
};

export function createMetaAdapter(credential: MetaAdapterCredential): ChannelAdapter {
  const capabilities: ChannelCapabilities = {
    kind: 'WHATSAPP_CLOUD',

    // The 24-hour customer service window. Enforced in ChannelService before
    // the call, not discovered from Meta's rejection - see service-window.ts.
    requiresServiceWindow: true,

    // Meta supports approved templates; this product does not manage them yet.
    // False therefore describes THIS CHANNEL as integrated, not Meta as a
    // provider, which is the honest answer to "can a caller send a template".
    supportsTemplates: false,

    // Nobody scans anything; the customer pastes credentials.
    supportsQrPairing: false,

    // Reported for display. Not enforced numerically, because with no template
    // support every out-of-window send is already refused, so no
    // business-initiated conversation can start and the ceiling is unreachable.
    // Enforcement lands with template support - the step that first makes those
    // sends possible.
    maxUniqueRecipientsPer24h: ceilingForTier(credential.messagingTier),

    // The material limitation of this channel, stated as a fact a caller can
    // read rather than a rule they have to know. See channel.types.ts.
    canInitiateConversations: false,

    messagingTier: credential.messagingTier,
    qualityRating: credential.qualityRating,
  };

  /**
   * Every send funnels through here so one dead token degrades the channel
   * once, rather than failing message by message with nothing recorded.
   */
  async function guarded<T>(send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (error instanceof MetaApiError && error.isAuthFailure) {
        // The token is gone: expired, revoked, or its System User deleted.
        // Recorded once, in words the admin is shown, so this surfaces as a
        // degraded channel instead of messages quietly not arriving.
        await markMetaCredentialInvalid(
          credential.id,
          'التوكن لم يعد صالحاً — انتهت صلاحيته أو تم سحبه من Meta. أعد ربط القناة بتوكن جديد.',
        ).catch((markError) => {
          // Never let bookkeeping replace the real failure the caller needs.
          logger.error('Could not mark Meta credential invalid', {
            organizationId: getTenantId(),
            error: markError instanceof Error ? markError.message : String(markError),
          });
        });
      }
      throw error;
    }
  }

  return {
    capabilities,

    async sendText(_routingKey, to, message): Promise<ChannelSendResult> {
      // routingKey is ignored on purpose. It identifies an OpenWA session; the
      // Meta equivalent is the phone number id, which belongs to the credential
      // this adapter was built from, not to whatever the conversation stored.
      const raw = await guarded(() =>
        sendTextMessage(credential.phoneNumberId, credential.accessToken, to, message));
      return { providerMessageId: raw.messages?.[0]?.id ?? null, raw };
    },

    async sendMedia(_routingKey, to, url, caption, options): Promise<ChannelSendResult> {
      const raw = await guarded(() =>
        sendMediaMessage(credential.phoneNumberId, credential.accessToken, to, url, caption, options));
      return { providerMessageId: raw.messages?.[0]?.id ?? null, raw };
    },
  };
}
