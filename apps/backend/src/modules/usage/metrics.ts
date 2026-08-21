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
