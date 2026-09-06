import { UsageMetric } from '@prisma/client';
import { getMetricUsage } from '../usage/usage.service';
import { resolveEntitlements } from './entitlements.resolver';
import {
  assertCanFrom,
  assertWithinLimitFrom,
  decide,
  limitOf,
  withinLimit,
  type Capability,
  type Decision,
  type LimitValue,
} from './capabilities';

/**
 * The four questions, and the only supported way to ask them.
 *
 * Each is a thin wrapper: fetch the resolved entitlements, hand them to the
 * pure core in `capabilities.ts`, return. Nothing decides anything here, which
 * is what keeps the decisions testable without a database.
 *
 *   can(org, cap)        — is it granted at all?
 *   limit(org, cap)      — how much, null for unlimited
 *   usage(metric)        — how much has been consumed
 *   assertCan(org, cap)  — throw and log unless granted
 *
 * and one more for the counted allowances, because "granted" and "has room"
 * are the two halves every ceiling needs, and hand-rolling the pair at each
 * site is what produced four different refusals to one question:
 *
 *   assertWithinLimit(org, cap, current) — throw unless granted AND not full
 *   hasRoomFor(org, cap, current)        — the same arithmetic, without throwing
 *
 * A caller that needs "granted AND not yet exhausted" wants `assertCan`
 * followed by the quota check; they are different questions and conflating
 * them is how an organization inside its allowance gets refused for having a
 * plan, or outside it gets through for having one.
 */

export async function can(organizationId: string, capability: Capability): Promise<boolean> {
  const entitlements = await resolveEntitlements(organizationId);
  return decide(entitlements, capability).granted;
}

export async function limit(organizationId: string, capability: Capability): Promise<LimitValue> {
  const entitlements = await resolveEntitlements(organizationId);
  return limitOf(entitlements, capability);
}

/**
 * Consumption of a meter in the current period.
 *
 * Tenant-scoped, unlike the three above: usage is counted from the caller's own
 * ledger, and reading it under platform scope would count everybody's.
 */
export async function usage(metric: UsageMetric): Promise<bigint> {
  return getMetricUsage(metric);
}

export async function assertCan(
  organizationId: string,
  capability: Capability,
): Promise<Decision> {
  const entitlements = await resolveEntitlements(organizationId);
  return assertCanFrom(entitlements, capability, organizationId);
}

/**
 * Throw unless the capability is granted and one more would fit.
 *
 * The caller supplies the count because only it knows what is being counted —
 * active users, workspaces in this organization, fields on this contact model.
 * Counting here would mean this module knowing every schema it guards.
 */
export async function assertWithinLimit(
  organizationId: string,
  capability: Capability,
  current: number,
): Promise<Decision> {
  const entitlements = await resolveEntitlements(organizationId);
  return assertWithinLimitFrom(entitlements, capability, current, organizationId);
}

/** Whether one more would fit, for a screen that wants to say so in advance. */
export async function hasRoomFor(
  organizationId: string,
  capability: Capability,
  current: number,
): Promise<boolean> {
  const entitlements = await resolveEntitlements(organizationId);
  return withinLimit(entitlements, capability, current);
}

export type { Capability, Decision, LimitValue } from './capabilities';
export {
  CapabilityRefused,
  LimitReached,
  isCapabilityRefused,
  isLimitReached,
  isEntitlementError,
  capabilityRefusalResponse,
  entitlementErrorResponse,
} from './capabilities';
