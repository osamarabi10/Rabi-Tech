import { UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { getOrganizationConfig } from '../../utils/whatsapp-sessions';
import { getTenantId } from '../../lib/tenant-context';
import {
  getMetricUsage,
  monthRange,
  recordMessageUsage,
  recordUsageEvents,
} from './usage.service';
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

async function contactIdForAddress(address: string): Promise<string | null> {
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
