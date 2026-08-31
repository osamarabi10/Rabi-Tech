import { SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../prisma';
import { ENTRY_PAID_PLAN_CODE, isPaidPlan, normalizePlanCode, type PlanCode } from './plans';

/**
 * The free trial: full access for a fixed window, then a paywall.
 *
 * ## Resolved at read time, never written
 *
 * There is no job that flips a tenant from trialing to expired, and no database
 * trigger. The expiry is a comparison against `Subscription.trialEndsAt` made
 * when someone asks.
 *
 * This is the same rule `entitlements.resolver.ts` is built on, for the same
 * reason stated there: a sweeper that dies leaves tenants holding access they
 * lost, and read-time expiry cannot fail. It also makes "extend this trial" a
 * single field update with nothing to reconcile afterwards — no status to
 * un-flip, no gateway to un-suspend, no second source of truth to correct.
 *
 * ## Why the existing column rather than a new one
 *
 * `Subscription.trialEndsAt` and the `TRIALING` status were already in the
 * schema and unused, and one query already treats `TRIALING` as an active
 * subscription. A new `Organization.trialExpiresAt` beside them would be a
 * second answer to the same question, free to disagree with the first.
 *
 * ## Null means "not on trial", and that is deliberate
 *
 * Every organization that existed before this feature has `trialEndsAt = null`
 * and must keep working. Absence therefore reads as "no trial applies", never
 * as "expired at the epoch". Fail-open is the correct direction here: locking
 * out a paying subscriber because a column is empty is a far worse failure than
 * letting one lapsed trial through.
 */

const TRIAL_HOURS_KEY = 'billing.trialHours';
const TRIAL_HOURS_DEFAULT = 3;
const TRIAL_HOURS_MAX = 24 * 365;

export type TrialState =
  /** Paid, or an organization from before trials existed. No paywall applies. */
  | { kind: 'none' }
  | { kind: 'active'; endsAt: Date; msRemaining: number }
  | { kind: 'expired'; endsAt: Date };

/**
 * How long a new workspace gets, in hours.
 *
 * A setting rather than a constant: the length of a trial is a commercial
 * decision, and one that gets tuned. Changing it must not require a deploy, and
 * it must not require anyone to edit code to run a partner pilot.
 *
 * Existing trials are unaffected by a change — `trialEndsAt` is stamped once at
 * signup, so shortening the setting cannot retroactively expire someone who is
 * mid-trial.
 */
export async function getTrialHours(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_HOURS_KEY } });
  const parsed = Number(row?.value);
  // A stored value that is not a sane number falls back rather than producing a
  // deadline in the past, which would expire every new signup on arrival.
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > TRIAL_HOURS_MAX) return TRIAL_HOURS_DEFAULT;
  return parsed;
}

export async function setTrialHours(hours: number, updatedBy: string | null): Promise<number> {
  if (!Number.isFinite(hours) || hours <= 0 || hours > TRIAL_HOURS_MAX) {
    throw new Error(`Trial length must be between 0 and ${TRIAL_HOURS_MAX} hours`);
  }
  const value = String(hours);
  await prisma.platformSetting.upsert({
    where: { key: TRIAL_HOURS_KEY },
    create: { key: TRIAL_HOURS_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  return hours;
}

const TRIAL_PLAN_KEY = 'billing.trialPlan';
/** The shared commercial default; see ENTRY_PAID_PLAN_CODE in plans.ts. */
const TRIAL_PLAN_DEFAULT: PlanCode = ENTRY_PAID_PLAN_CODE;

/**
 * Which plan a trial actually runs on.
 *
 * Not FREE. Free grants no gateway (`autoProvisionGateway: false`), one user
 * and no broadcasts — so a trial on Free would be a trial of a product the
 * tenant cannot connect a WhatsApp number to, which is the one thing the
 * trial exists to demonstrate. The entry paid plan is the default.
 *
 * A setting, because which plan you put in the shop window is a commercial
 * decision. A stored value naming an unpaid plan is refused rather than
 * honoured: it would silently produce trials with no QR connection, and the
 * symptom — 'the trial does not work' — would point nowhere near the cause.
 */
export async function getTrialPlanCode(): Promise<PlanCode> {
  const row = await prisma.platformSetting.findUnique({ where: { key: TRIAL_PLAN_KEY } });
  if (!row?.value) return TRIAL_PLAN_DEFAULT;
  const code = normalizePlanCode(row.value);
  return isPaidPlan(code) ? code : TRIAL_PLAN_DEFAULT;
}

export async function setTrialPlanCode(input: string, updatedBy: string | null): Promise<PlanCode> {
  const code = normalizePlanCode(input);
  if (!isPaidPlan(code)) throw new Error('A trial must run on a paid plan, or it grants no WhatsApp connection');
  await prisma.platformSetting.upsert({
    where: { key: TRIAL_PLAN_KEY },
    create: { key: TRIAL_PLAN_KEY, value: code, updatedBy },
    update: { value: code, updatedBy },
  });
  return code;
}

/** The deadline for a workspace created now. */
export async function trialDeadlineFrom(start: Date): Promise<Date> {
  const hours = await getTrialHours();
  return new Date(start.getTime() + hours * 3600_000);
}

type SubscriptionShape = {
  planCode: string;
  status: string;
  trialEndsAt: Date | null;
};

/**
 * Decide the trial state from a subscription that has already been loaded.
 *
 * Split from the query so the middleware — which runs on every request — can
 * pass a row it fetched alongside everything else it needed, instead of paying
 * for a second round trip per call.
 */
export function trialStateOf(
  subscription: SubscriptionShape | null | undefined,
  now: Date = new Date(),
): TrialState {
  if (!subscription) return { kind: 'none' };

  // TRIALING is the marker — never the plan code. A trial runs on a real paid
  // plan, because otherwise it grants no gateway, so the plan cannot be what
  // separates a trial from a paying customer.
  //
  // Converting sets the status to ACTIVE, which ends the trial regardless of
  // what `trialEndsAt` still says. Reading a stale date on a converted
  // subscription would lock out the customer who just paid.
  if (subscription.status !== 'TRIALING') return { kind: 'none' };

  // TRIALING with no deadline is not something this code writes, and it is
  // not a licence to lock anyone out. Absence reads as "no trial applies".
  if (!subscription.trialEndsAt) return { kind: 'none' };

  const endsAt = subscription.trialEndsAt;
  const msRemaining = endsAt.getTime() - now.getTime();
  return msRemaining > 0 ? { kind: 'active', endsAt, msRemaining } : { kind: 'expired', endsAt };
}

/**
 * Subscription statuses that mean the workspace may be used.
 *
 * TRIALING belongs here beside ACTIVE: a trial is the whole product for its
 * window, so anything that gates on "is this subscription live" has to accept
 * both or new signups are locked out of what they just signed up for.
 */
export const ACCESS_GRANTING_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING'];

/** The subscription that decides access, newest first. */
export const TRIAL_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING', 'PAST_DUE', 'MANUAL_REVIEW', 'PENDING'];

export async function resolveTrial(organizationId: string, now: Date = new Date()): Promise<TrialState> {
  const subscription = await prisma.subscription.findFirst({
    where: { organizationId, status: { in: TRIAL_SUBSCRIPTION_STATUSES } },
    orderBy: { createdAt: 'desc' },
    select: { planCode: true, status: true, trialEndsAt: true },
  });
  return trialStateOf(subscription, now);
}
