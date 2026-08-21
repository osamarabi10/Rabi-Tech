import { prisma } from '../../prisma';
import type { Period } from './reporting.service';

/**
 * Webhook health reporting.
 *
 * Split by direction throughout, because the two answer different questions and
 * averaging them together hides the one that matters. Outbound failing means a
 * subscriber's endpoint is down. Inbound failing — or going silent — means the
 * platform has stopped receiving WhatsApp traffic at all, which is the outage
 * customers notice first and the one the gateway runbook is written about.
 */

function within(period: Period) {
  return { gte: period.from, lt: period.to };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

/**
 * Latency needs individual durations, which no Prisma aggregate produces. Capped
 * so a busy tenant cannot turn one page load into a scan of the largest table in
 * the schema; the response says when the cap bit.
 */
const MAX_LATENCY_SAMPLE = 20000;

export type DirectionHealth = {
  direction: 'INBOUND' | 'OUTBOUND';
  total: number;
  failed: number;
  successRatePct: number | null;
  medianLatencyMs: number | null;
  p90LatencyMs: number | null;
  latencySampled: number;
  latencyTruncated: boolean;
};

export type WebhookFailure = {
  id: string;
  direction: string;
  webhookId: string;
  eventType: string;
  targetHost: string | null;
  statusCode: number | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: Date;
};

export type EndpointRow = {
  webhookId: string;
  targetHost: string | null;
  total: number;
  failed: number;
  successRatePct: number | null;
};

export type WebhookReport = {
  directions: DirectionHealth[];
  endpoints: EndpointRow[];
  failures: WebhookFailure[];
  retentionDays: number;
};

async function directionHealth(
  period: Period,
  direction: 'INBOUND' | 'OUTBOUND',
): Promise<DirectionHealth> {
  const [total, failed, latencies] = await Promise.all([
    prisma.webhookDeliveryLog.count({ where: { direction, createdAt: within(period) } }),
    prisma.webhookDeliveryLog.count({
      where: { direction, ok: false, createdAt: within(period) },
    }),
    prisma.webhookDeliveryLog.findMany({
      where: { direction, createdAt: within(period) },
      select: { durationMs: true },
      take: MAX_LATENCY_SAMPLE + 1,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const sample = latencies.slice(0, MAX_LATENCY_SAMPLE).map((r) => r.durationMs).sort((a, b) => a - b);

  return {
    direction,
    total,
    failed,
    // Null rather than 100%: no deliveries is not a perfect record, and showing
    // a green 100% for a gateway that has gone completely silent would hide
    // exactly the outage this view exists to catch.
    successRatePct: total === 0 ? null : Math.round(((total - failed) / total) * 1000) / 10,
    medianLatencyMs: percentile(sample, 0.5),
    p90LatencyMs: percentile(sample, 0.9),
    latencySampled: sample.length,
    latencyTruncated: latencies.length > MAX_LATENCY_SAMPLE,
  };
}

export async function webhookReport(
  period: Period,
  retentionDays: number,
): Promise<WebhookReport> {
  const [inbound, outbound, grouped, failedGrouped, failures] = await Promise.all([
    directionHealth(period, 'INBOUND'),
    directionHealth(period, 'OUTBOUND'),
    prisma.webhookDeliveryLog.groupBy({
      by: ['webhookId', 'targetHost'],
      where: { createdAt: within(period) },
      _count: { _all: true },
    }),
    prisma.webhookDeliveryLog.groupBy({
      by: ['webhookId'],
      where: { createdAt: within(period), ok: false },
      _count: { _all: true },
    }),
    // The failures list is the actionable half of this page: a rate tells you
    // something is wrong, a payload tells you what.
    prisma.webhookDeliveryLog.findMany({
      where: { createdAt: within(period), ok: false },
      select: {
        id: true,
        direction: true,
        webhookId: true,
        eventType: true,
        targetHost: true,
        statusCode: true,
        errorMessage: true,
        durationMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
    }),
  ]);

  const failedByWebhook = new Map(
    failedGrouped.map((row) => [row.webhookId, row._count._all]),
  );

  const endpoints: EndpointRow[] = grouped
    .map((row) => {
      const total = row._count._all;
      const failed = failedByWebhook.get(row.webhookId) ?? 0;
      return {
        webhookId: row.webhookId,
        targetHost: row.targetHost,
        total,
        failed,
        successRatePct: total === 0 ? null : Math.round(((total - failed) / total) * 1000) / 10,
      };
    })
    // Worst first: an endpoint with failures is the reason anyone opened this.
    .sort((a, b) => b.failed - a.failed || b.total - a.total)
    .slice(0, 50);

  return {
    directions: [inbound, outbound],
    endpoints,
    failures,
    retentionDays,
  };
}
