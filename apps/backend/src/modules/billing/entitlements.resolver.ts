import { OrganizationConfig, SubscriptionStatus, UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { METRIC_LIMIT_FIELDS, USAGE_METRICS } from '../usage/metrics';
import { PlanCode, UNLIMITED_SENTINEL, normalizePlanCode } from './plans';
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
 * Only three of the six are priced. `messages_inbound` is deliberately
 * unlimited on every plan — charging a tenant for messages their *customers*
 * send would let anyone run up their bill — and AI token limits are negotiated
 * per deal rather than set per plan. Both fall through to config.
 */
function planLimits(plan: PlanCode): Partial<Record<UsageMetric, number | null>> {
  const entitlements = getEdition(plan);
  return {
    messages_outbound: entitlements.monthlyOutboundMessagesLimit,
    active_contacts: entitlements.monthlyActiveContactsLimit,
    campaign_sends: entitlements.monthlyCampaignSendsLimit,
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
): Record<UsageMetric, number | null> {
  const fromPlan = overridePlan ? planLimits(overridePlan) : {};
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
export async function resolveEntitlements(
  organizationId: string,
  now = new Date(),
): Promise<EffectiveEntitlements> {
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
  const limits = effectiveLimits(organization.configuration, overridePlan, macQuota);

  const discountPercent = overrideLive ? organization.discountPercent : null;
  const listPriceCents = getEdition(plan).monthlyPriceCents;
  const effectivePriceCents = discountPercent
    ? Math.round(listPriceCents * (100 - discountPercent) / 100)
    : listPriceCents;

  return {
    plan,
    planName: getEdition(plan).name,
    planOfRecord,
    source,
    limits,
    seatLimit: getEdition(plan).usersLimit,
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
