import { OrganizationConfig, UsageMetric } from '@prisma/client';

/**
 * Metric vocabulary, extracted from usage.service.ts so that both the usage
 * layer and the billing resolver can read it without importing each other.
 *
 * Without this file the two form a cycle: the resolver needs the metric list to
 * build its limits map, and the usage service needs the resolver to know what
 * those limits are.
 */

export const USAGE_METRICS: UsageMetric[] = [
  'messages_inbound',
  'messages_outbound',
  'active_contacts',
  'ai_tokens_in',
  'ai_tokens_out',
  'campaign_sends',
];

/** Which OrganizationConfig column holds each metric's enforced ceiling. */
export const METRIC_LIMIT_FIELDS = {
  messages_inbound: 'monthlyInboundMessagesLimit',
  messages_outbound: 'monthlyOutboundMessagesLimit',
  active_contacts: 'monthlyActiveContactsLimit',
  ai_tokens_in: 'monthlyAiTokensInLimit',
  ai_tokens_out: 'monthlyAiTokensOutLimit',
  campaign_sends: 'monthlyCampaignSendsLimit',
} as const satisfies Record<UsageMetric, keyof OrganizationConfig>;

/**
 * Which `Plan` column carries each metric's edition allowance.
 *
 * Partial on purpose, and the gap is the point. `messages_inbound` is
 * deliberately unmetered by edition — charging a tenant for messages their
 * *customers* send would let anyone run up their bill — so it resolves from
 * OrganizationConfig alone. Every other meter, including the two AI ones, now
 * has an edition column.
 *
 * Distinct from METRIC_LIMIT_FIELDS above, which names the *enforced* column on
 * OrganizationConfig. This one answers a different question: which edition
 * would grant this metric at all, which is what an upgrade prompt has to know.
 */
export const PLAN_METRIC_FIELDS = {
  messages_outbound: 'monthlyOutboundMessagesLimit',
  active_contacts: 'monthlyActiveContactsLimit',
  campaign_sends: 'monthlyCampaignSendsLimit',
  ai_tokens_in: 'monthlyAiTokensInLimit',
  ai_tokens_out: 'monthlyAiTokensOutLimit',
} as const satisfies Partial<Record<UsageMetric, string>>;
