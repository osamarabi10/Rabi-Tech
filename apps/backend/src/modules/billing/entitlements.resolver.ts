import { OrganizationConfig, SubscriptionStatus, UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { METRIC_LIMIT_FIELDS, USAGE_METRICS } from '../usage/metrics';
import { PlanCode, PlanEntitlements, UNLIMITED_SENTINEL, normalizePlanCode } from './plans';
import { getEdition } from './editions.service';

/**
 * The single place that answers "what is this organization actually entitled to
 * right now?" — after platform-owner overrides, subscription, and tier.
 *
 * ## The rule that shapes this file
 *
 * **Overrides are resolved at read time and are never written into
 * `OrganizationConfig`.**
 *
 * The tempting alternative is write-through: push a MAC override into
 * `OrganizationConfig.monthlyActiveContactsLimit` so the pre-existing
 * enforcement path picks it up with no code change. It was rejected because:
 *
 * 1. **Expiry would stop working.** A written-through number has no memory of
 *    where it came from, so `overrideExpiresAt` would need a sweeper job — and
 *    if that job ever failed, the tenant would silently keep quota they no
 *    longer have. Read-time expiry cannot fail.
 * 2. **Drift detection would break permanently.** `OrganizationConfig` means
 *    "the numbers this plan grants". Writing overrides into it destroys that
 *    meaning, and `detectQuotaDrift` — which exists because tier and config
 *    drifted once already — would fire on every overridden org forever. A
 *    detector that always fires is a detector nobody reads.
 * 3. **The audit trail would stop being the truth.** What is enforced and what
 *    was approved would live in different tables and could disagree.
 *
 * The cost, stated plainly: every enforcement site must call this resolver
 * instead of reading config directly. Those sites are `assertMetricAvailable`,
 * `assertSeatAvailable`, `getCurrentUsage` and `getBillingSummary`.
 */

export type EntitlementSource = 'override' | 'subscription' | 'tier';

export type EffectiveEntitlements = {
  /** The plan actually in force, after overrides. */
  plan: PlanCode;
  planName: string;
  /**
   * The plan ignoring any override — subscription, else tier.
   *
   * This is the plan `applyPlanLimits` derived OrganizationConfig from, so it
   * is the only correct thing to compare config against when detecting drift.
   */
  planOfRecord: PlanCode;
  /** Where `plan` came from. Drives the "عرض خاص" badge and the console. */
  source: EntitlementSource;
  limits: Record<UsageMetric, number | null>;
  seatLimit: number | null;
  /**
   * Organizations allowed, the default one included. Null is unlimited.
   *
   * Read from the edition exactly like seatLimit, so a platform-owner plan
   * override moves it without anything else changing: overriding an
   * organization to BUSINESS grants BUSINESS's organizations for the same reason
   * it grants BUSINESS's seats.
   */
  maxWorkspaces: number | null;
  /** True when any override is live right now (expired ones do not count). */
  isOverridden: boolean;
  override: {
    plan: PlanCode | null;
    macQuota: number | null;
    discountPercent: number | null;
    creditCents: number;
    reason: string | null;
    expiresAt: Date | null;
    /** An override exists on the row but has passed its expiry. */
    expired: boolean;
    setBy: string | null;
    setAt: Date | null;
  };
  /** Plan list price. */
  listPriceCents: number;
  /** After discount. Display only until P10-b wires a real provider. */
  effectivePriceCents: number;
};

/** Subscription states that may name the plan in force. */
const LIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING'];

/**
 * Reads UNLIMITED_SENTINEL back as what it means.
 *
 * `applyPlanLimits` writes the sentinel instead of NULL for an unlimited plan,
 * because the config columns for the three priced metrics are NOT NULL.
 * Anything at or above it means "no limit" and must not be shown to a user as
 * 1,000,000,000. A zero is preserved as a real zero — the restricted floor in
 * editions.service.ts relies on that to deny rather than read as unlimited.
 */
function normalizeLimit(raw: number | bigint | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return value >= UNLIMITED_SENTINEL ? null : value;
}

/**
 * Plan allowances keyed by metric.
 *
 * Five of the six are now priced by edition. `messages_inbound` remains
 * deliberately unlimited on every plan — charging a tenant for messages their
 * *customers* send would let anyone run up their bill — and falls through to
 * config alone.
 *
 * The AI meters joined this list rather than staying config-only. They ship
 * null on every edition, so nothing changes until an owner sets one; what
 * changes is that they *can* be set, which is what makes AI sellable as part of
 * an edition rather than only negotiable into one deal.
 */
function planLimits(
  plan: PlanCode,
  edition: EditionLookup,
): Partial<Record<UsageMetric, number | bigint | null>> {
  const entitlements = edition(plan);
  return {
    messages_outbound: entitlements.monthlyOutboundMessagesLimit,
    active_contacts: entitlements.monthlyActiveContactsLimit,
    campaign_sends: entitlements.monthlyCampaignSendsLimit,
    ai_tokens_in: entitlements.monthlyAiTokensInLimit,
    ai_tokens_out: entitlements.monthlyAiTokensOutLimit,
  };
}

/**
 * The limits actually enforced, layered so that **an organization with no
 * override resolves to exactly the numbers it had before P9 existed**.
 *
 * 1. `macQuotaOverride` — MAC only.
 * 2. A live `planOverride` — that plan's allowance for the three priced
 *    metrics. Without this, moving an org to ENTERPRISE would change the badge
 *    and the seat count but leave its quotas untouched.
 * 3. `OrganizationConfig` — the enforced store, already plan-derived via
 *    `applyPlanLimits`.
 *
 * A *subscription* deliberately does not enter here: `applyPlanLimits` has
 * already written its numbers into config, so reading the plan again would
 * override any deliberate manual adjustment and silently re-tighten quotas.
 */
function effectiveLimits(
  config: OrganizationConfig | null,
  overridePlan: PlanCode | null,
  macQuota: number | null,
  edition: EditionLookup,
): Record<UsageMetric, number | null> {
  const fromPlan = overridePlan ? planLimits(overridePlan, edition) : {};
  const limits = {} as Record<UsageMetric, number | null>;
  for (const metric of USAGE_METRICS) {
    const planValue = fromPlan[metric];
    limits[metric] = planValue !== undefined
      ? normalizeLimit(planValue)
      : normalizeLimit(config?.[METRIC_LIMIT_FIELDS[metric]] as number | bigint | null | undefined);
  }
  if (macQuota !== null) limits.active_contacts = macQuota;
  return limits;
}

/**
 * A plan code that came out of the database.
 *
 * `normalizePlanCode` throws on anything unknown. A bad value in one column
 * must not take billing down for everyone, so this returns null and lets the
 * caller fall through to the next source in the resolution order.
 */
function safePlanCode(value: unknown, context: string): PlanCode | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return normalizePlanCode(value);
  } catch {
    logger.warn('Ignoring unrecognised plan code', { context, value: String(value) });
    return null;
  }
}

/**
 * Resolve what an organization is entitled to.
 *
 * Resolution order: **live override → active subscription → `Organization.tier`**.
 *
 * `now` is taken once and threaded through every comparison. Calling
 * `new Date()` at three points in one resolution can straddle an expiry
 * boundary and produce an answer that contradicts itself.
 *
 * `Organization` is in the tenancy extension's `PLATFORM_MODELS`, so
 * `organizationId` is **not** injected automatically — it is required here and
 * always passed explicitly in the `where`.
 */
/**
 * How an edition is looked up. Always getEdition in production.
 *
 * The one exception is the consequence preview, which needs to ask this exact
 * function what a subscriber WOULD get if one edition held different values.
 * Injecting the lookup is what lets the preview share this code rather than
 * reimplement it — and a preview computed by a second implementation drifts
 * from the real change, which makes it worse than no preview at all.
 */
export type EditionLookup = (code: PlanCode) => PlanEntitlements;

export async function resolveEntitlements(
  organizationId: string,
  now = new Date(),
  options: { editionOverride?: PlanEntitlements } = {},
): Promise<EffectiveEntitlements> {
  /*
    Every edition read below goes through this. With no override it is
    getEdition and nothing changes; with one, the named edition answers with the
    proposed values and every other edition still answers from the catalogue.

    Deliberately not a temporary mutation of the cache: that would make one
    request's hypothetical visible to every concurrent request in the process,
    which is a preview changing what real subscribers are entitled to.
  */
  const edition: EditionLookup = (code) => (
    options.editionOverride && options.editionOverride.code === code
      ? options.editionOverride
      : getEdition(code)
  );
  if (!organizationId) throw new Error('resolveEntitlements requires an organizationId');

  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      tier: true,
      planOverride: true,
      macQuotaOverride: true,
      discountPercent: true,
      creditCents: true,
      overrideReason: true,
      overrideExpiresAt: true,
      overrideSetBy: true,
      overrideSetAt: true,
      configuration: true,
      subscriptions: {
        where: { status: { in: LIVE_SUBSCRIPTION_STATUSES } },
        select: { planCode: true, status: true, activatedAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!organization) throw new Error(`Unknown organization ${organizationId}`);

  // One expiry governs every override field together: one deal, one end date.
  // creditCents is the exception — see below.
  const expiresAt = organization.overrideExpiresAt;
  const hasAnyOverride =
    organization.planOverride !== null ||
    organization.macQuotaOverride !== null ||
    organization.discountPercent !== null;
  const expired = hasAnyOverride && expiresAt !== null && expiresAt <= now;
  const overrideLive = hasAnyOverride && !expired;

  const overridePlan = overrideLive ? safePlanCode(organization.planOverride, 'planOverride') : null;
  // A CANCELED subscription row still carries a planCode; using it would
  // resurrect a plan the tenant has left. Only live statuses are read.
  const subscriptionPlan = safePlanCode(organization.subscriptions[0]?.planCode, 'subscription.planCode');
  const tierPlan = safePlanCode(organization.tier, 'organization.tier');

  const planOfRecord = subscriptionPlan ?? tierPlan ?? 'FREE';
  const plan = overridePlan ?? planOfRecord;
  const source: EntitlementSource = overridePlan
    ? 'override'
    : subscriptionPlan
      ? 'subscription'
      : 'tier';

  // MAC only. One integer cannot mean both active_contacts (~2 500) and
  // ai_tokens_in (~millions), so the other five meters follow plan-or-config.
  // If per-metric overrides are ever needed, add a JSON map consulted before
  // this line — additive, with no migration of existing rows.
  const macQuota = overrideLive ? organization.macQuotaOverride : null;
  const limits = effectiveLimits(organization.configuration, overridePlan, macQuota, edition);

  const discountPercent = overrideLive ? organization.discountPercent : null;
  const listPriceCents = edition(plan).monthlyPriceCents;
  const effectivePriceCents = discountPercent
    ? Math.round(listPriceCents * (100 - discountPercent) / 100)
    : listPriceCents;

  return {
    plan,
    planName: edition(plan).name,
    planOfRecord,
    source,
    limits,
    seatLimit: edition(plan).usersLimit,
    maxWorkspaces: edition(plan).maxWorkspaces,
    isOverridden: overrideLive,
    override: {
      plan: safePlanCode(organization.planOverride, 'planOverride'),
      macQuota: organization.macQuotaOverride,
      discountPercent: organization.discountPercent,
      // Credit never expires: it is money already granted, and quietly taking
      // it back when a plan override lapses would be taking back a payment.
      creditCents: organization.creditCents,
      reason: organization.overrideReason,
      expiresAt,
      expired,
      setBy: organization.overrideSetBy,
      setAt: organization.overrideSetAt,
    },
    listPriceCents,
    effectivePriceCents,
  };
}

/**
 * One metric's effective limit, as a bigint for the enforcement path.
 *
 * `null` means unlimited.
 */
export async function resolveMetricLimit(
  organizationId: string,
  metric: UsageMetric,
  now = new Date(),
): Promise<bigint | null> {
  const entitlements = await resolveEntitlements(organizationId, now);
  const limit = entitlements.limits[metric];
  return limit === null ? null : BigInt(limit);
}
