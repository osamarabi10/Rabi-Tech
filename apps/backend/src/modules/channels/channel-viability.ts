import { ChannelKind } from './channel.types';

/**
 * Can this platform operate a channel kind *at all*, right now?
 *
 * Distinct from every other channel question in this module, and the distinction
 * is the reason this file exists rather than a field on ChannelCapabilities.
 *
 *  - `ChannelCapabilities` describes a channel that is **connected**: what this
 *    tenant's Meta number may do. It cannot be consulted before a channel
 *    exists, and the question here is asked at signup, when there is no
 *    organization yet, let alone a channel.
 *  - `channelRefusal` in channels.routes.ts asks whether **this subscriber's
 *    edition** permits a kind. That is an entitlement question with a remedy the
 *    customer controls — upgrade.
 *  - This asks whether **RabiTech** can operate the kind for anybody. The
 *    remedy belongs to the platform owner, and no customer action changes it.
 *
 * Conflating the three produces the failure this file was written to close: an
 * edition permitting only WHATSAPP_CLOUD was sellable through a working payment
 * path while META_APP_SECRET was unset, so the webhook rejected every delivery,
 * no inbound message row was ever written, the 24-hour service window could
 * never open, and every outbound send was refused. The customer paid, activated
 * automatically, and landed in a workspace whose only permitted channel could
 * neither send nor receive.
 *
 * **Derived, never a flag.** The block exists because Meta is unconfigured and
 * disappears because Meta is configured. Setting the two secrets restores the
 * affected editions on the next request with no deploy, no migration and nobody
 * having to remember why they were stopped. A manual `isActive: false` fails in
 * both directions — forgotten for months, or reactivated next week by someone
 * who never learned the cause.
 */

export type ChannelOperability = {
  kind: ChannelKind;
  operable: boolean;
  /**
   * Why not, in English, for the owner console and the logs. Null when operable.
   * Customer-facing Arabic copy is composed at the edge from `reasonCode`, never
   * from this string.
   */
  reason: string | null;
  /** Stable machine code, so a UI can branch without parsing prose. */
  reasonCode: 'CHANNEL_SECRETS_MISSING' | null;
};

/**
 * Platform configuration each kind needs before it can carry a message.
 *
 * CHANNEL_ENCRYPTION_KEY is shared by every kind: each stores a credential
 * encrypted under it - OpenWA its API key, Meta its access token - so without
 * it no channel of any kind can be connected.
 *
 * WHATSAPP_CLOUD's two are about **RabiTech's own Meta app**, not any tenant's
 * token: one app receives every tenant's webhooks, so an unset META_APP_SECRET
 * breaks inbound for all of them at once. The tenant's phoneNumberId, wabaId
 * and accessToken are per-subscriber and deliberately not consulted here - a
 * subscriber who has not connected yet is a normal state, not an outage.
 */
const REQUIRED_ENV: Record<ChannelKind, string[]> = {
  // Nothing platform-level beyond the vault: an OpenWA gateway is provisioned
  // per tenant with its own base URL and API key.
  OPENWA: ['CHANNEL_ENCRYPTION_KEY'],
  WHATSAPP_CLOUD: ['CHANNEL_ENCRYPTION_KEY', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'],
};

/**
 * Presence only, and deliberately not `secretProblems()`.
 *
 * Reusing that was tried first and rejected on evidence. It answers "are this
 * deployment's secrets safe", which is a wider question than "can this channel
 * carry a message", and the difference is not academic: it also flags a weak
 * OPENWA_API_KEY, and wiring it in here withdrew **every** edition from sale on
 * a development machine - FREE and STANDARD included - because a gateway key
 * was still `dev-admin-key`. Withdrawing the whole product catalogue over a
 * password-strength warning is a worse failure than the one being fixed.
 *
 * So the two notions stay apart, each where it already belongs. Secret
 * *strength* is enforced at boot by verifySecrets() and at credential-write
 * time by vaultLocked(); secret *presence* for a specific channel is enforced
 * here. Neither is a second copy of the other.
 */
export function channelOperability(kind: ChannelKind): ChannelOperability {
  const missing = REQUIRED_ENV[kind].filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return {
      kind,
      operable: false,
      reason: `Not configured on this platform: ${missing.join(', ')} unset`,
      reasonCode: 'CHANNEL_SECRETS_MISSING',
    };
  }
  return { kind, operable: true, reason: null, reasonCode: null };
}

/**
 * May this edition be sold right now?
 *
 * Offerable when the platform can operate **at least one** of the channels the
 * edition permits. One is the right threshold rather than all: an edition
 * granting both OpenWA and Meta is entirely usable while Meta is down, and
 * withdrawing it would refuse a sale the platform can honour.
 *
 * An edition permitting **no** channels is unofferable and says so. That is not
 * a hypothetical — it is what the owner console produces by unticking every
 * channel, and selling a workspace that can never carry a message is the same
 * defect this module exists to prevent, arrived at by a different route.
 */
export function editionOfferability(allowedChannels: readonly string[]): {
  offerable: boolean;
  reason: string | null;
  reasonCode: ChannelOperability['reasonCode'] | 'NO_CHANNELS_PERMITTED' | null;
} {
  if (allowedChannels.length === 0) {
    return {
      offerable: false,
      reason: 'This edition permits no channels, so a workspace on it could never send or receive.',
      reasonCode: 'NO_CHANNELS_PERMITTED',
    };
  }

  const verdicts = allowedChannels.map((kind) => channelOperability(kind as ChannelKind));
  if (verdicts.some((verdict) => verdict.operable)) {
    return { offerable: true, reason: null, reasonCode: null };
  }

  // Every permitted channel is down. Report the first, which is the one a
  // single-channel edition is actually blocked on.
  const blocking = verdicts[0];
  return {
    offerable: false,
    reason: blocking.reason,
    reasonCode: blocking.reasonCode,
  };
}
