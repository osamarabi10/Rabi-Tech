export type PlanCode = 'FREE' | 'STANDARD' | 'GROWTH' | 'BUSINESS' | 'ENTERPRISE';

export type PlanEntitlements = {
  code: PlanCode;
  name: string;
  monthlyPriceCents: number;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  /**
   * Active *and* inactive workflows both count.
   *
   * Counting only active ones would make the limit trivially avoidable — build
   * twenty, keep one on — and would mean a subscriber hits the ceiling by
   * enabling something they already built, which is a worse moment to be told.
   */
  workflowsLimit: number | null;
  campaignRateMax: number;
  campaignRateDurationMs: number;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
  maskContactDetails: boolean;
};

export const PLAN_ENTITLEMENTS: Record<PlanCode, PlanEntitlements> = {
  FREE: {
    code: 'FREE',
    name: 'Free',
    monthlyPriceCents: 0,
    monthlyActiveContactsLimit: 100,
    monthlyOutboundMessagesLimit: 100,
    monthlyCampaignSendsLimit: 0,
    customFieldsLimit: 5,
    usersLimit: 1,
    // Free gets one, so automation is demonstrable rather than merely
    // advertised: a tier that cannot build a single workflow teaches nobody
    // what the feature is worth.
    workflowsLimit: 1,
    campaignRateMax: 1,
    campaignRateDurationMs: 2_000,
    autoProvisionGateway: false,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
  },
  /**
   * Messaging and nothing else: a shared inbox on the subscriber's own number.
   *
   * Every feature limit is zero rather than small. A tier that grants "a few"
   * workflows invites a support conversation about why three is not four; one
   * that grants none states the boundary. Campaign sends are zero for the same
   * reason - broadcasting is a feature, not part of inbound and outbound.
   *
   * PLACEHOLDER VALUES. Price and the two messaging allowances are owner-set by
   * design (see RABITECH-PRODUCT-VISION.md section 2), and these are starting
   * points chosen to be conservative, not decisions. They are editable from the
   * console the moment this ships, which is the whole point of the phase.
   */
  STANDARD: {
    code: 'STANDARD',
    name: 'Standard',
    monthlyPriceCents: 0,
    monthlyActiveContactsLimit: 1000,
    monthlyOutboundMessagesLimit: 5000,
    monthlyCampaignSendsLimit: 0,
    customFieldsLimit: 0,
    usersLimit: 3,
    workflowsLimit: 0,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_500,
    autoProvisionGateway: false,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
  },
  GROWTH: {
    code: 'GROWTH',
    name: 'Growth',
    monthlyPriceCents: 4900,
    monthlyActiveContactsLimit: 2500,
    monthlyOutboundMessagesLimit: 10000,
    monthlyCampaignSendsLimit: 5000,
    customFieldsLimit: 20,
    usersLimit: 5,
    workflowsLimit: 10,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_500,
    autoProvisionGateway: true,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
  },
  BUSINESS: {
    code: 'BUSINESS',
    name: 'Business',
    monthlyPriceCents: 19900,
    monthlyActiveContactsLimit: 10000,
    monthlyOutboundMessagesLimit: 50000,
    monthlyCampaignSendsLimit: 25000,
    customFieldsLimit: 50,
    usersLimit: 25,
    workflowsLimit: 50,
    campaignRateMax: 1,
    campaignRateDurationMs: 1_000,
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
    maskContactDetails: true,
  },
  ENTERPRISE: {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    monthlyPriceCents: 0,
    monthlyActiveContactsLimit: null,
    monthlyOutboundMessagesLimit: null,
    monthlyCampaignSendsLimit: null,
    customFieldsLimit: null,
    usersLimit: null,
    workflowsLimit: null,
    campaignRateMax: 2,
    campaignRateDurationMs: 1_000,
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
    maskContactDetails: true,
  },
};

export function normalizePlanCode(value: unknown): PlanCode {
  const code = String(value || '').trim().toUpperCase();
  if (code in PLAN_ENTITLEMENTS) return code as PlanCode;
  throw new Error('Unknown plan code');
}

export function isPaidPlan(code: PlanCode): boolean {
  return code !== 'FREE';
}
