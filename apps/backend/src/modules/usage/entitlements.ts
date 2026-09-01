import { UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { getOrganizationConfig } from '../../utils/whatsapp-sessions';
import { getTenantId, runAsPlatform } from '../../lib/tenant-context';
import {
  getMetricUsage,
  monthRange,
  recordMessageUsage,
  recordUsageEvents,
} from './usage.service';
import { PLAN_METRIC_FIELDS } from './metrics';
import { cheapestUpgradeGranting } from '../billing/editions.service';
import type { PlanCode, PlanEntitlements } from '../billing/plans';
import { resolveEntitlements, resolveMetricLimit } from '../billing/entitlements.resolver';

export const ENTITLEMENTS: Record<UsageMetric, { blocksOutbound: boolean }> = {
  messages_inbound: { blocksOutbound: false },
  messages_outbound: { blocksOutbound: true },
  active_contacts: { blocksOutbound: true },
  ai_tokens_in: { blocksOutbound: true },
  ai_tokens_out: { blocksOutbound: true },
  campaign_sends: { blocksOutbound: true },
};

export class QuotaExceededError extends Error {
  readonly status = 429;
  readonly code = 'USAGE_QUOTA_EXCEEDED';

  constructor(
    readonly metric: UsageMetric,
    readonly current: bigint,
    readonly limit: bigint,
    readonly resetsAt: Date,
  ) {
    super(`Monthly ${metric} limit reached. Increase the plan limit or wait until ${resetsAt.toISOString()}.`);
    this.name = 'QuotaExceededError';
  }
}

export function isQuotaExceededError(error: unknown): error is QuotaExceededError {
  return error instanceof QuotaExceededError;
}

/**
 * Raised when the edition does not include a capability at all.
 *
 * Distinct from QuotaExceededError, and the distinction is the whole point. A
 * limit of zero was being enforced as though it were a quota, so a subscriber
 * on an edition without broadcasts was told "monthly limit reached, resets on
 * the 1st" — and waited for a reset that would never grant them anything. The
 * two states need different words because they need different actions: one
 * resolves by waiting, the other only by upgrading.
 *
 * 402 with PLAN_UPGRADE_REQUIRED rather than a new shape, matching
 * SeatLimitError above and the masking refusal in system.routes.ts. There was
 * already a working pattern for "your plan does not include this".
 */
export class CapabilityNotIncludedError extends Error {
  readonly status = 402;
  readonly code = 'PLAN_UPGRADE_REQUIRED';

  constructor(
    readonly metric: UsageMetric,
    readonly planName: string,
    /** Cheapest edition that would grant it, or null if none currently does. */
    readonly requiredPlan: string | null,
  ) {
    super(
      requiredPlan
        ? `باقة ${planName} لا تشمل هذه الميزة. رقّي إلى ${requiredPlan} لتفعيلها.`
        : `باقة ${planName} لا تشمل هذه الميزة.`,
    );
    this.name = 'CapabilityNotIncludedError';
  }
}

export function isCapabilityNotIncludedError(error: unknown): error is CapabilityNotIncludedError {
  return error instanceof CapabilityNotIncludedError;
}

export function capabilityErrorResponse(error: CapabilityNotIncludedError) {
  return {
    error: error.message,
    code: error.code,
    capability: error.metric,
    requiredPlan: error.requiredPlan,
  };
}

/**
 * The cheapest active edition that grants a metric at all.
 *
 * Active means both columns: not withdrawn from sale, and not archived. This
 * names an upgrade target, so it is an offer question - the same one
 * getEditions() answers - and an archived edition must never be advertised. If
 * every granting edition has been archived the result is null and the refusal
 * names no upgrade at all, which is the right outcome: better to say only what
 * is forbidden than to point at something nobody can buy.
 *
 * Read from the catalogue, never hardcoded. A literal "requires Growth" starts
 * lying the first time the owner moves a capability, and the console already
 * carries one such map that will need the same treatment.
 *
 * Ordered by `sortOrder`, not price: ENTERPRISE is stored at zero because its
 * price is negotiated, so ordering by price would answer "Enterprise" for
 * everything. Ladder position is the honest ordering until pricingModel lands.
 *
 * Runs only when a capability has already been refused — once per rejected
 * request, never on the send path — so the extra read costs nothing that
 * matters.
 */
async function editionGranting(metric: UsageMetric, askingPlan: PlanCode): Promise<string | null> {
  const field = (PLAN_METRIC_FIELDS as Record<string, string | undefined>)[metric];
  if (!field) return null;
  try {
    /*
      Reads the published ladder from the catalogue cache rather than the
      database, so it shares one definition of "is this actually an upgrade"
      with channelRefusal. The two carried the identical assumption and would
      have had to be fixed twice; now they are the same function.

      The cache is already ordered by sortOrder with code breaking ties, which
      is what made the previous query's own ordering necessary.
    */
    return cheapestUpgradeGranting(askingPlan, (edition: PlanEntitlements) => {
      const value = (edition as unknown as Record<string, unknown>)[field];
      return value === null || Number(value) > 0;
    });
  } catch (error) {
    // The refusal stands either way. Failing to name the upgrade is a worse
    // message, not a reason to let the request through.
    logger.warn('Could not determine the edition granting a capability', {
      metric,
      error: String(error),
    });
    return null;
  }
}

export function quotaErrorResponse(error: QuotaExceededError) {
  return {
    error: error.message,
    code: error.code,
    metric: error.metric,
    current: error.current.toString(),
    limit: error.limit.toString(),
    resetsAt: error.resetsAt.toISOString(),
  };
}

export async function assertMetricAvailable(
  metric: UsageMetric,
  quantity: bigint | number = 1,
  reference = new Date(),
): Promise<void> {
  if (!ENTITLEMENTS[metric].blocksOutbound) return;
  const organizationId = getTenantId();
  // Resolver, not OrganizationConfig: a platform-owner override has to be
  // honoured here or an enterprise deal is agreed and then not enforced.
  const limit = await resolveMetricLimit(organizationId, metric, reference);
  if (limit === null) return;

  /*
    Zero is not a quota. It is the catalogue saying this edition does not
    include the capability, and it must not be reported as an exhausted
    allowance — a subscriber told "resets on the 1st" waits for a reset that
    grants nothing, and campaign recipients queue behind it as `pending`
    forever because the worker treats a quota error as retryable.

    Checked before usage is read, since no amount of usage is relevant to a
    capability that was never included.
  */
  if (limit === BigInt(0)) {
    const entitlements = await resolveEntitlements(organizationId, reference);
    throw new CapabilityNotIncludedError(
      metric,
      entitlements.planName,
      await editionGranting(metric, entitlements.plan),
    );
  }

  const current = await getMetricUsage(metric, reference);
  if (current + BigInt(quantity) > limit) {
    throw new QuotaExceededError(metric, current, limit, monthRange(reference).end);
  }
}

/**
 * Raised when a plan's seat allowance is already used up.
 *
 * Separate from QuotaExceededError because seats are not a metered monthly
 * counter — there is no reset date, only an upgrade.
 */
export class SeatLimitError extends Error {
  readonly status = 402;
  readonly code = 'SEAT_LIMIT_REACHED';

  constructor(readonly current: number, readonly limit: number, readonly planName: string) {
    super(`باقة ${planName} تسمح بـ ${limit} مستخدم. لإضافة المزيد، رقّي الباقة.`);
    this.name = 'SeatLimitError';
  }
}

export function isSeatLimitError(error: unknown): error is SeatLimitError {
  return error instanceof SeatLimitError;
}

export function seatLimitResponse(error: SeatLimitError) {
  return {
    error: error.message,
    code: error.code,
    current: error.current,
    limit: error.limit,
    plan: error.planName,
    upgradeRequired: true,
  };
}

/**
 * Refuses a new seat once the plan's user allowance is spent.
 *
 * Only active users count: deactivating an agent should free their seat, or a
 * tenant can never replace someone who left without paying more.
 *
 * @throws {SeatLimitError} when the plan has no seat left
 */
export async function assertSeatAvailable(): Promise<void> {
  const organizationId = getTenantId();
  // Seats follow the effective plan too. Reading Organization.tier directly
  // would grant an overridden org the quotas of its new plan but the seats of
  // its old one — half an upgrade, which is worse than none.
  const entitlements = await resolveEntitlements(organizationId);
  if (entitlements.seatLimit === null) return;

  const current = await prisma.user.count({ where: { isActive: true } });
  if (current >= entitlements.seatLimit) {
    throw new SeatLimitError(current, entitlements.seatLimit, entitlements.planName);
  }
}

function normalizedDirectAddress(address: string): string | null {
  if (address.includes('@g.us')) return null;
  const normalized = address
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/^\+/, '');
  return normalized || null;
}

/**
 * The contact behind an outbound address, or null.
 *
 * Exported because the Meta service-window check needs the same answer BEFORE
 * metering runs - the window decides whether a send is allowed at all, and a
 * refused send must not consume quota. Two normalisations of the same address
 * would eventually disagree, and the one place that would show up is a message
 * charged to a tenant that was never sent.
 */
export async function contactIdForAddress(address: string): Promise<string | null> {
  const phone = normalizedDirectAddress(address);
  if (!phone) return null;
  const contact = await prisma.contact.findUnique({
    where: {
      organizationId_phone: { organizationId: getTenantId(), phone },
    },
    select: { id: true },
  });
  return contact?.id ?? null;
}

async function contactIsActiveThisMonth(contactId: string): Promise<boolean> {
  const { start, end } = monthRange();
  return Boolean(await prisma.usageEvent.findFirst({
    where: {
      metric: 'active_contacts',
      subjectId: contactId,
      occurredAt: { gte: start, lt: end },
    },
    select: { id: true },
  }));
}

export type OutboundUsageOptions = {
  campaign?: boolean;
  campaignSubjectId?: string | null;
  /**
   * Platform-originated traffic that must not touch tenant meters.
   *
   * Today the only user is the gateway health probe (H1). Such a send is
   * neither charged to the tenant nor blocked when they are at quota, for two
   * reasons: it is our traffic, not theirs, and `assertMetricAvailable` throws
   * at the ceiling — so a metered monitor would stop running exactly when the
   * system is most stressed, and record the quota block as a gateway fault.
   *
   * This is a deliberate bypass around billing. The tenancy gate asserts that
   * an internal send records no UsageEvent, because one careless
   * `internal: true` on a customer-facing path would silently under-bill every
   * tenant.
   */
  internal?: boolean;
};

export async function prepareOutboundSend(
  address: string,
  options: OutboundUsageOptions = {},
): Promise<{ contactId: string | null }> {
  // Platform traffic is not the tenant's and must not be refused on their
  // quota. Guarded here as well as in meteredSend so the flag behaves the same
  // whichever entry point a future caller uses.
  if (options.internal) return { contactId: null };

  await assertMetricAvailable('messages_outbound');
  if (options.campaign) await assertMetricAvailable('campaign_sends');

  const contactId = await contactIdForAddress(address);
  if (contactId && !(await contactIsActiveThisMonth(contactId))) {
    await assertMetricAvailable('active_contacts');
  }
  return { contactId };
}

export async function recordSuccessfulOutboundSend(
  contactId: string | null,
  messageSubjectId?: string | null,
  options: OutboundUsageOptions = {},
): Promise<void> {
  // Never bill the tenant for platform traffic. See OutboundUsageOptions.internal.
  if (options.internal) return;

  try {
    await recordMessageUsage('OUTBOUND', contactId, messageSubjectId);
    if (options.campaign) {
      await recordUsageEvents([
        { metric: 'campaign_sends', subjectId: options.campaignSubjectId ?? messageSubjectId },
      ]);
    }
  } catch (error) {
    logger.error('Successful outbound send could not be metered', {
      error: String(error),
      organizationId: getTenantId(),
      messageSubjectId,
    });
  }
}
