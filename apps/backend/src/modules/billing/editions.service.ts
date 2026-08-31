import { prisma } from '../../prisma';
import { runAsPlatform } from '../../lib/tenant-context';
import logger from '../../lib/logger';
import {
  DEFAULT_CAMPAIGN_PACING,
  PLAN_CODE_PATTERN,
  PlanCode,
  PlanEntitlements,
  publishKnownPlanCodes,
} from './plans';

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
 * ## Why the cache expires into a floor, not into the constant
 *
 * This reasoning was inverted deliberately; the previous version of this
 * comment argued the opposite, and it was right at the time.
 *
 * The old argument: a TTL that empties the cache would mean every enforcement
 * site silently reverts to the compiled-in defaults thirty seconds after the
 * last refresh — an owner's price change would work, then stop working, then
 * work again. That argument was about protecting the *constant* as the
 * fallback, and it held while the constant was the fallback.
 *
 * The constant is no longer a fallback, so the argument no longer applies. What
 * replaces it is a floor: if the catalogue has not loaded successfully for
 * longer than STALE_AFTER_MS, reads return RESTRICTED_FLOOR rather than
 * whatever the cache last held. Serving indefinitely from a cache nobody can
 * refresh is not availability, it is confidence without evidence — and the
 * thing being answered is what a paying customer is allowed to do.
 *
 * The threshold exists so a database blip does not downgrade anyone. Missing
 * one refresh is normal; missing twenty is a fault.
 *
 * ## What the constant is now
 *
 * **Seed source only, and this file no longer imports it at all.** The harness
 * asserts the database matches it field for field, so the two agreeing is a
 * checked property rather than a hope — but at runtime the database is the
 * only answer, and if the database cannot be reached the answer is the floor.
 *
 * That last dependency was `rowToEdition` reading the constant by code for a
 * campaign-pacing default. It had to go: an edition the constant has never
 * heard of is exactly what the catalogue now has to be able to carry, and
 * looking it up there would have thrown on the first edition anyone created.
 *
 * ## What validates a code now
 *
 * Format, here, and membership of this cache. After every successful refresh
 * the loaded codes are published to `normalizePlanCode` via
 * `publishKnownPlanCodes`, so the gate that used to test membership of the
 * constant tests membership of the database instead. The direction of the
 * dependency matters: plans.ts never imports this file, because a cycle
 * between them would resolve differently at boot than under the harness.
 */

const REFRESH_INTERVAL_MS = Number(process.env.EDITION_REFRESH_MS || 30_000);

/**
 * How long a cache may go unrefreshed before reads fall to the floor.
 *
 * Ten minutes, which at the default thirty-second interval is twenty
 * consecutive failed refreshes. The two ends of the range are what set it: too
 * short and a database failover downgrades every customer for the length of
 * the blip; too long and a permanently broken catalogue keeps answering
 * confidently for hours. Twenty consecutive failures is not a blip.
 *
 * Overridable because the right number depends on how long a database outage
 * lasts here, which nobody knows yet. If it is ever set in an environment,
 * it must be listed explicitly in docker-compose.yml — the backend service
 * enumerates its environment one line at a time, so anything missing silently
 * takes this default inside the container.
 */
const STALE_AFTER_MS = Number(process.env.EDITION_STALE_AFTER_MS || 600_000);

/**
 * What every edition read returns when the catalogue is unavailable.
 *
 * Grants nothing and allows nothing. A zero limit is a real zero:
 * normalizeLimit in entitlements.resolver.ts preserves it rather than treating
 * it as falsy, so this denies rather than accidentally reading as unlimited —
 * which is the failure mode a floor exists to prevent.
 *
 * This is deliberately severe. If it is ever reached, a subscriber cannot
 * send, and that is the intended trade: after twenty consecutive failures the
 * process does not know what anyone is entitled to, and quietly guessing in
 * the customer's favour is how a platform gives away what it meant to sell.
 * The threshold, not the floor, is the dial for how tolerant this is.
 *
 * Pacing is the slowest any edition uses, because a floor must not make the
 * send path faster than the real catalogue would have.
 */
const RESTRICTED_FLOOR: PlanEntitlements = {
  code: 'FREE' as PlanCode,
  name: 'Unavailable',
  monthlyPriceCents: 0,
  monthlyActiveContactsLimit: 0,
  monthlyOutboundMessagesLimit: 0,
  monthlyCampaignSendsLimit: 0,
  customFieldsLimit: 0,
  usersLimit: 0,
  workflowsLimit: 0,
  campaignRateMax: 1,
  campaignRateDurationMs: 2_000,
  autoProvisionGateway: false,
  customDomain: false,
  whiteLabel: false,
  maskContactDetails: false,
};

let cache: Map<string, PlanEntitlements> | null = null;
/**
 * When the catalogue last loaded successfully. Null means never — which,
 * after the boot gate, should be unreachable in a serving process.
 */
let lastLoadedAt: number | null = null;
/** Throttles the stale-cache alarm so a sustained outage logs once a minute. */
let lastStaleWarnAt = 0;
/**
 * When each edition was last edited.
 *
 * Kept beside the catalogue because drift detection needs it: an
 * OrganizationConfig written before its edition was last edited diverges for a
 * reason that is not drift. See detectQuotaDrift in billing.service.ts.
 */
let editedAt: Map<string, Date> | null = null;
/**
 * Which editions are still offered.
 *
 * Separate from the cache because deactivating an edition must stop it being
 * *sold*, not stop it *resolving*. Subscribers already on it keep their limits;
 * dropping the row from the cache would silently fall them back to the shipped
 * constant, quietly changing what they are entitled to as a side effect of a
 * pricing-page edit.
 */
let activeCodes: Set<string> | null = null;
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
  const code = String(row.code ?? '').trim().toUpperCase();
  if (!PLAN_CODE_PATTERN.test(code)) {
    throw new Error(`Catalogue row has a malformed plan code: ${JSON.stringify(row.code)}`);
  }
  return {
    code,
    name: row.name,
    monthlyPriceCents: row.monthlyPriceCents,
    monthlyActiveContactsLimit: row.monthlyActiveContactsLimit,
    monthlyOutboundMessagesLimit: row.monthlyOutboundMessagesLimit,
    monthlyCampaignSendsLimit: row.monthlyCampaignSendsLimit,
    customFieldsLimit: row.customFieldsLimit,
    usersLimit: row.usersLimit,
    workflowsLimit: row.workflowsLimit,
    // Rate fields are nullable in the catalogue but not optional in behaviour:
    // a null pace would divide by nothing on the send path. Filled from the
    // slowest shipped pacing rather than from PLAN_ENTITLEMENTS by code, which
    // could not shape an edition the constant had never heard of.
    campaignRateMax: row.campaignRateMax ?? DEFAULT_CAMPAIGN_PACING.max,
    campaignRateDurationMs: row.campaignRateDurationMs ?? DEFAULT_CAMPAIGN_PACING.durationMs,
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
    // Platform scope, explicitly. Plan is in PLATFORM_MODELS so no
    // organizationId is injected, but the extension is fail-closed on a query
    // with NO scope at all - and the background refresh runs on a timer, owned
    // by no request. Without this the refresh threw on every tick, the catch
    // below logged it, and getEdition fell back to the constant forever: the
    // catalogue was owner-editable in the database and inert in the process.
    //
    // Every edition, not only the active ones. isActive decides what is
    // offered; resolution must still work for subscribers on a retired plan.
    const rows = await runAsPlatform('refresh-edition-catalogue', () =>
      prisma.plan.findMany());
    if (rows.length === 0) {
      logger.warn('Edition catalogue is empty; keeping previous values');
      return cache?.size ?? 0;
    }
    const next = new Map<string, PlanEntitlements>();
    const nextEditedAt = new Map<string, Date>();
    const nextActive = new Set<string>();
    /*
      A row that cannot be loaded fails the whole refresh. It used to be
      skipped with a warning, on the reasoning that one bad row must not take
      the catalogue down — which was defensible while an unknown code meant a
      typo, and became a trap the moment editions could be created.

      A skipped row is an edition that exists in the database, is sellable from
      the console, and never enters the cache. Every read of it misses, and
      since the boot gate landed a miss returns the restricted floor: the
      edition grants nothing at all. The only evidence was one warn line.

      So this is now the loud failure. At boot the gate refuses the port. In a
      running process the outer catch keeps the previous cache and, crucially,
      does not advance lastLoadedAt — so the staleness clock keeps running and
      reads fall to the floor rather than serving a catalogue known to be
      incomplete. Both outcomes are visible without reading logs.
    */
    for (const row of rows) {
      next.set(row.code, rowToEdition(row));
      nextEditedAt.set(row.code, row.updatedAt);
      if (row.isActive) nextActive.add(row.code);
    }
    cache = next;
    editedAt = nextEditedAt;
    activeCodes = nextActive;
    // Only a load that produced rows counts as fresh. The empty-catalogue
    // branch above deliberately does not reach here: a Plan table that has
    // been emptied is a fault, and letting it renew the clock would keep the
    // process serving a cache nothing can correct.
    lastLoadedAt = Date.now();
    // normalizePlanCode validates against this rather than against the shipped
    // constant. Published after the cache is swapped so the two can never
    // disagree about which codes exist.
    publishKnownPlanCodes(next.keys());
    return next.size;
  } catch (error) {
    logger.error('Failed to refresh edition catalogue; keeping previous values', {
      error: String(error),
    });
    return cache?.size ?? 0;
  }
}

/**
 * The boot gate. Load the catalogue or refuse to start.
 *
 * Called before the HTTP server listens. Until this succeeds the process
 * cannot answer what any subscriber is entitled to, and a server that accepts
 * traffic in that state enforces the floor against paying customers while
 * looking healthy to a load balancer.
 *
 * Throws rather than exiting so the caller owns the exit code and the log
 * line. The failure must be legible: the two realistic causes are a database
 * that is not up yet and a Plan table that is empty, and those need different
 * responses from whoever is reading the logs.
 */
export async function loadEditionCatalogueOrThrow(): Promise<number> {
  const size = await refreshEditions();
  if (size === 0 || lastLoadedAt === null) {
    throw new Error(
      'Edition catalogue could not be loaded. The database is unreachable, or the Plan table is empty. ' +
        'Refusing to start: entitlement reads would deny for every subscriber.',
    );
  }
  return size;
}

/** Keep warm after the boot gate has loaded once. Idempotent. */
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
  if (isCatalogueStale()) return RESTRICTED_FLOOR;
  // An unknown code falls to the floor rather than to the constant. The
  // constant would answer for the five codes it happens to carry and throw for
  // any other, which is the worst of both: confident for the old editions,
  // broken for the new ones.
  return cache?.get(code) ?? RESTRICTED_FLOOR;
}

/**
 * Whether reads must fall to the floor.
 *
 * Logs on the way, throttled, because this is the condition where the platform
 * stops enforcing what it sold and nobody would otherwise notice — every
 * response still returns 200.
 */
function isCatalogueStale(): boolean {
  const age = lastLoadedAt === null ? Infinity : Date.now() - lastLoadedAt;
  if (age <= STALE_AFTER_MS) return false;

  const now = Date.now();
  if (now - lastStaleWarnAt > 60_000) {
    lastStaleWarnAt = now;
    logger.error(
      'Edition catalogue is stale; serving the restricted floor. Every entitlement read is now denying.',
      {
        lastLoadedAt: lastLoadedAt === null ? 'never' : new Date(lastLoadedAt).toISOString(),
        staleForMs: age === Infinity ? null : age,
        thresholdMs: STALE_AFTER_MS,
      },
    );
  }
  return true;
}

/**
 * The published catalogue - what is currently offered.
 *
 * Filtered by isActive, unlike getEdition(), which resolves any edition a
 * subscriber is actually on. A retired plan disappears from the price list
 * without changing anything for the people already paying for it.
 */
export function getEditions(): PlanEntitlements[] {
  // Empty, not the constant. This answers "what is on sale", and a process
  // that cannot read the catalogue does not know. Publishing the compiled-in
  // list would advertise prices nobody has confirmed are current — the pricing
  // page showing nothing is a visible fault; showing stale prices is not.
  if (!cache || isCatalogueStale()) return [];
  return Array.from(cache.entries())
    .filter(([code]) => activeCodes?.has(code) ?? true)
    .map(([, edition]) => edition);
}

/**
 * When this edition was last edited, or null if the catalogue has not loaded.
 *
 * Null is not "never edited" - it is "unknown" - and callers must treat it as
 * such rather than as a timestamp at the epoch, which would suppress nothing.
 */
export function getEditionEditedAt(code: PlanCode): Date | null {
  return editedAt?.get(code) ?? null;
}

/** Test seam: forget everything, so reads fall to the restricted floor. */
export function resetEditionCacheForTests(): void {
  cache = null;
  editedAt = null;
  activeCodes = null;
  lastLoadedAt = null;
  lastStaleWarnAt = 0;
}
