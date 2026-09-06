import { UsageMetric } from '@prisma/client';
import { getMetricUsage } from '../usage/usage.service';
import { resolveEntitlements } from './entitlements.resolver';
import {
  assertCanFrom,
  decide,
  limitOf,
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

export type { Capability, Decision, LimitValue } from './capabilities';
export {
  CapabilityRefused,
  isCapabilityRefused,
  capabilityRefusalResponse,
} from './capabilities';
