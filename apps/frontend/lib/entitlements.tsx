'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchBillingSummary, type BillingSummary, type PlanEntitlements } from '@/lib/data';

/**
 * Plan entitlements for the signed-in organization.
 *
 * This gates what the UI *shows*, never what the server *allows*. The backend
 * enforces independently (`assertMetricAvailable`, `assertSeatAvailable`), and
 * must keep doing so — a UI gate is a courtesy to the user, not a control. Any
 * feature that relies on this alone is unprotected.
 *
 * Fetched once and shared, so eight components asking "can I broadcast?" cost
 * one request rather than eight.
 */
export type Entitlements = {
  loading: boolean;
  plan: { code: string; name: string } | null;
  limits: PlanEntitlements | null;
  seats: BillingSummary['seats'] | null;
  /** Plan a locked feature requires, for the upsell copy. */
  requiredPlanFor: (feature: GatedFeature) => string | null;
  can: (feature: GatedFeature) => boolean;
};

/** Features that differ by plan. Add here, not scattered through components. */
export type GatedFeature = 'broadcasts' | 'customDomain' | 'whiteLabel' | 'autoGateway';

/*
  The map that used to live here is gone.

  It read { broadcasts: 'Growth', customDomain: 'Business', ... } - names
  written when the ladder was fixed in a TypeScript constant, and nothing kept
  them true once an owner could move a capability from the console. The server
  has derived the same answer from the catalogue since E5a, so the upsell on a
  locked button could disagree with the refusal the server gives when the user
  follows it.

  The answer now comes from the billing summary, computed once from the
  published ladder. The two can no longer differ, because there is only one.
*/

const Ctx = createContext<Entitlements>({
  loading: true,
  plan: null,
  limits: null,
  seats: null,
  requiredPlanFor: () => null,
  can: () => true, // fail open while loading; the server is the real gate
});

export function EntitlementsProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBillingSummary()
      .then(setSummary)
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, []);

  const limits = summary?.entitlements ?? null;

  const can = (feature: GatedFeature): boolean => {
    // Unknown entitlements must not hide the UI — the server still refuses.
    if (!limits) return true;
    switch (feature) {
      case 'broadcasts':
        // 0 means the plan forbids broadcasts; null means unlimited.
        return limits.monthlyCampaignSendsLimit === null || limits.monthlyCampaignSendsLimit > 0;
      case 'customDomain':
        return limits.customDomain;
      case 'whiteLabel':
        return limits.whiteLabel;
      case 'autoGateway':
        return limits.autoProvisionGateway;
      default:
        return true;
    }
  };

  const value: Entitlements = {
    loading,
    plan: summary ? { code: summary.plan.code, name: summary.plan.name } : null,
    limits,
    seats: summary?.seats ?? null,
    /*
      Null means two different things and the caller must handle both: the
      feature is already available, or no published edition grants it at all.
      Neither is a plan name, and rendering "Upgrade to null" is the failure
      this returns null to prevent.
    */
    requiredPlanFor: (feature) => (can(feature) ? null : summary?.featureUpgrades?.[feature] ?? null),
    can,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlements() {
  return useContext(Ctx);
}
