import { OrganizationConfig, UsageMetric } from '@prisma/client';
import { getTenantId } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import { getOrganizationConfig } from '../../utils/whatsapp-sessions';

export const USAGE_METRICS: UsageMetric[] = [
  'messages_inbound',
  'messages_outbound',
  'active_contacts',
  'ai_tokens_in',
  'ai_tokens_out',
  'campaign_sends',
];

export const METRIC_LIMIT_FIELDS = {
  messages_inbound: 'monthlyInboundMessagesLimit',
  messages_outbound: 'monthlyOutboundMessagesLimit',
  active_contacts: 'monthlyActiveContactsLimit',
  ai_tokens_in: 'monthlyAiTokensInLimit',
  ai_tokens_out: 'monthlyAiTokensOutLimit',
  campaign_sends: 'monthlyCampaignSendsLimit',
} as const satisfies Record<UsageMetric, keyof OrganizationConfig>;

export type UsageEventInput = {
  metric: UsageMetric;
  quantity?: bigint | number;
  subjectId?: string | null;
  occurredAt?: Date;
};

export type UsageItem = {
  metric: UsageMetric;
  current: string;
  limit: string | null;
  percent: number | null;
  state: 'normal' | 'warning' | 'exceeded' | 'unlimited';
};

export function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

export function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function monthRange(reference = new Date()): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1)),
    end: new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1)),
  };
}

export async function recordUsageEvents(events: UsageEventInput[]): Promise<void> {
  if (!events.length) return;
  const organizationId = getTenantId();
  await prisma.usageEvent.createMany({
    data: events.map((event) => ({
      organizationId,
      metric: event.metric,
      quantity: BigInt(event.quantity ?? 1),
      subjectId: event.subjectId ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    })),
  });
}

export async function recordMessageUsage(
  direction: 'INBOUND' | 'OUTBOUND',
  contactId: string | null,
  messageSubjectId?: string | null,
  occurredAt?: Date,
): Promise<void> {
  const events: UsageEventInput[] = [
    {
      metric: direction === 'INBOUND' ? 'messages_inbound' : 'messages_outbound',
      subjectId: messageSubjectId,
      occurredAt,
    },
  ];
  if (contactId) {
    events.push({ metric: 'active_contacts', subjectId: contactId, occurredAt });
  }
  await recordUsageEvents(events);
}

/**
 * Monthly Active Contacts (MAC) is the count of DISTINCT contacts with at least
 * one inbound OR outbound message in the billing month for this organization.
 * It is not total contacts, conversations, or messages.
 */
export async function countMonthlyActiveContacts(reference = new Date()): Promise<bigint> {
  const { start, end } = monthRange(reference);
  const rows = await prisma.usageEvent.findMany({
    where: {
      metric: 'active_contacts',
      occurredAt: { gte: start, lt: end },
      subjectId: { not: null },
    },
    distinct: ['subjectId'],
    select: { subjectId: true },
  });
  return BigInt(rows.length);
}

export async function getMetricUsage(
  metric: UsageMetric,
  reference = new Date(),
): Promise<bigint> {
  if (metric === 'active_contacts') return countMonthlyActiveContacts(reference);
  const { start, end } = monthRange(reference);
  const aggregate = await prisma.usageEvent.aggregate({
    where: { metric, occurredAt: { gte: start, lt: end } },
    _sum: { quantity: true },
  });
  return aggregate._sum.quantity ?? 0n;
}

export function configuredLimit(
  config: OrganizationConfig,
  metric: UsageMetric,
): bigint | null {
  const raw = config[METRIC_LIMIT_FIELDS[metric]];
  if (raw === null || raw === undefined) return null;
  return BigInt(raw as number | bigint);
}

function usageState(current: bigint, limit: bigint | null): UsageItem['state'] {
  if (limit === null) return 'unlimited';
  if (current >= limit) return 'exceeded';
  if (limit > 0n && current * 100n >= limit * 80n) return 'warning';
  return 'normal';
}

export async function getCurrentUsage(reference = new Date()): Promise<{
  period: { start: string; end: string };
  items: UsageItem[];
}> {
  const organizationId = getTenantId();
  const config = await getOrganizationConfig(organizationId);
  const values = await Promise.all(USAGE_METRICS.map((metric) => getMetricUsage(metric, reference)));
  const { start, end } = monthRange(reference);

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    items: USAGE_METRICS.map((metric, index) => {
      const current = values[index];
      const limit = configuredLimit(config, metric);
      const percent = limit === null
        ? null
        : limit === 0n
          ? 100
          : Math.min(100, Number((current * 10_000n) / limit) / 100);
      return {
        metric,
        current: current.toString(),
        limit: limit?.toString() ?? null,
        percent,
        state: usageState(current, limit),
      };
    }),
  };
}
