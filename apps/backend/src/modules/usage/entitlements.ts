import { UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { currentWorkspaceId } from '../../lib/current-workspace';
import { getOrganizationConfig } from '../../utils/whatsapp-sessions';
import { getTenantId, runAsPlatform } from '../../lib/tenant-context';
import {
  getMetricUsage,
  monthRange,
  recordMessageUsage,
  recordUsageEvents,
} from './usage.service';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { decide } from '../billing/capabilities';
import { assertWithinLimit } from '../billing/entitlement-facade';

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

/*
  editionGranting() lived here and was deleted in C4.

  It was a second implementation of "which edition would grant this", written
  before the façade existed, and it had already diverged from the one in
  capabilities.ts: it walked the whole ladder and took the first match, where
  cheapestUpgradeGranting searches strictly above the asker. Two answers to one
  question, and the one a customer saw depended on which refusal they hit.

  decide() names the upgrade now, from the same walk every other refusal uses,
  and the three properties this function was careful about are properties of
  that walk rather than of this file: it reads the published catalogue, so an
  archived edition is never advertised and a refusal with nothing left to
  recommend says nothing rather than naming something nobody can buy; the order
  is sortOrder and not price, because ENTERPRISE is stored at zero and price
  order would answer "Enterprise" for everything; and it runs only once a
  refusal has already been decided, never on the send path.
*/

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
  /*
    One resolution, and the façade decides from it.

    Resolver, not OrganizationConfig: a platform-owner override has to be
    honoured here or an enterprise deal is agreed and then not enforced. And
    decide() rather than a bare limit lookup, because the refusal needs the
    upgrade target too — reading the number here and naming the edition
    somewhere else is exactly how the two drifted apart.
  */
  const entitlements = await resolveEntitlements(organizationId, reference);
  const decision = decide(entitlements, metric);

  /*
    Zero is not a quota. It is the catalogue saying this edition does not
    include the capability, and it must not be reported as an exhausted
    allowance — a subscriber told "resets on the 1st" waits for a reset that
    grants nothing, and campaign recipients queue behind it as `pending`
    forever because the worker treats a quota error as retryable.

    Checked before usage is read, since no amount of usage is relevant to a
    capability that was never included. decide() reports exactly this as
    "not granted": a limit of 0 refuses, null is unlimited, and the two are
    never conflated.

    Still CapabilityNotIncludedError and not the façade's CapabilityRefused,
    deliberately. The campaign worker branches on this type to decide whether a
    recipient is retryable, and the public API maps it to a 402 that tells a
    client to stop. Unifying the type would be a shape change wearing the word
    consistency, and it would strand campaign recipients as `pending` forever.
  */
  if (!decision.granted) {
    throw new CapabilityNotIncludedError(metric, decision.planName, decision.requiredPlan);
  }
  if (decision.limit === null) return;

  const limit = BigInt(decision.limit);
  const current = await getMetricUsage(metric, reference);
  if (current + BigInt(quantity) > limit) {
    throw new QuotaExceededError(metric, current, limit, monthRange(reference).end);
  }
}

/*
  SeatLimitError lived here and was deleted in C4.

  Seats were the third of four counted ceilings, each with its own error class,
  its own status code and its own response body — 402 SEAT_LIMIT_REACHED here,
  402 plan_limit for workspaces, 429 for custom fields and workflows. One
  question, four answers, and a client had to learn all four to handle "your
  plan is full".

  LimitReached in capabilities.ts replaces all four. It keeps 402 and keeps the
  noun in the sentence, so nothing a customer reads got more generic.
*/

/**
 * Refuses a new seat once the plan's user allowance is spent.
 *
 * Only active users count: deactivating an agent should free their seat, or a
 * tenant can never replace someone who left without paying more. That query is
 * the one thing this function still owns — the façade cannot count seats
 * without knowing the User schema, and the whole point of it is that it does
 * not know any schema it guards.
 *
 * Everything else — resolving the effective plan, honouring an override,
 * comparing, naming the upgrade, logging the refusal — is the façade's.
 *
 * @throws {LimitReached} when the plan has no seat left
 * @throws {CapabilityRefused} when the edition grants no seats at all
 */
export async function assertSeatAvailable(): Promise<void> {
  const organizationId = getTenantId();
  const current = await prisma.user.count({ where: { isActive: true } });
  await assertWithinLimit(organizationId, 'seats', current);
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
      /*
        Metering resolves the contact in the CURRENT workspace, not across the
        organization.

        There is no session here - this is asked before a send, from whatever
        scope the caller is in - so ambient workspace scope is the only honest
        answer, and it is also the correct one. The send being metered happens
        in some workspace, and the contact it bills against must be that
        workspace’s contact. Once a number exists in two workspaces, resolving
        it organization-wide would meter one workspace’s message against the
        other’s contact, and monthly-active-contact billing would be wrong in a
        way nobody would think to look for.
      */
      organizationId_workspaceId_phone: {
        organizationId: getTenantId(),
        workspaceId: await currentWorkspaceId(),
        phone,
      },
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
