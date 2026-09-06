import { UsageMetric } from '@prisma/client';
import logger from '../../lib/logger';
import { getEdition, cheapestUpgradeGranting } from './editions.service';
import { PlanEntitlements } from './plans';
import type { EffectiveEntitlements } from './entitlements.resolver';

/**
 * The one place anything asks what an organization is allowed to do.
 *
 * ## Why a façade at all
 *
 * Before this, "may they?" was answered in four different shapes:
 * `assertMetricAvailable` for meters, `assertSeatAvailable` for seats, an
 * inline count-and-compare in the workspaces route, and — in one place — a
 * plan name written into the refusal. Four shapes means four places for the
 * answer to drift, and the drift is invisible because each one is individually
 * correct.
 *
 * `can` / `limit` / `usage` / `assertCan` replace all of it.
 *
 * ## Why the decision core is pure
 *
 * `decide()` and `limitOf()` take an already-resolved entitlement snapshot and
 * return an answer. They touch no database, no clock and no ambient scope, so
 * the gate can drive every edition and every override shape from fixtures and
 * be certain it is testing the decision rather than the seeding.
 *
 * The async wrappers below are the only part that reads anything, and all they
 * do is fetch the snapshot and delegate. That split is the point: a rule that
 * needs a database to evaluate is a rule nobody can enumerate.
 *
 * ## Capabilities are never decided by plan name
 *
 * A capability is granted by a *field* on the resolved edition, never by which
 * edition it is. `scripts/verify-capabilities.js` proves it behaviourally: for
 * every shipped edition it builds a shadow edition with identical entitlements
 * under a different code and asserts every decision matches. A comparison
 * against a plan name — anywhere on the path — makes the pair disagree.
 *
 * That is deliberately not a grep. Two audits in this repository have tested
 * spelling and passed while the behaviour was wrong.
 */

/** Feature grants: a boolean column on the edition. */
export const FEATURE_CAPABILITIES = [
  'customDomain',
  'whiteLabel',
  'maskContactDetails',
  'autoProvisionGateway',
] as const;
export type FeatureCapability = (typeof FEATURE_CAPABILITIES)[number];

/** Counted allowances that are not usage meters. */
export const COUNTED_LIMITS = ['seats', 'workspaces', 'customFields', 'workflows'] as const;
export type CountedLimit = (typeof COUNTED_LIMITS)[number];

/** The usage meters, as names. Mirrors the UsageMetric enum. */
export const USAGE_METRIC_NAMES = [
  'messages_inbound', 'messages_outbound', 'active_contacts',
  'ai_tokens_in', 'ai_tokens_out', 'campaign_sends',
] as const satisfies readonly UsageMetric[];

export type Capability = FeatureCapability | UsageMetric | CountedLimit;

/** How a limit reads: a number, or null for unlimited. */
export type LimitValue = number | null;

/**
 * Why a request was refused, or that it was not.
 *
 * `granted` and `reason` are separate so a caller can log the reason on a
 * *granted* decision too — useful when a grant came from an override rather
 * than the plan, which is the case an auditor asks about later.
 */
export type Decision = {
  granted: boolean;
  capability: Capability;
  /** The edition in force when this was decided. */
  plan: string;
  planName: string;
  /** Present only on a refusal: the cheapest edition that would grant it. */
  requiredPlan: string | null;
  /** For a counted or metered capability, what the plan allows. */
  limit: LimitValue;
};

/**
 * Every name this module understands.
 *
 * Needed because "unknown" and "unlimited" are both absences, and without
 * this they were the same absence: an unrecognised name fell through to the
 * metric lookup, produced `undefined`, was normalised to `null`, and `null`
 * means unlimited — so a typo granted everything. The gate caught it on its
 * first run against the module it was written to test.
 *
 * A guard whose failure mode is "allow" is not a guard. Unknown refuses.
 */
const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  ...FEATURE_CAPABILITIES,
  ...COUNTED_LIMITS,
  ...USAGE_METRIC_NAMES,
]);

export function isKnownCapability(name: string): name is Capability {
  return KNOWN_CAPABILITIES.has(name);
}

function isFeature(capability: Capability): capability is FeatureCapability {
  return (FEATURE_CAPABILITIES as readonly string[]).includes(capability);
}
function isCounted(capability: Capability): capability is CountedLimit {
  return (COUNTED_LIMITS as readonly string[]).includes(capability);
}

/**
 * What the resolved entitlements allow for a counted or metered capability.
 *
 * Pure. `null` means unlimited and is **not** the same as `0`, which means the
 * edition grants none of it — conflating them is how an unlimited plan starts
 * refusing everything.
 */
export function limitOf(
  entitlements: EffectiveEntitlements,
  capability: Capability,
): LimitValue {
  // 0, not null: an unknown name grants none of whatever it is. Returning
  // null here would read as unlimited.
  if (!isKnownCapability(capability as string)) return 0;
  if (isFeature(capability)) return null;
  if (isCounted(capability)) {
    switch (capability) {
      case 'seats': return entitlements.seatLimit;
      case 'workspaces': return entitlements.maxWorkspaces;
      case 'customFields': return getEdition(entitlements.plan).customFieldsLimit;
      case 'workflows': return getEdition(entitlements.plan).workflowsLimit;
    }
  }
  // A usage meter. These come off the resolved limits, which have already had
  // any per-metric override folded in — reading the edition here instead would
  // silently ignore a negotiated MAC quota.
  return entitlements.limits[capability as UsageMetric] ?? null;
}

/**
 * Whether the capability is granted at all.
 *
 * Pure. A limit of `0` is a refusal, `null` is unlimited, and any positive
 * number is a grant — *whether or not it has been consumed*. "Granted" and
 * "available right now" are different questions and this is the first;
 * `assertCan` answers it, and the quota check answers the second.
 */
export function decide(
  entitlements: EffectiveEntitlements,
  capability: Capability,
): Decision {
  if (!isKnownCapability(capability as string)) {
    // A programming error, not a customer one — so it is logged at error
    // level and still refused. Failing open here would mean a mistyped
    // capability silently grants whatever it guards.
    logger.error('Unknown capability asked of the entitlement façade', {
      capability, plan: entitlements.plan,
    });
    return {
      granted: false,
      capability,
      plan: entitlements.plan,
      planName: entitlements.planName,
      requiredPlan: null,
      limit: 0,
    };
  }
  const edition = getEdition(entitlements.plan);
  const limit = limitOf(entitlements, capability);
  const granted = isFeature(capability)
    ? Boolean(edition[capability])
    : limit === null || limit > 0;

  return {
    granted,
    capability,
    plan: entitlements.plan,
    planName: entitlements.planName,
    limit,
    // Named from the ladder, never written down. A hardcoded upgrade target is
    // wrong the moment an edition is repriced, reordered or archived — and it
    // reads as authoritative while being stale.
    requiredPlan: granted ? null : cheapestUpgradeGranting(entitlements.plan, (candidate) =>
      grantsCapability(candidate, capability)),
  };
}

/** Whether a *candidate* edition would grant the capability. Pure. */
export function grantsCapability(edition: PlanEntitlements, capability: Capability): boolean {
  if (!isKnownCapability(capability as string)) return false;
  if (isFeature(capability)) return Boolean(edition[capability]);
  switch (capability) {
    case 'seats': return edition.usersLimit === null || (edition.usersLimit ?? 0) > 0;
    case 'workspaces': return edition.maxWorkspaces === null || (edition.maxWorkspaces ?? 0) > 0;
    case 'customFields': return edition.customFieldsLimit === null || (edition.customFieldsLimit ?? 0) > 0;
    case 'workflows': return edition.workflowsLimit === null || (edition.workflowsLimit ?? 0) > 0;
    default: {
      const value = PLAN_METRIC_LIMIT[capability as UsageMetric](edition);
      return value === null || value > 0;
    }
  }
}

/** Which edition column carries each meter's allowance. */
const PLAN_METRIC_LIMIT: Record<UsageMetric, (e: PlanEntitlements) => number | null> = {
  messages_inbound: () => null,   // deliberately unmetered by edition
  messages_outbound: (e) => e.monthlyOutboundMessagesLimit,
  active_contacts: (e) => e.monthlyActiveContactsLimit,
  campaign_sends: (e) => e.monthlyCampaignSendsLimit,
  ai_tokens_in: (e) => (e.monthlyAiTokensInLimit === null ? null : Number(e.monthlyAiTokensInLimit)),
  ai_tokens_out: (e) => (e.monthlyAiTokensOutLimit === null ? null : Number(e.monthlyAiTokensOutLimit)),
};

/**
 * Refused because the edition does not include the capability.
 *
 * 402 with PLAN_UPGRADE_REQUIRED, matching every other "your plan does not
 * include this" refusal in the product.
 */
export class CapabilityRefused extends Error {
  readonly status = 402;
  readonly code = 'PLAN_UPGRADE_REQUIRED';

  constructor(readonly decision: Decision) {
    super(
      decision.requiredPlan
        ? `باقة ${decision.planName} لا تشمل هذه الميزة. رقّي إلى ${decision.requiredPlan} لتفعيلها.`
        : `باقة ${decision.planName} لا تشمل هذه الميزة.`,
    );
    this.name = 'CapabilityRefused';
  }
}

export function isCapabilityRefused(error: unknown): error is CapabilityRefused {
  return error instanceof CapabilityRefused;
}

/** The body a route returns for a refusal. */
export function capabilityRefusalResponse(error: CapabilityRefused) {
  return {
    error: error.message,
    code: error.code,
    capability: error.decision.capability,
    requiredPlan: error.decision.requiredPlan,
  };
}

/**
 * Throw unless the capability is granted — and say so in the log either way.
 *
 * **Never a silent no-op.** A guard that can return without deciding is worse
 * than no guard: it reads as protection at the call site and grants everything
 * at runtime, and nothing in the logs distinguishes "checked and allowed" from
 * "never actually checked". Both outcomes are recorded here, at different
 * levels, so a refusal a customer reports can be found and a grant can be
 * accounted for.
 */
export function assertCanFrom(
  entitlements: EffectiveEntitlements,
  capability: Capability,
  organizationId?: string,
): Decision {
  const decision = decide(entitlements, capability);
  if (!decision.granted) {
    logger.warn('Capability refused', {
      organizationId,
      capability,
      plan: decision.plan,
      requiredPlan: decision.requiredPlan,
      limit: decision.limit,
    });
    throw new CapabilityRefused(decision);
  }
  logger.debug('Capability granted', {
    organizationId,
    capability,
    plan: decision.plan,
    limit: decision.limit,
  });
  return decision;
}
