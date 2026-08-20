import { UsageMetric } from '@prisma/client';
import { getTenantId, runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { prisma } from '../../prisma';
import {
  USAGE_METRICS,
  addUtcDays,
  configuredLimit,
  monthRange,
  utcDay,
} from './usage.service';

export function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid date "${value}"; expected YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date "${value}"`);
  }
  return date;
}

export async function rollupOrganizationDate(inputDate: Date): Promise<Record<UsageMetric, bigint>> {
  const organizationId = getTenantId();
  const date = utcDay(inputDate);
  const nextDate = addUtcDays(date, 1);
  const { start: monthStart } = monthRange(date);

  const [dailySums, activeSubjects] = await Promise.all([
    prisma.usageEvent.groupBy({
      by: ['metric'],
      where: {
        metric: { not: 'active_contacts' },
        occurredAt: { gte: date, lt: nextDate },
      },
      _sum: { quantity: true },
    }),
    prisma.usageEvent.findMany({
      where: {
        metric: 'active_contacts',
        subjectId: { not: null },
        occurredAt: { gte: monthStart, lt: nextDate },
      },
      distinct: ['subjectId'],
      select: { subjectId: true },
    }),
  ]);

  const values = Object.fromEntries(
    USAGE_METRICS.map((metric) => [metric, 0n]),
  ) as Record<UsageMetric, bigint>;
  for (const row of dailySums) values[row.metric] = row._sum.quantity ?? 0n;
  values.active_contacts = BigInt(activeSubjects.length);

  await Promise.all(USAGE_METRICS.map((metric) =>
    prisma.platformDailyMetric.upsert({
      where: { organizationId_date_metric: { organizationId, date, metric } },
      create: { organizationId, date, metric, value: values[metric] },
      update: { value: values[metric] },
    })
  ));

  return values;
}

async function organizationIdsForRollup(reason: string): Promise<string[]> {
  return runAsPlatform(reason, async () => {
    const rows = await prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    return rows.map((row) => row.id);
  });
}

export async function backfillUsageRollups(start: Date, end: Date): Promise<number> {
  const first = utcDay(start);
  const last = utcDay(end);
  if (first > last) throw new Error('Usage rollup start date must be on or before end date');

  const organizations = await organizationIdsForRollup(
    `usage-rollup:backfill:${first.toISOString().slice(0, 10)}:${last.toISOString().slice(0, 10)}`,
  );
  let completed = 0;
  for (const organizationId of organizations) {
    for (let date = first; date <= last; date = addUtcDays(date, 1)) {
      await runAsOrganization(organizationId, () => rollupOrganizationDate(date));
      completed += 1;
    }
  }
  return completed;
}

export async function organizationsForNightlyRollup(date: Date): Promise<string[]> {
  return organizationIdsForRollup(`usage-rollup:nightly:${utcDay(date).toISOString().slice(0, 10)}`);
}

export async function getPlatformMonthlyRollupUsage(
  organizationId: string,
  reference = new Date(),
) {
  const { start, end } = monthRange(reference);
  const [dailySums, latestMac, config] = await Promise.all([
    prisma.platformDailyMetric.groupBy({
      by: ['metric'],
      where: {
        organizationId,
        metric: { not: 'active_contacts' },
        date: { gte: start, lt: end },
      },
      _sum: { value: true },
    }),
    prisma.platformDailyMetric.findFirst({
      where: { organizationId, metric: 'active_contacts', date: { gte: start, lt: end } },
      orderBy: { date: 'desc' },
      select: { value: true, date: true },
    }),
    prisma.organizationConfig.findUnique({ where: { organizationId } }),
  ]);

  const values = Object.fromEntries(
    USAGE_METRICS.map((metric) => [metric, 0n]),
  ) as Record<UsageMetric, bigint>;
  for (const row of dailySums) values[row.metric] = row._sum.value ?? 0n;
  values.active_contacts = latestMac?.value ?? 0n;

  return {
    period: { start: start.toISOString(), end: end.toISOString() },
    asOf: latestMac?.date.toISOString() ?? null,
    items: USAGE_METRICS.map((metric) => ({
      metric,
      current: values[metric].toString(),
      limit: config ? configuredLimit(config, metric)?.toString() ?? null : null,
    })),
  };
}
