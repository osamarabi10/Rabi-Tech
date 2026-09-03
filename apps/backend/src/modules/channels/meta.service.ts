import { currentWorkspaceId } from '../../lib/current-workspace';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { decryptCredential, encryptCredential } from '../../lib/credential-crypto';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { secretProblems } from '../../lib/verify-secrets';
import { prisma } from '../../prisma';
import {
  META_GRAPH_VERSION,
  MetaApiError,
  fetchPhoneNumber,
  fetchPhoneNumberStanding,
  fetchWabaPhoneNumbers,
  subscribeApp,
} from './meta.client';

/**
 * Connecting a Meta WhatsApp Cloud API channel.
 *
 * Bring-your-own-token: the customer supplies their own Phone Number ID, WABA
 * ID and System User access token, and this validates all three before storing
 * anything.
 *
 * **Why four checks and not one.** A single "does the token work" call would
 * pass for a token that can read a phone number but cannot manage its WABA, and
 * would pass without ever subscribing the app — leaving a channel that sends
 * perfectly and receives nothing. Each check below fails for a different reason
 * an admin can actually act on, which is why each carries its own message
 * rather than a shared "connection failed".
 *
 * The order is not arbitrary. Each step narrows what the next failure can mean:
 * once the phone number resolves, a WABA failure is about the WABA and not the
 * token; once the WABA resolves, a subscription failure is about the app.
 */

/** The key that seals credentials written today. See MetaChannelCredential.keyVersion. */
export const CURRENT_KEY_VERSION = 1;

export type MetaConnectStep = 'PHONE_NUMBER' | 'WABA_ACCESS' | 'SUBSCRIBE' | 'STANDING';

export type MetaConnectProblem = {
  step: MetaConnectStep;
  /** Stable machine code. The Arabic message is for humans; this is for code. */
  code: string;
  /** Shown to the admin as-is, in Arabic, matching the rest of the API. */
  message: string;
};

/**
 * Every failure this flow can produce, in one place.
 *
 * Each says what went wrong *and* what to do about it, because every one of
 * these is a configuration mistake made in a different console than this one.
 * "Invalid credentials" would be true of all four and useful for none.
 */
const PROBLEMS = {
  VAULT_LOCKED: {
    step: 'PHONE_NUMBER' as const,
    code: 'META_VAULT_LOCKED',
    message:
      'لا يمكن حفظ بيانات Meta بينما المنصة تعمل بأسرار غير آمنة. راجع مسؤول المنصة قبل ربط القناة.',
  },
  MISSING_FIELDS: {
    step: 'PHONE_NUMBER' as const,
    code: 'META_MISSING_FIELDS',
    message: 'الحقول الثلاثة مطلوبة: معرّف رقم الهاتف، ومعرّف حساب واتساب للأعمال، والتوكن.',
  },
  PHONE_NUMBER_INVALID: {
    step: 'PHONE_NUMBER' as const,
    code: 'META_PHONE_NUMBER_INVALID',
    message:
      'معرّف رقم الهاتف (Phone Number ID) غير صحيح، أو التوكن لا يملك صلاحية الوصول إليه. '
      + 'انسخ المعرّف من إعدادات WhatsApp في حساب Meta للأعمال — وهو رقم طويل، وليس رقم الهاتف نفسه.',
  },
  WABA_ACCESS_DENIED: {
    step: 'WABA_ACCESS' as const,
    code: 'META_WABA_ACCESS_DENIED',
    message:
      'التوكن لا يملك صلاحية الإدارة على حساب واتساب للأعمال (WABA) المُدخل. '
      + 'تأكد أن مستخدم النظام (System User) مضاف إلى الحساب وله صلاحية whatsapp_business_management.',
  },
  WABA_PHONE_MISMATCH: {
    step: 'WABA_ACCESS' as const,
    code: 'META_WABA_PHONE_MISMATCH',
    message:
      'رقم الهاتف لا يتبع حساب واتساب للأعمال المُدخل. '
      + 'المعرّفان مأخوذان من حسابين مختلفين — تأكد أنهما من نفس الحساب.',
  },
  SUBSCRIBE_FAILED: {
    step: 'SUBSCRIBE' as const,
    code: 'META_SUBSCRIBE_FAILED',
    message:
      'لم ننجح في ربط الويبهوك بحساب واتساب للأعمال. '
      + 'بدون هذه الخطوة يمكنك الإرسال، لكن لن تصلك أي رسالة واردة — لذلك لم نحفظ الربط.',
  },
  SUBSCRIBE_REFUSED: {
    step: 'SUBSCRIBE' as const,
    code: 'META_SUBSCRIBE_REFUSED',
    message:
      'رفضت Meta ربط الويبهوك دون بيان السبب. أعد المحاولة، '
      + 'وإن تكرر تأكد أن تطبيق المنصة مضاف إلى حساب واتساب للأعمال.',
  },
  NUMBER_ALREADY_CLAIMED: {
    step: 'PHONE_NUMBER' as const,
    code: 'META_NUMBER_ALREADY_CLAIMED',
    message:
      'هذا الرقم مرتبط مسبقاً بمساحة عمل أخرى على المنصة. '
      + 'لا يمكن ربط الرقم نفسه بأكثر من مساحة عمل، لأن الرسائل الواردة لن تعرف لمن تذهب.',
  },
  STANDING_UNAVAILABLE: {
    step: 'STANDING' as const,
    code: 'META_STANDING_UNAVAILABLE',
    message:
      'تم الربط بنجاح، لكن لم نتمكن من قراءة مستوى الإرسال وجودة الرقم. '
      + 'القناة تعمل، والقيم ستظهر عند أول تحديث ناجح.',
  },
} satisfies Record<string, MetaConnectProblem>;

export type MetaChannelStatus = {
  connected: boolean;
  status: string;
  phoneNumberId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
  lastValidatedAt: Date | null;
  invalidReason: string | null;
  graphVersion: string;
  /**
   * Is this the channel the workspace currently sends through?
   *
   * Returned as its own fact so the UI never has to compare channel kinds to
   * find out. A component asking `capabilities.kind === 'WHATSAPP_CLOUD'`
   * is the exact pattern the capability descriptor exists to prevent, and it
   * is asserted against by the isolation gate.
   */
  isActiveChannel: boolean;
};

export type MetaConnectOutcome =
  | { ok: true; warning: MetaConnectProblem | null; channel: MetaChannelStatus }
  | { ok: false; problem: MetaConnectProblem };

/**
 * The hard gate.
 *
 * A weak platform secret is survivable while the only thing at risk is this
 * platform's own data. It stops being survivable the moment the database holds
 * another business's System User token, because that token sends *as* them to
 * their own customers. This refuses to write the first real credential until
 * the configuration is sound.
 *
 * Note it does not honour ALLOW_INSECURE_SECRETS. That flag exists so a
 * half-finished credential rotation cannot take the whole platform down — it is
 * permission to keep serving, not permission to start storing other people's
 * secrets.
 */
function vaultLocked(): boolean {
  return secretProblems().length > 0;
}

function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Validate and store a Meta Cloud API channel for the current organization.
 *
 * Nothing is written unless steps 1-3 all pass. Step 4 is deliberately
 * non-fatal — see the comment at that step.
 */
export async function connectMetaChannel(input: {
  phoneNumberId: unknown;
  wabaId: unknown;
  businessPortfolioId?: unknown;
  accessToken: unknown;
}): Promise<MetaConnectOutcome> {
  if (vaultLocked()) return { ok: false, problem: PROBLEMS.VAULT_LOCKED };

  const phoneNumberId = normalizeId(input.phoneNumberId);
  const wabaId = normalizeId(input.wabaId);
  const businessPortfolioId = normalizeId(input.businessPortfolioId);
  const accessToken = String(input.accessToken ?? '').trim();
  if (!phoneNumberId || !wabaId || !accessToken) {
    return { ok: false, problem: PROBLEMS.MISSING_FIELDS };
  }

  const organizationId = getTenantId();

  // ---------------------------------------------------------------- 1 of 4
  // Does the phone number id resolve, and can this token see it? This is first
  // because it is the field most often wrong: the Meta console shows the
  // display number and the Phone Number ID side by side, and the number is the
  // one that looks like a phone number.
  let phone;
  try {
    phone = await fetchPhoneNumber(phoneNumberId, accessToken);
  } catch (error) {
    logger.warn('Meta connect: phone number check failed', {
      organizationId,
      phoneNumberId,
      metaCode: error instanceof MetaApiError ? error.code : null,
    });
    return { ok: false, problem: PROBLEMS.PHONE_NUMBER_INVALID };
  }

  // ---------------------------------------------------------------- 2 of 4
  // Can this token manage the WABA, and does the number actually belong to it?
  // One call answers both. The ownership half is the one worth having: a token
  // may legitimately see a number that lives under a different WABA, and
  // subscribing the wrong WABA succeeds while routing nothing.
  let wabaNumbers;
  try {
    wabaNumbers = await fetchWabaPhoneNumbers(wabaId, accessToken);
  } catch (error) {
    logger.warn('Meta connect: WABA access check failed', {
      organizationId,
      wabaId,
      metaCode: error instanceof MetaApiError ? error.code : null,
    });
    return { ok: false, problem: PROBLEMS.WABA_ACCESS_DENIED };
  }
  if (!wabaNumbers.some((row) => row.id === phoneNumberId)) {
    return { ok: false, problem: PROBLEMS.WABA_PHONE_MISMATCH };
  }

  // ---------------------------------------------------------------- 3 of 4
  // Subscribe the app to this WABA's webhooks.
  //
  // THIS is the step that makes the channel work. A valid token routes nothing
  // on its own: without an active subscription Meta has nowhere to deliver, so
  // the channel sends fine and never receives — which the business experiences
  // as customers being ignored, and which looks like a working connection from
  // every screen in this product. A failure here therefore aborts the whole
  // connection rather than being stored as a degraded state.
  try {
    const subscription = await subscribeApp(wabaId, accessToken);
    if (!subscription.success) {
      return { ok: false, problem: PROBLEMS.SUBSCRIBE_REFUSED };
    }
  } catch (error) {
    logger.warn('Meta connect: subscribed_apps failed', {
      organizationId,
      wabaId,
      metaCode: error instanceof MetaApiError ? error.code : null,
    });
    return { ok: false, problem: PROBLEMS.SUBSCRIBE_FAILED };
  }

  // ---------------------------------------------------------------- 4 of 4
  // Messaging tier and quality rating.
  //
  // Non-fatal, deliberately. By this point the token has proven it can read the
  // number, manage the WABA and subscribe the app — the channel demonstrably
  // works. These two fields are display values that drive a warning banner, and
  // refusing a working connection because a banner has nothing to show would be
  // choosing the label over the thing. The failure is still reported, and the
  // fields stay null until a later refresh fills them.
  let standing = null;
  let warning: MetaConnectProblem | null = null;
  try {
    standing = await fetchPhoneNumberStanding(phoneNumberId, accessToken);
  } catch (error) {
    logger.warn('Meta connect: tier/quality unavailable', {
      organizationId,
      phoneNumberId,
      metaCode: error instanceof MetaApiError ? error.code : null,
    });
    warning = PROBLEMS.STANDING_UNAVAILABLE;
  }

  try {
    const channel = await persist({
      organizationId,
      phoneNumberId,
      wabaId,
      businessPortfolioId: businessPortfolioId || null,
      accessToken,
      displayPhoneNumber: standing?.display_phone_number || phone.display_phone_number || null,
      verifiedName: standing?.verified_name || phone.verified_name || null,
      qualityRating: standing?.quality_rating || null,
      messagingTier: standing?.messaging_limit_tier || null,
    });
    return { ok: true, warning, channel };
  } catch (error) {
    // The globally-unique phoneNumberId did its job: another organization has
    // already claimed this number. This is the constraint that stops one
    // business's conversations being delivered into another's inbox, so the
    // refusal is correct and the message says why rather than reporting a fault.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { ok: false, problem: PROBLEMS.NUMBER_ALREADY_CLAIMED };
    }
    throw error;
  }
}

async function persist(input: {
  organizationId: string;
  phoneNumberId: string;
  wabaId: string;
  businessPortfolioId: string | null;
  accessToken: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
}): Promise<MetaChannelStatus> {
  const accessTokenEnc = encryptCredential(input.accessToken);

  return prisma.$transaction(async (tx) => {
    // The channel row the credential hangs from.
    //
    // status stays PENDING, not ACTIVE, and that is not an oversight. The
    // outbound adapter for WHATSAPP_CLOUD does not exist yet, and
    // ChannelService picks the organization's ACTIVE channel — so activating
    // this row would make an org that has both channels resolve to whichever
    // came back first, and start throwing on sends that work today. Activation
    // belongs to the step that builds the send path.
    const channel = await tx.organizationChannel.upsert({
      where: { organizationId_kind: { organizationId: input.organizationId, kind: 'WHATSAPP_CLOUD' } },
      create: {
        organizationId: input.organizationId,
        kind: 'WHATSAPP_CLOUD',
        status: 'PENDING',
        // The Graph base this channel was connected against. Recording the
        // version here means a later version bump can tell which channels were
        // validated under the old one.
        baseUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}`,
        // Meta channels keep no key here — the token lives in the vault, and
        // duplicating a secret gives it two places to leak from and two places
        // to forget to rotate. Empty is the existing convention for a channel
        // with no gateway key (see billing.service and platform.routes).
        apiKeyEnc: '',
        // Unused by the Meta webhook, which authenticates with
        // X-Hub-Signature-256 rather than a path token. The column is globally
        // unique and required, so it gets a real random value rather than a
        // constant that would collide on the second organization.
        webhookToken: crypto.randomBytes(24).toString('base64url'),
      },
      update: { baseUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}` },
    });

    const credential = await tx.metaChannelCredential.upsert({
      where: {
        channelId_organizationId: { channelId: channel.id, organizationId: input.organizationId },
      },
      create: {
        organizationId: input.organizationId,
        channelId: channel.id,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        businessPortfolioId: input.businessPortfolioId,
        accessTokenEnc,
        keyVersion: CURRENT_KEY_VERSION,
        status: 'ACTIVE',
        invalidReason: null,
        lastValidatedAt: new Date(),
        displayPhoneNumber: input.displayPhoneNumber,
        verifiedName: input.verifiedName,
        qualityRating: input.qualityRating,
        messagingTier: input.messagingTier,
      },
      update: {
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        businessPortfolioId: input.businessPortfolioId,
        accessTokenEnc,
        keyVersion: CURRENT_KEY_VERSION,
        status: 'ACTIVE',
        invalidReason: null,
        lastValidatedAt: new Date(),
        displayPhoneNumber: input.displayPhoneNumber,
        verifiedName: input.verifiedName,
        qualityRating: input.qualityRating,
        messagingTier: input.messagingTier,
      },
    });

    // The session row inbound conversations attach to.
    //
    // Created here rather than on first message because Conversation.sessionId
    // is required: without it the very first customer message would arrive with
    // nowhere to put it, and the failure would land in a background worker
    // rather than in front of the admin who just connected the channel.
    await tx.whatsappSession.upsert({
      where: {
        organizationId_sessionName: {
          organizationId: input.organizationId,
          sessionName: metaSessionName(input.phoneNumberId),
        },
      },
      create: {
        workspaceId: await currentWorkspaceId(),
        organizationId: input.organizationId,
        sessionName: metaSessionName(input.phoneNumberId),
        phoneNumber: input.displayPhoneNumber,
        label: input.verifiedName || 'WhatsApp Cloud API',
      },
      // Meta may have changed the display number or verified name since the
      // last connect; the session name is derived from the phone number id and
      // never moves.
      update: {
        phoneNumber: input.displayPhoneNumber,
        label: input.verifiedName || 'WhatsApp Cloud API',
      },
    });

    // Freshly connected channels are PENDING, never the sending channel, until
    // the admin switches to them - see setActiveChannelKind.
    return present(credential, channel.status === 'ACTIVE');
  });
}

function present(row: {
  status: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
  lastValidatedAt: Date | null;
  invalidReason: string | null;
}, isActiveChannel: boolean): MetaChannelStatus {
  return {
    connected: row.status === 'ACTIVE',
    status: row.status,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    qualityRating: row.qualityRating,
    messagingTier: row.messagingTier,
    lastValidatedAt: row.lastValidatedAt,
    invalidReason: row.invalidReason,
    graphVersion: META_GRAPH_VERSION,
    isActiveChannel,
  };
}

/** The organization's Meta channel, or null. Never returns the access token. */
export async function getMetaChannel(): Promise<MetaChannelStatus | null> {
  const row = await prisma.metaChannelCredential.findFirst({
    // Explicitly enumerated rather than selecting the row: a `select` that lists
    // its fields cannot start returning accessTokenEnc because someone added a
    // spread somewhere upstream.
    select: {
      status: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      verifiedName: true,
      qualityRating: true,
      messagingTier: true,
      lastValidatedAt: true,
      invalidReason: true,
      // Whether this channel is the one the workspace sends through. Read from
      // the parent row so the UI is told the fact directly instead of deducing
      // it by comparing channel kinds.
      channel: { select: { status: true } },
    },
  });
  return row ? present(row, row.channel?.status === 'ACTIVE') : null;
}

/**
 * Forget the credential.
 *
 * The channel row stays: it carries provisioning history, and deleting it would
 * cascade the credential anyway. What must go is the token — a stored secret
 * with no way to remove it is a worse defect than not being able to store one.
 *
 * This does not unsubscribe the app at Meta. Deliberate: the subscription is on
 * the customer's own WABA, and silently revoking it during what may be a
 * re-entry of credentials would break inbound delivery in a way that looks like
 * a platform fault. Meta's own console is where a customer removes an app.
 */
export async function disconnectMetaChannel(): Promise<boolean> {
  // The `where` is explicit and must stay that way.
  //
  // The tenant extension injects organizationId into a deleteMany only when the
  // call already has a `where` to augment (src/prisma/extensions.ts) — unlike
  // findMany/findFirst just below it, which build one when absent. So
  // `deleteMany({})` is not "delete mine", it is **delete every
  // organization's**, silently, with no error and no scope violation raised.
  const { count } = await prisma.metaChannelCredential.deleteMany({
    where: { organizationId: getTenantId() },
  });
  return count > 0;
}

/**
 * The WhatsappSession name standing in for a Meta phone number.
 *
 * `Conversation.sessionId` is required, and team routing, inbox filters and
 * campaigns all key off WhatsappSession. Giving the Meta channel a session row
 * means none of that has to learn a new concept — the alternative was making
 * sessionId nullable and teaching every consumer what a null session means.
 */
export function metaSessionName(phoneNumberId: string): string {
  return `meta-${phoneNumberId}`;
}

/**
 * The credential the send path uses, with the token decrypted.
 *
 * Separate from getMetaChannel because the two have opposite obligations: that
 * one is shaped for an HTTP response and must never carry the token, this one
 * exists to hand the token to the adapter and must never reach a route. Keeping
 * them apart means a careless `res.json(credential)` cannot compile into a leak.
 *
 * Returns null when there is no credential or it has already been marked
 * invalid — a known-dead token should not be spent on a send that will fail and
 * cost quality rating.
 */
export async function activeMetaCredential(): Promise<{
  id: string;
  phoneNumberId: string;
  accessToken: string;
  messagingTier: string | null;
  qualityRating: string | null;
} | null> {
  const row = await prisma.metaChannelCredential.findFirst({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      phoneNumberId: true,
      accessTokenEnc: true,
      messagingTier: true,
      qualityRating: true,
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    phoneNumberId: row.phoneNumberId,
    accessToken: decryptCredential(row.accessTokenEnc),
    messagingTier: row.messagingTier,
    qualityRating: row.qualityRating,
  };
}

/**
 * Mark a credential dead, once, with a reason the admin can act on.
 *
 * Tokens die on their own — a password change, a permission revoke, a deleted
 * System User — and the first symptom is a 401 on an ordinary send. Recording
 * it turns "messages silently stopped going out" into a visible degraded
 * channel that says what happened, which is the difference between a customer
 * noticing and an agent noticing.
 *
 * Deliberately idempotent-ish: it only writes while the row still reads ACTIVE,
 * so a burst of concurrent sends all failing at once produces one transition
 * and one audit line rather than fifty.
 */
export async function markMetaCredentialInvalid(
  credentialId: string,
  reason: string,
): Promise<boolean> {
  const { count } = await prisma.metaChannelCredential.updateMany({
    where: { id: credentialId, status: 'ACTIVE' },
    data: { status: 'INVALID', invalidReason: reason, lastValidatedAt: new Date() },
  });
  if (count > 0) {
    logger.error('Meta credential marked invalid; channel degraded', {
      organizationId: getTenantId(),
      credentialId,
      reason,
    });
  }
  return count > 0;
}
