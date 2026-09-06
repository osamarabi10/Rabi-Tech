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
/**
 * Whether this is a resolved snapshot at all.
 *
 * TypeScript settles this for every caller it can see, and the JavaScript
 * gates are not callers it can see. The tenancy harness handed
 * assertFooterEntitlement a plan CODE after C4 changed the signature to take
 * the resolved entitlements, and the result was a refusal reading
 * "باقة undefined لا تشمل هذه الميزة" — safe, because getEdition(undefined)
 * falls to the deny-everything floor, and useless, because nothing said why.
 *
 * Failing closed is the easy half. Saying so is the half that gets it fixed:
 * this is the same rule as the unknown capability below, one level out.
 */
function isResolvedSnapshot(entitlements: EffectiveEntitlements): boolean {
  return Boolean(entitlements)
    && typeof entitlements.plan === 'string'
    && typeof entitlements.planName === 'string';
}

export function decide(
  entitlements: EffectiveEntitlements,
  capability: Capability,
): Decision {
  if (!isResolvedSnapshot(entitlements)) {
    logger.error('Entitlement façade was handed something that is not a resolved snapshot', {
      capability,
      received: typeof entitlements,
    });
    return {
      granted: false,
      capability,
      plan: 'UNRESOLVED',
      planName: 'UNRESOLVED',
      requiredPlan: null,
      limit: 0,
    };
  }
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

/**
 * What a *candidate* edition allows for a counted or metered capability.
 *
 * Needed because naming an upgrade for a ceiling that has been reached is a
 * different question from naming one for a capability that was never included:
 * the asker already has the capability, so "grants it at all" would happily
 * name an edition with the very ceiling they are already stuck at.
 */
export function editionLimitOf(edition: PlanEntitlements, capability: Capability): LimitValue {
  if (!isKnownCapability(capability as string)) return 0;
  if (isFeature(capability)) return null;
  switch (capability) {
    case 'seats': return edition.usersLimit;
    case 'workspaces': return edition.maxWorkspaces;
    case 'customFields': return edition.customFieldsLimit;
    case 'workflows': return edition.workflowsLimit;
    default: return PLAN_METRIC_LIMIT[capability as UsageMetric](edition);
  }
}

/** Whether a *candidate* edition would grant the capability. Pure. */
export function grantsCapability(edition: PlanEntitlements, capability: Capability): boolean {
  if (!isKnownCapability(capability as string)) return false;
  if (isFeature(capability)) return Boolean(edition[capability]);
  // One definition of "what does this edition allow", used by both the boolean
  // and the numeric comparison. Two would drift the first time a column moved.
  const value = editionLimitOf(edition, capability);
  return value === null || value > 0;
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

/**
 * The noun each counted allowance is counted in.
 *
 * One refusal shape must not cost the customer a readable sentence. Before this
 * the four ceilings each wrote their own message and each named its own noun —
 * مستخدم, مساحة عمل, أتمتة — and a generic "your plan allows 5" would have been
 * a regression wearing the word consistency.
 */
const COUNTED_NOUNS: Record<CountedLimit, string> = {
  seats: 'مستخدم',
  workspaces: 'مساحة عمل',
  customFields: 'حقل',
  workflows: 'أتمتة',
};

/**
 * Refused because a ceiling the edition *does* include has been reached.
 *
 * Deliberately **not** the same error as CapabilityRefused, and the difference
 * is what the customer can do about it. A capability that was never included
 * resolves only by upgrading. A ceiling that is full also resolves by freeing
 * one — deactivating a user, deleting a workspace — and a message offering only
 * the upgrade sells them something they did not need.
 *
 * 402, not 429. 429 means "you are going too fast, retry later": true of a
 * monthly meter, false of a plan ceiling, where waiting changes nothing and a
 * client that honours 429 retries a refusal forever. Custom fields and
 * workflows both answered 429 before this commit.
 */
export class LimitReached extends Error {
  readonly status = 402;
  readonly code = 'PLAN_LIMIT_REACHED';

  constructor(readonly decision: Decision, readonly current: number) {
    const noun = COUNTED_NOUNS[decision.capability as CountedLimit] ?? '';
    const allowance = `باقة ${decision.planName} بتسمح بـ ${decision.limit} ${noun}`.trim();
    super(
      decision.requiredPlan
        ? `${allowance}. رقّي إلى ${decision.requiredPlan} لو بدك أكثر.`
        : `${allowance}.`,
    );
    this.name = 'LimitReached';
  }
}

export function isLimitReached(error: unknown): error is LimitReached {
  return error instanceof LimitReached;
}

/** Either entitlement refusal — never included, or included and full. */
export function isEntitlementError(error: unknown): error is CapabilityRefused | LimitReached {
  return isCapabilityRefused(error) || isLimitReached(error);
}

/**
 * The body a route returns for either refusal.
 *
 * `error` and `message` both carry the sentence. Two conventions were already
 * shipped — the capability refusals put the text in `error`, the workspace one
 * put a slug there and the text in `message`, and the workspace switcher reads
 * `data.message` — so sending both is what lets one shape replace four without
 * a frontend change. `code` is the field to branch on.
 */
export function entitlementErrorResponse(error: CapabilityRefused | LimitReached) {
  return {
    error: error.message,
    message: error.message,
    code: error.code,
    capability: error.decision.capability,
    requiredPlan: error.decision.requiredPlan,
    planName: error.decision.planName,
    limit: error.decision.limit,
    current: isLimitReached(error) ? error.current : null,
  };
}

/**
 * Whether one more would fit. Pure, and the same arithmetic the refusal uses.
 *
 * Exported so a screen can grey out a control with the identical comparison the
 * server will apply, rather than a second one that happens to agree today.
 */
export function withinLimit(
  entitlements: EffectiveEntitlements,
  capability: Capability,
  current: number,
): boolean {
  const decision = decide(entitlements, capability);
  if (!decision.granted) return false;
  return decision.limit === null || current < decision.limit;
}

/**
 * Throw unless the capability is granted **and** has room for one more.
 *
 * Two refusals, in this order, because they are different answers:
 *   - not included at all -> CapabilityRefused, 402 PLAN_UPGRADE_REQUIRED
 *   - included but full   -> LimitReached,      402 PLAN_LIMIT_REACHED
 *
 * The upgrade named for a full ceiling is the cheapest edition above whose
 * allowance exceeds what is already held — not merely one that grants the
 * capability, which the asker already has. Naming the latter is how a customer
 * at 5 of 5 workspaces gets sold an edition that also allows 5.
 *
 * A feature capability has no ceiling, so this degenerates to assertCan for
 * one: the count is ignored because there is nothing to count it against.
 */
export function assertWithinLimitFrom(
  entitlements: EffectiveEntitlements,
  capability: Capability,
  current: number,
  organizationId?: string,
): Decision {
  const decision = assertCanFrom(entitlements, capability, organizationId);
  if (decision.limit === null || current < decision.limit) return decision;

  const requiredPlan = cheapestUpgradeGranting(entitlements.plan, (candidate) => {
    const allowed = editionLimitOf(candidate, capability);
    return allowed === null || allowed > current;
  });
  logger.warn('Plan limit reached', {
    organizationId,
    capability,
    plan: decision.plan,
    limit: decision.limit,
    current,
    requiredPlan,
  });
  throw new LimitReached({ ...decision, granted: false, requiredPlan }, current);
}
