import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';

/**
 * Hourly analytics rollup.
 *
 * ## Why a rollup exists at all
 *
 * The staffing question — "which hours are busy?" — needs messages bucketed by
 * hour-of-day. Postgres does that in one `date_trunc`, but Prisma cannot
 * express `date_trunc` in `groupBy`, and `$queryRaw` bypasses the tenancy
 * extension, which is the one thing this codebase does not do. The remaining
 * option, loading every timestamp in the range and bucketing in JS, is a table
 * scan on the largest table in the schema on every page load.
 *
 * So the buckets are materialised. Each hour is counted over an indexed
 * `timestamp` range — the counts run in Postgres and return integers — and the
 * report then reads one row per hour instead of one row per message.
 *
 * ## Why hours are recomputed rather than incremented
 *
 * An incremental counter has to be perfectly consistent with every write path,
 * including retried BullMQ jobs, and a double-count is invisible once it lands.
 * Recomputing a bounded window is idempotent by construction: running it twice
 * produces the same row, and a bad hour heals on the next pass.
 *
 * The trailing window matters for a second reason: campaign delivery and read
 * acks arrive minutes to hours after a send, and a message that failed is
 * marked `FAILED` after the fact. An hour is not final when it ends.
 */

/** Hours recomputed on every scheduled pass, counting back from the current hour. */
export const ROLLUP_TRAILING_HOURS = 6;

/** Ceiling on a single backfill, so one call cannot walk the whole table. */
export const MAX_BACKFILL_HOURS = 24 * 120;

export type HourBucket = {
  hourStart: Date;
  inbound: number;
  outbound: number;
  automated: number;
  failed: number;
  conversationsCreated: number;
  conversationsResolved: number;
};

/** Truncate to the top of the hour, in UTC. */
export function floorToHour(at: Date): Date {
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function hoursBetween(from: Date, to: Date): Date[] {
  const hours: Date[] = [];
  let cursor = floorToHour(from);
  const end = floorToHour(to);
  while (cursor <= end && hours.length < MAX_BACKFILL_HOURS) {
    hours.push(new Date(cursor));
    cursor = new Date(cursor.getTime() + 3600_000);
  }
  return hours;
}

/**
 * Count one hour. Must run inside an organization scope — every query here is
 * scoped by the extension, so the counts are tenant-local without saying so.
 */
async function countHour(hourStart: Date): Promise<HourBucket> {
  const hourEnd = new Date(hourStart.getTime() + 3600_000);
  // Half-open [start, end) — the idiom used throughout the usage module. A
  // closed range double-counts anything landing exactly on the boundary.
  const within = { gte: hourStart, lt: hourEnd };

  const [inbound, outbound, automated, failed, conversationsCreated, conversationsResolved] =
    await Promise.all([
      prisma.message.count({ where: { timestamp: within, direction: 'INBOUND' } }),
      prisma.message.count({
        where: { timestamp: within, direction: 'OUTBOUND', isInternal: false },
      }),
      prisma.message.count({
        where: { timestamp: within, direction: 'OUTBOUND', isAuto: true, isInternal: false },
      }),
      prisma.message.count({ where: { timestamp: within, status: 'FAILED' } }),
      prisma.conversation.count({ where: { createdAt: within } }),
      prisma.conversation.count({ where: { resolvedAt: within } }),
    ]);

  return {
    hourStart,
    inbound,
    outbound,
    automated,
    failed,
    conversationsCreated,
    conversationsResolved,
  };
}

/**
 * Recompute and persist the given hours for one organization.
 *
 * Returns the number of buckets written. Runs the hours in series: a rollup is
 * background work and must never contend with the inbox for connections.
 */
export async function recomputeHours(organizationId: string, hours: Date[]): Promise<number> {
  if (hours.length === 0) return 0;

  return runAsOrganization(organizationId, async () => {
    let written = 0;
    for (const hourStart of hours) {
      const bucket = await countHour(hourStart);
      const { hourStart: _ignored, ...counts } = bucket;
      await prisma.analyticsHourly.upsert({
        where: { organizationId_hourStart: { organizationId, hourStart } },
        // `organizationId` is spelled out even though the tenancy extension
        // injects it, because the generated create input requires it.
        create: { organizationId, hourStart, ...counts, computedAt: new Date() },
        update: { ...counts, computedAt: new Date() },
      });
      written += 1;
    }
    return written;
  });
}

/** Recompute the trailing window for one organization. */
export async function rollupRecent(
  organizationId: string,
  trailingHours = ROLLUP_TRAILING_HOURS,
): Promise<number> {
  const now = new Date();
  const from = new Date(now.getTime() - (trailingHours - 1) * 3600_000);
  return recomputeHours(organizationId, hoursBetween(from, now));
}

/** Rebuild a longer window, e.g. after enabling reporting on an existing tenant. */
export async function backfillOrganization(organizationId: string, days: number): Promise<number> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 3600_000);
  return recomputeHours(organizationId, hoursBetween(from, now));
}

/**
 * Sweep every active organization.
 *
 * One platform scope for the whole sweep, then an organization scope per
 * tenant — the pattern the gateway health monitor uses, and for the same
 * reason: a scope per organization would write a `PlatformAuditLog` row per
 * organization per run.
 */
export async function rollupSweep(trailingHours = ROLLUP_TRAILING_HOURS): Promise<{
  organizations: number;
  buckets: number;
}> {
  return runAsPlatform('analytics-rollup:sweep', async () => {
    const organizations = await prisma.organization.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    let buckets = 0;
    for (const organization of organizations) {
      try {
        buckets += await rollupRecent(organization.id, trailingHours);
      } catch (err) {
        // One tenant's failure must not stop the sweep — the next pass
        // recomputes the same window anyway.
        logger.error('analytics rollup failed for organization', {
          organizationId: organization.id,
          error: String(err),
        });
      }
    }

    return { organizations: organizations.length, buckets };
  });
}
