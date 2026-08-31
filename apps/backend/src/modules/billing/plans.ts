import { PricingModel } from '@prisma/client';

/**
 * An edition's code.
 *
 * Was a closed union of the five shipped editions, which made the owner-facing
 * catalogue a lie: the console could reprice and retire an edition, but not
 * create one, because the set of legal codes was fixed at compile time.
 *
 * A bare `string` in its place would be worse than the union it replaces, so
 * the constraint moved rather than vanished — see `normalizePlanCode`, which
 * now checks format and membership of the **loaded catalogue** instead of
 * membership of a compiled-in constant. The authority is the database; the
 * gate is still real.
 */
export type PlanCode = string;

/**
 * What a code may look like.
 *
 * The upper bound and charset are not a style preference. `ensurePlans` derives
 * a row id as `plan_${code.toLowerCase()}`, so anything outside `[A-Z0-9_]`
 * produces an id that is not safe in a URL or a filename, and 24 characters is
 * what the console's plan badge renders without truncating.
 */
export const PLAN_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,23}$/;

/**
 * Codes that cannot be redefined or reused.
 *
 * Only FREE, and the reason is now much narrower than it was. `isPaidPlan`
 * derives from `pricingModel`, so the name no longer decides what is billable —
 * except in one window: seeding runs before the catalogue loads, so no pricing
 * model is published yet and the fallback still tests the name.
 *
 * FREE therefore stays reserved until seeding no longer needs that fallback.
 * Redefining it today would only be wrong during boot, which is precisely when
 * nobody would notice.
 *
 * The other four originals are ordinary rows once the CHECK constraint is
 * gone. Nothing reserves GROWTH, BUSINESS, STANDARD or ENTERPRISE.
 */
export const RESERVED_PLAN_CODES: ReadonlySet<string> = new Set(['FREE']);

/**
 * The codes the loaded catalogue actually carries.
 *
 * Published by editions.service.ts after every successful refresh, rather than
 * imported from it — plans.ts must not depend on the service that depends on
 * plans.ts, and a module cycle here would be resolved differently at boot than
 * under the test harness.
 *
 * Null means the catalogue has not loaded yet. In a serving process that state
 * does not survive startup: the boot gate refuses the port until it loads.
 */
let knownPlanCodes: Set<string> | null = null;

export function publishKnownPlanCodes(codes: Iterable<string>): void {
  knownPlanCodes = new Set(codes);
}

/** Test seam: forget the catalogue, so only format is enforced. */
export function resetKnownPlanCodesForTests(): void {
  knownPlanCodes = null;
  planPricingModels = null;
}

export type PlanEntitlements = {
  code: PlanCode;
  name: string;
  monthlyPriceCents: number;
  /** Read this before the price; see the PricingModel enum in schema.prisma. */
  pricingModel: PricingModel;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  /**
   * Active *and* inactive workflows both count.
   *
   * Counting only active ones would make the limit trivially avoidable — build
   * twenty, keep one on — and would mean a subscriber hits the ceiling by
   * enabling something they already built, which is a worse moment to be told.
   */
  workflowsLimit: number | null;
  /** AI allowances. Null means unlimited. BigInt-backed in the database. */
  monthlyAiTokensInLimit: bigint | null;
  monthlyAiTokensOutLimit: bigint | null;
  campaignRateMax: number;
  campaignRateDurationMs: number;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
  maskContactDetails: boolean;
  /** Channel kinds this edition may connect. Matches OrganizationChannel.kind. */
  allowedChannels: string[];
};

export const PLAN_ENTITLEMENTS: Record<PlanCode, PlanEntitlements> = {
  FREE: {
    code: 'FREE',
    name: 'Free',
    monthlyPriceCents: 0,
    pricingModel: 'FREE',
    monthlyActiveContactsLimit: 100,
    monthlyOutboundMessagesLimit: 100,
    monthlyCampaignSendsLimit: 0,
    customFieldsLimit: 5,
    usersLimit: 1,
    // Free gets one, so automation is demonstrable rather than merely
    // advertised: a tier that cannot build a single workflow teaches nobody
    // what the feature is worth.
    workflowsLimit: 1,
    monthlyAiTokensInLimit: null,
    monthlyAiTokensOutLimit: null,
    campaignRateMax: 1,
    campaignRateDurationMs: 2_000,
    autoProvisionGateway: false,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
    allowedChannels: ['OPENWA', 'WHATSAPP_CLOUD'],
  },
  /**
   * Messaging and nothing else: a shared inbox on the subscriber's own number.
   *
   * Campaign sends are zero: broadcasting is a feature, not part of inbound and
   * outbound, and a tier that grants "a few" of it invites an argument about
   * why three is not four while one that grants none states a boundary.
   *
   * That rule used to apply to custom fields and workflows too, and it made
   * STANDARD grant strictly *less* than FREE — 0 fields against 5, 0 workflows
   * against 1 — so a paying customer got less than a non-paying one on two
   * axes. The rule was sound in isolation and wrong against the rung below it.
   *
   * These two now match FREE, which is the minimum that removes the inversion
   * rather than a considered answer to what STANDARD should offer. That answer
   * is a pricing decision and is editable from the console.
   *
   * The entry paid tier: clearly above the Free trial's 100/100 and clearly
   * below Growth's 2,500 at ~$49. Set by the product owner, and editable from
   * the console the moment this ships - which is the whole point of the phase.
   */
  STANDARD: {
    code: 'STANDARD',
    name: 'Standard',
    monthlyPriceCents: 1900,
    pricingModel: 'FIXED',
    monthlyActiveContactsLimit: 500,
    monthlyOutboundMessagesLimit: 2000,
    monthlyCampaignSendsLimit: 0,
    customFieldsLimit: 5,
    usersLimit: 2,
    workflowsLimit: 1,
    monthlyAiTokensInLimit: null,
    monthlyAiTokensOutLimit: null,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_500,
    autoProvisionGateway: false,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
    allowedChannels: ['OPENWA', 'WHATSAPP_CLOUD'],
  },
  GROWTH: {
    code: 'GROWTH',
    name: 'Growth',
    monthlyPriceCents: 4900,
    pricingModel: 'FIXED',
    monthlyActiveContactsLimit: 2500,
    monthlyOutboundMessagesLimit: 10000,
    monthlyCampaignSendsLimit: 5000,
    customFieldsLimit: 20,
    usersLimit: 5,
    workflowsLimit: 10,
    monthlyAiTokensInLimit: null,
    monthlyAiTokensOutLimit: null,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_500,
    autoProvisionGateway: true,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
    allowedChannels: ['OPENWA', 'WHATSAPP_CLOUD'],
  },
  BUSINESS: {
    code: 'BUSINESS',
    name: 'Business',
    monthlyPriceCents: 19900,
    pricingModel: 'FIXED',
    monthlyActiveContactsLimit: 10000,
    monthlyOutboundMessagesLimit: 50000,
    monthlyCampaignSendsLimit: 25000,
    customFieldsLimit: 50,
    usersLimit: 25,
    workflowsLimit: 50,
    monthlyAiTokensInLimit: null,
    monthlyAiTokensOutLimit: null,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_000,
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
    maskContactDetails: true,
    allowedChannels: ['OPENWA', 'WHATSAPP_CLOUD'],
  },
  ENTERPRISE: {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    monthlyPriceCents: 0,
    pricingModel: 'NEGOTIATED',
    monthlyActiveContactsLimit: null,
    monthlyOutboundMessagesLimit: null,
    monthlyCampaignSendsLimit: null,
    customFieldsLimit: null,
    usersLimit: null,
    workflowsLimit: null,
    monthlyAiTokensInLimit: null,
    monthlyAiTokensOutLimit: null,
    campaignRateMax: 2,
    campaignRateDurationMs: 1_000,
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
    maskContactDetails: true,
    allowedChannels: ['OPENWA', 'WHATSAPP_CLOUD'],
  },
};

/**
 * Canonicalise a caller-supplied code, or throw.
 *
 * Two gates, in order, because they fail for different reasons and the caller
 * deserves to know which:
 *
 * 1. **Format.** A malformed code is a bad request and can never be valid.
 * 2. **Membership of the loaded catalogue.** A well-formed code the catalogue
 *    does not carry is unknown *right now* — it may be an edition that was
 *    never created, or one this process has not loaded yet.
 *
 * The membership gate is skipped only while the catalogue has never loaded,
 * which the boot gate makes unreachable in a serving process. Skipping it
 * there is deliberate: seeding runs before the first load, and a seed that
 * cannot name the codes it is about to create could not run at all.
 */
export function normalizePlanCode(value: unknown): PlanCode {
  const code = String(value ?? '').trim().toUpperCase();
  if (!PLAN_CODE_PATTERN.test(code)) {
    throw new Error(`Invalid plan code: ${JSON.stringify(String(value ?? ''))}`);
  }
  if (knownPlanCodes && !knownPlanCodes.has(code)) {
    throw new Error(`Unknown plan code: ${code}`);
  }
  return code;
}

/**
 * Pricing model per code, published by editions.service.ts alongside the codes.
 *
 * Same seam and same reason as knownPlanCodes: plans.ts must not import the
 * service that imports plans.ts.
 */
let planPricingModels: Map<string, PricingModel> | null = null;

export function publishPlanPricingModels(entries: Iterable<[string, PricingModel]>): void {
  planPricingModels = new Map(entries);
}

/**
 * Whether an edition is billable.
 *
 * Derived from the pricing model, not the code name. The name check this
 * replaces was the only reason FREE had to be a reserved code, and it could not
 * tell a genuinely free edition from a negotiated one — both are priced at zero.
 *
 * The name fallback survives for exactly one window: seeding, which runs before
 * the catalogue has loaded and therefore before any pricing model is published.
 * A serving process never reaches it, because the boot gate loads first.
 */
export function isPaidPlan(code: PlanCode): boolean {
  const model = planPricingModels?.get(code);
  if (model) return model !== 'FREE';
  return code !== 'FREE';
}

/**
 * How "unlimited" is written into OrganizationConfig.
 *
 * The plan says unlimited with `null`; the config columns are `Int NOT NULL`
 * and cannot, so they say it with a number large enough that no tenant reaches
 * it. Any stored value at or above this reads back as null.
 *
 * It lived as a private `const` in three files, which is three chances for one
 * of them to drift and for a limit to stop meaning unlimited in exactly one
 * enforcement site. Changing it is a data migration, not an edit: existing
 * rows hold the old number.
 */
export const UNLIMITED_SENTINEL = 1_000_000_000;

/**
 * Pacing for a catalogue row that leaves it null.
 *
 * `Plan.campaignRateMax` and `campaignRateDurationMs` are nullable, but pacing
 * is not optional in behaviour: a null pace divides by nothing on the send
 * path. These fill the gap.
 *
 * The slowest any shipped edition uses, deliberately. A default that sends
 * faster than the real catalogue would have is the wrong direction to be wrong
 * in — OpenWA drives WhatsApp Web, and blasting is how a number gets banned.
 *
 * Previously taken from PLAN_ENTITLEMENTS by code, which meant an edition the
 * constant had never heard of could not be shaped at all.
 */
export const DEFAULT_CAMPAIGN_PACING = { max: 1, durationMs: 2_000 } as const;

/**
 * The plan a subscription lands on when nothing named one.
 *
 * A commercial default, deliberately still a constant. It was written inline
 * at three call sites — a payment event with no plan code, an owner activation
 * with no plan code, and the trial default — so changing which plan the
 * platform falls back to meant finding all three and hoping there was not a
 * fourth.
 *
 * NOT derived from the catalogue. "Cheapest active paid edition" would compute
 * to STANDARD here rather than GROWTH, which silently moves every trial and
 * every unnamed activation onto a different plan. That is a pricing decision
 * for the platform owner to make deliberately, not a side effect of tidying a
 * literal. Change this line, or make it a PlatformSetting, when that decision
 * is actually taken.
 */
export const ENTRY_PAID_PLAN_CODE: PlanCode = 'GROWTH';
