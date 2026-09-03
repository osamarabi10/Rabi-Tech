import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { runAsPlatform } from '../../lib/tenant-context';
import logger from '../../lib/logger';
import { auditPlatformScope } from '../../lib/audit';
import {
  DEFAULT_CAMPAIGN_PACING,
  PLAN_CODE_PATTERN,
  PlanCode,
  PlanEntitlements,
  publishKnownPlanCodes,
  publishPlanPricingModels,
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
  // Consistent with the rest of the floor: grants nothing. isPaidPlan reads the
  // published map by code rather than this object, so the value here decides
  // nothing — it is set only because the shape requires it.
  pricingModel: 'FREE',
  // Like pricingModel above, this decides nothing here - the floor grants
  // nothing whatever interval it claims. Set because the shape requires it.
  billingInterval: 'MONTHLY',
  monthlyActiveContactsLimit: 0,
  monthlyOutboundMessagesLimit: 0,
  monthlyCampaignSendsLimit: 0,
  customFieldsLimit: 0,
  usersLimit: 0,
  maxWorkspaces: 1,
  // capability by failing to resolve.
  // organization whose edition cannot be resolved must not acquire a paid
  // The floor grants the default workspace and nothing past it: an
  workflowsLimit: 0,
  monthlyAiTokensInLimit: BigInt(0),
  monthlyAiTokensOutLimit: BigInt(0),
  campaignRateMax: 1,
  campaignRateDurationMs: 2_000,
  autoProvisionGateway: false,
  customDomain: false,
  whiteLabel: false,
  maskContactDetails: false,
  // Empty, not OPENWA. The floor grants nothing, and a channel the process
  // cannot confirm an edition allows is one it must not let a tenant connect.
  allowedChannels: [],
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

/**
 * Shape a database row into the same object the constant provides.
 *
 * Exported so the consequence preview can build its hypothetical edition with
 * the SAME mapper the live cache uses. A preview that converted rows its own
 * way would drift from the catalogue the first time a column was added, and
 * would drift silently, because both sides would still typecheck.
 */
export function rowToEdition(row: {
  code: string;
  name: string;
  monthlyPriceCents: number;
  pricingModel: PlanEntitlements['pricingModel'];
  billingInterval: PlanEntitlements['billingInterval'];
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  maxWorkspaces: number | null;
  workflowsLimit: number | null;
  monthlyAiTokensInLimit: bigint | null;
  monthlyAiTokensOutLimit: bigint | null;
  campaignRateMax: number | null;
  campaignRateDurationMs: number | null;
  autoProvisionGateway: boolean;
  customDomain: boolean;
  whiteLabel: boolean;
  maskContactDetails: boolean;
  allowedChannels: string[];
}): PlanEntitlements {
  const code = String(row.code ?? '').trim().toUpperCase();
  if (!PLAN_CODE_PATTERN.test(code)) {
    throw new Error(`Catalogue row has a malformed plan code: ${JSON.stringify(row.code)}`);
  }
  return {
    code,
    name: row.name,
    monthlyPriceCents: row.monthlyPriceCents,
    pricingModel: row.pricingModel,
    billingInterval: row.billingInterval,
    monthlyActiveContactsLimit: row.monthlyActiveContactsLimit,
    monthlyOutboundMessagesLimit: row.monthlyOutboundMessagesLimit,
    monthlyCampaignSendsLimit: row.monthlyCampaignSendsLimit,
    customFieldsLimit: row.customFieldsLimit,
    usersLimit: row.usersLimit,
    maxWorkspaces: row.maxWorkspaces,
    workflowsLimit: row.workflowsLimit,
    monthlyAiTokensInLimit: row.monthlyAiTokensInLimit,
    monthlyAiTokensOutLimit: row.monthlyAiTokensOutLimit,
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
    allowedChannels: row.allowedChannels,
  };
}

/**
 * Load the catalogue into the cache. Safe to call at any time; a failure leaves
 * the previous cache in place rather than emptying it, because serving slightly
 * stale limits beats serving none.
 */
/**
 * Columns a schedule is allowed to write.
 *
 * The stored payload was validated by the same code the immediate PATCH uses,
 * so its values are already sound. This is a narrower question: which columns a
 * dated change may touch at all. It is a policy list rather than a second copy
 * of the validation — `code` and `archivedAt` are absent because scheduling an
 * edition's identity or its withdrawal are different acts with different
 * consequences, and neither should arrive through a price change's back door.
 */
const SCHEDULABLE_COLUMNS = new Set([
  'name', 'monthlyPriceCents', 'pricingModel', 'billingInterval', 'currency',
  'monthlyActiveContactsLimit', 'monthlyOutboundMessagesLimit', 'monthlyCampaignSendsLimit',
  'customFieldsLimit', 'usersLimit', 'workflowsLimit',
  'maxWorkspaces',
  'monthlyAiTokensInLimit', 'monthlyAiTokensOutLimit',
  'campaignRateMax', 'campaignRateDurationMs',
  'autoProvisionGateway', 'customDomain', 'whiteLabel', 'maskContactDetails',
  'allowedChannels', 'isActive', 'sortOrder',
]);

/**
 * Apply any schedule whose time has passed, writing the values into the row.
 *
 * Runs at the top of every refresh rather than on a scheduler of its own: this
 * is already the thing that runs on a timer and already owns the catalogue, and
 * a second timer would be a second thing to notice had stopped.
 *
 * **Concurrency matters here.** Every process refreshes on its own interval, so
 * several can reach a due schedule at the same moment. The write is a
 * conditional updateMany still guarded on `scheduledFrom` being set: whichever
 * process gets there first clears it, and every other one matches zero rows and
 * does nothing. Only the winner writes the audit entry, so a dated change
 * leaves exactly one record however many processes are running.
 *
 * A dated change produces the same durable record as an immediate one - the
 * point of E6 is that the catalogue's history is readable, and a change that
 * applied itself while nobody was looking is the one most in need of a record.
 */
async function applyDueSchedules(now: Date): Promise<number> {
  const due = await prisma.plan.findMany({
    where: { scheduledFrom: { not: null, lte: now } },
    select: { code: true, scheduledChanges: true, scheduledFrom: true },
  });
  if (due.length === 0) return 0;

  let applied = 0;
  for (const row of due) {
    const raw = (row.scheduledChanges ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (SCHEDULABLE_COLUMNS.has(key)) data[key] = value;
    }

    const before = await prisma.plan.findUnique({ where: { code: row.code } });

    const result = await prisma.plan.updateMany({
      // Still guarded on scheduledFrom: this is what makes the race safe.
      where: { code: row.code, scheduledFrom: { not: null, lte: now } },
      data: { ...data, scheduledChanges: Prisma.DbNull, scheduledFrom: null },
    });
    if (result.count === 0) continue;

    applied += 1;
    const after = await prisma.plan.findUnique({ where: { code: row.code } });
    /*
      Through lib/audit.ts rather than touching platformAuditLog directly. The
      tenancy harness enforces that boundary: PlatformAuditLog is in the
      extension's PLATFORM_MODELS, so under ORGANIZATION scope nothing is
      injected and a tenant-scoped read would return every subscriber's
      commercial history. billing/ is not platform code, and the check is right
      to say so.

      No actor: nobody was present. The person who *scheduled* it is on the
      platform.edition.scheduled row; naming them here would put a name against
      an action they did not take.
    */
    await auditPlatformScope(`edition ${row.code} scheduled change applied`, {
      action: 'platform.edition.scheduled_applied',
      targetEditionCode: row.code,
      beforeState: before,
      afterState: after,
    });
    logger.info('Applied a scheduled edition change', {
      code: row.code, scheduledFrom: row.scheduledFrom?.toISOString(), fields: Object.keys(data),
    });
  }
  return applied;
}

export async function refreshEditions(): Promise<number> {
  try {
    /*
      Before the catalogue is read, not after: a schedule due five seconds ago
      must be in the rows this refresh loads, or the cache serves the old values
      for another whole interval and the change appears to have been ignored.

      Its own try/catch. A schedule that cannot be applied must not take the
      catalogue refresh down with it - serving the current values is always
      better than serving none, and the floor is what a failed refresh falls to.
    */
    try {
      /*
        Platform scope, explicitly, for the same reason the catalogue read below
        needs it: this runs on a timer owned by no request, and the tenancy
        extension is fail-closed on a query with no scope at all. Without the
        wrapper every scheduled change would throw on the tick that should have
        applied it, the catch below would turn that into one log line, and the
        change would simply never happen.

        This is the second time that mistake has been made in this file — the
        original refresh had it, and its comment says so. It was caught here by
        the harness rather than in production, and only because the harness
        checks the boundary statically: my own probe wrapped the call itself and
        so proved nothing about how the timer invokes it.
      */
      await runAsPlatform('apply-scheduled-editions', () => applyDueSchedules(new Date()));
    } catch (error) {
      logger.error('Failed to apply scheduled edition changes; serving current values', {
        error: String(error),
      });
    }
    // Platform scope, explicitly. Plan is in PLATFORM_MODELS so no
    // organizationId is injected, but the extension is fail-closed on a query
    // with NO scope at all - and the background refresh runs on a timer, owned
    // by no request. Without this the refresh threw on every tick, the catch
    // below logged it, and getEdition fell back to the constant forever: the
    // catalogue was owner-editable in the database and inert in the process.
    //
    // Every edition, not only the active ones. isActive decides what is
    // offered; resolution must still work for subscribers on a retired plan.
    //
    // Ordered, because the cache preserves this order and getEditions() hands
    // it straight to callers that read position as the ladder - channelRefusal
    // names "the cheapest edition that would allow the kind" by taking the
    // first match. Unordered, findMany returns whatever the planner happens to
    // give, so that claim was being decided by row layout. Still every row:
    // ordering is not filtering.
    const rows = await runAsPlatform('refresh-edition-catalogue', () =>
      prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }));
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
      // The published set, and only the published set. The findMany above is
      // deliberately unfiltered — an archived edition that never enters the
      // cache resolves to RESTRICTED_FLOOR, so its subscribers silently lose
      // everything while every response still returns 200.
      if (row.isActive && !row.archivedAt) nextActive.add(row.code);
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
    // isPaidPlan reads this rather than testing the code name, so it must be
    // published from the same swap or the two can disagree about one edition.
    publishPlanPricingModels(
      Array.from(next.entries()).map(([code, edition]) => [code, edition.pricingModel] as const),
    );
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
 * The cheapest published edition that grants something **and is an upgrade**
 * from where the asker already is — or null, when no upgrade would help.
 *
 * ## Why null is often the honest answer
 *
 * The old rule was "name the first edition in ladder order that grants it",
 * which reads as "the cheapest one to buy" and holds for capabilities the
 * ladder grants *upward*: bigger quotas, more seats.
 *
 * It inverts for anything granted *downward*. After the channel narrowing,
 * OPENWA is allowed by FREE and STANDARD only, so the first granting edition is
 * FREE — and an ENTERPRISE subscriber refused OpenWA was told to upgrade to
 * Free. The refusal was correct and the advice was nonsense, which is worse
 * than saying nothing: it invites a customer to act on it, and every other
 * upgrade prompt is generated by this same mechanism, so one visibly absurd
 * suggestion discredits all of them.
 *
 * So an upgrade is only named when it is genuinely above the asker. When the
 * asker already outranks every edition that grants the thing, no upgrade fixes
 * it and the caller renders the refusal without a suggestion. Every caller
 * already branches on null — verified, not assumed.
 *
 * An asker not on the published ladder (retired or archived edition) has no
 * comparable position, so the cheapest granting edition is named as before:
 * they have to move regardless, and a suggestion is more use than silence.
 */
export function cheapestUpgradeGranting(
  askingCode: PlanCode,
  grants: (edition: PlanEntitlements) => boolean,
): string | null {
  const ladder = getEditions();
  const grantingIndex = ladder.findIndex(grants);
  if (grantingIndex < 0) return null;

  const askingIndex = ladder.findIndex((edition) => edition.code === askingCode);
  if (askingIndex >= 0 && grantingIndex <= askingIndex) return null;

  return ladder[grantingIndex].name;
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
