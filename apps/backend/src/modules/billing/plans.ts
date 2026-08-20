export type PlanCode = 'FREE' | 'GROWTH' | 'BUSINESS' | 'ENTERPRISE';

export type PlanEntitlements = {
  code: PlanCode;
  name: string;
  monthlyPriceCents: number;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
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
    autoProvisionGateway: false,
    customDomain: false,
    whiteLabel: false,
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
    autoProvisionGateway: true,
    customDomain: false,
    whiteLabel: false,
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
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
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
    autoProvisionGateway: true,
    customDomain: true,
    whiteLabel: true,
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

