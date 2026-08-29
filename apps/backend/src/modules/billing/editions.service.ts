import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { PLAN_ENTITLEMENTS, PlanCode, PlanEntitlements, normalizePlanCode } from './plans';

/**
 * The edition catalogue, read from the database and held in memory.
 *
 * ## Why this is synchronous
 *
 * The nineteen call sites this replaces read `PLAN_ENTITLEMENTS[code]`
 * synchronously, and two of them are hot: `campaign.worker.ts` consults the
 * rate for every send, and `entitlements.resolver.ts` runs on every quota
 * check. Turning those into awaited database reads would put a query on the
 * send path to answer a question whose answer changes a few times a year.
 *
 * So the accessor stays synchronous and reads a cache that a background
 * refresh keeps warm. The call sites change by one identifier and keep their
 * shape, which is what makes a nineteen-site migration reviewable.
 *
 * ## Why the cache never expires into the constant
 *
 * A TTL that empties the cache would mean that thirty seconds after the last
 * refresh every enforcement site silently reverts to the compiled-in defaults —
 * an owner's price change would work, then stop working, then work again. The
 * cache is instead *replaced* by a periodic refresh and never emptied. The
 * constant is the fallback for exactly one situation: the window before the
 * first load completes at boot.
 *
 * ## What the constant is now
 *
 * Seed source and boot fallback. It is no longer the source of truth, and it
 * must not be read directly outside this file and the seeder — the harness
 * asserts the database matches it field for field, so the two agreeing is a
 * checked property rather than a hope.
 */

const REFRESH_INTERVAL_MS = Number(process.env.EDITION_REFRESH_MS || 30_000);

let cache: Map<string, PlanEntitlements> | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

/** Shape a database row into the same object the constant provides. */
function rowToEdition(row: {
  code: string;
  name: string;
  monthlyPriceCents: number;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  workflowsLimit: number | null;
  campaignRateMax: number | null;
  campaignRateDurationMs: number | null;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
  maskContactDetails: boolean;
}): PlanEntitlements {
  const fallback = PLAN_ENTITLEMENTS[normalizePlanCode(row.code)];
  return {
    code: row.code as PlanCode,
    name: row.name,
    monthlyPriceCents: row.monthlyPriceCents,
    monthlyActiveContactsLimit: row.monthlyActiveContactsLimit,
    monthlyOutboundMessagesLimit: row.monthlyOutboundMessagesLimit,
    monthlyCampaignSendsLimit: row.monthlyCampaignSendsLimit,
    customFieldsLimit: row.customFieldsLimit,
    usersLimit: row.usersLimit,
    workflowsLimit: row.workflowsLimit,
    // Rate fields are nullable in the catalogue but not optional in behaviour:
    // a null pace would divide by nothing on the send path. Fall back to the
    // constant's pacing rather than inventing a number here.
    campaignRateMax: row.campaignRateMax ?? fallback.campaignRateMax,
    campaignRateDurationMs: row.campaignRateDurationMs ?? fallback.campaignRateDurationMs,
    autoProvisionGateway: row.autoProvisionGateway,
    customDomain: row.customDomain,
    whiteLabel: row.whiteLabel,
    maskContactDetails: row.maskContactDetails,
  };
}

/**
 * Load the catalogue into the cache. Safe to call at any time; a failure leaves
 * the previous cache in place rather than emptying it, because serving slightly
 * stale limits beats serving none.
 */
export async function refreshEditions(): Promise<number> {
  try {
    const rows = await prisma.plan.findMany({ where: { isActive: true } });
    if (rows.length === 0) {
      logger.warn('Edition catalogue is empty; keeping previous values');
      return cache?.size ?? 0;
    }
    const next = new Map<string, PlanEntitlements>();
    for (const row of rows) {
      try {
        next.set(row.code, rowToEdition(row));
      } catch {
        // An edition the code has never heard of cannot be normalized. Skip it
        // rather than failing the whole refresh: one bad row must not take the
        // catalogue down.
        logger.warn('Skipping unknown edition code in catalogue', { code: row.code });
      }
    }
    cache = next;
    return next.size;
  } catch (error) {
    logger.error('Failed to refresh edition catalogue; keeping previous values', {
      error: String(error),
    });
    return cache?.size ?? 0;
  }
}

/** Boot: load once, then keep warm. Idempotent. */
export function startEditionRefresh(): void {
  if (refreshTimer) return;
  void refreshEditions();
  refreshTimer = setInterval(() => void refreshEditions(), REFRESH_INTERVAL_MS);
  // Never hold the process open for a config refresh.
  refreshTimer.unref?.();
}

export function stopEditionRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * The one read path for edition entitlements.
 *
 * Falls back to the constant only before the first load completes, or for a
 * code the catalogue does not carry — which the harness asserts cannot happen.
 */
export function getEdition(code: PlanCode): PlanEntitlements {
  return cache?.get(code) ?? PLAN_ENTITLEMENTS[code];
}

/** The published catalogue, in display order. */
export function getEditions(): PlanEntitlements[] {
  if (!cache) return Object.values(PLAN_ENTITLEMENTS);
  return Array.from(cache.values());
}

/** Test seam: forget everything and fall back to the constant. */
export function resetEditionCacheForTests(): void {
  cache = null;
}
