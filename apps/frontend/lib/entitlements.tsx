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

/**
 * Cheapest plan that unlocks each feature — shown in the upsell so the user
 * learns what to buy, not merely that they cannot proceed.
 */
const REQUIRES: Record<GatedFeature, string> = {
  broadcasts: 'Growth',
  autoGateway: 'Growth',
  customDomain: 'Business',
  whiteLabel: 'Business',
};

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
    requiredPlanFor: (feature) => (can(feature) ? null : REQUIRES[feature] ?? null),
    can,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEntitlements() {
  return useContext(Ctx);
}
