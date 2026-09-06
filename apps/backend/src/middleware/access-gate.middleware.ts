import { NextFunction, Request, Response } from 'express';
import { prisma } from '../prisma';
import logger from '../lib/logger';
import { runAsPlatform } from '../lib/tenant-context';
import { trialStateOf, TRIAL_SUBSCRIPTION_STATUSES } from '../modules/billing/trial.service';
import { SUBSCRIPTION_PLAN_SELECT } from '../modules/billing/subscription-plan';

/**
 * Whether this organization may use the product at all right now.
 *
 * Distinct from RBAC, which answers "may *this user* do *this thing*". This
 * answers a question that was previously asked nowhere: is the subscriber
 * entitled to be here.
 *
 * ## This gate did not exist
 *
 * `verifyToken` checks that the user is real, active and not revoked, and never
 * looked at the organization. The one `SUSPENDED` check in the codebase sits in
 * the platform *view-as-tenant* path, so it only ever stopped the platform
 * owner. The consequence: dunning would mark a non-paying subscriber SUSPENDED,
 * stop their gateway, raise an alert — and that subscriber's own staff could
 * still log in and use the entire application. The billing lockout was writing
 * a status nothing enforced.
 *
 * So this closes two things at once, and deliberately: an expired trial, and a
 * suspension that has never actually suspended anybody.
 *
 * ## The allow-list is the load-bearing part
 *
 * A paywall that blocks the route to the payment page has locked the customer
 * out of giving you money. Everything needed to see the plans, understand why
 * access stopped, pay, and leave has to stay open — and nothing else. The list
 * is prefix-matched against the path *after* `/api`.
 */

/**
 * Paths an organization may still reach when its access is gated.
 *
 * Kept deliberately short. Each entry answers "how else would they pay or find
 * out why?" — a route that does not answer that does not belong here.
 */
const ALLOWED_WHEN_GATED = [
  // Who am I, and is my access really gone. The client renders the paywall from
  // this, so blocking it produces a blank screen instead of an explanation.
  '/auth/me',
  '/auth/logout',
  // The plans, the current bill, and the checkout that ends the lockout.
  '/billing',
  // The paywall is a branded page for a white-label tenant.
  '/branding/public',
  '/branding/assets',
] as const;

function isAllowedWhenGated(path: string): boolean {
  return ALLOWED_WHEN_GATED.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

export type GateDecision =
  | { allowed: true }
  | { allowed: false; code: 'TRIAL_EXPIRED'; message: string; trialEndsAt: Date }
  | { allowed: false; code: 'SUBSCRIBER_SUSPENDED'; message: string; trialEndsAt: null };

/**
 * The decision, separated from the middleware so it can be tested and reused by
 * the endpoint that tells the client what state it is in.
 */
export async function decideAccess(organizationId: string, now = new Date()): Promise<GateDecision> {
  // Read as the platform: the tenancy extension scopes by the caller's
  // organization, and this runs before any handler has established which
  // organization that is for certain.
  const organization = await runAsPlatform(`access-gate:${organizationId}`, () =>
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        status: true,
        subscriptions: {
          where: { status: { in: TRIAL_SUBSCRIPTION_STATUSES } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { ...SUBSCRIPTION_PLAN_SELECT, status: true, trialEndsAt: true },
        },
      },
    }),
  );

  // An organization that cannot be read is not a licence to proceed, but it is
  // also not this middleware's error to invent — `verifyToken` already rejected
  // unknown tokens, so this means a deleted organization mid-request.
  if (!organization) return { allowed: true };

  if (organization.status === 'SUSPENDED') {
    return {
      allowed: false,
      code: 'SUBSCRIBER_SUSPENDED',
      message: 'الاشتراك موقوف. تواصل معنا لإعادة التفعيل.',
      trialEndsAt: null,
    };
  }

  const trial = trialStateOf(organization.subscriptions[0], now);
  if (trial.kind === 'expired') {
    return {
      allowed: false,
      code: 'TRIAL_EXPIRED',
      message: 'خلصت الفترة التجريبية. اختار باقة عشان تكمّل.',
      trialEndsAt: trial.endsAt,
    };
  }

  return { allowed: true };
}

/**
 * Applied to every authenticated tenant request.
 *
 * Fails **open** on an internal error. A database hiccup here would otherwise
 * lock every paying subscriber out of the product at once — the blast radius of
 * failing closed is the entire customer base, and the blast radius of failing
 * open is one unpaid organization getting a few more minutes. The error is logged
 * loudly rather than silently swallowed.
 */
export function enforceAccess(req: Request, res: Response, next: NextFunction) {
  const organizationId = req.user?.organizationId;
  if (!organizationId) return next();

  // Strip the mount prefix so the allow-list reads the way the routes do.
  const path = req.path;
  if (isAllowedWhenGated(path)) return next();

  decideAccess(organizationId)
    .then((decision) => {
      if (decision.allowed) return next();
      res.status(403).json({
        error: decision.message,
        // Machine-readable, like SEAT_LIMIT_REACHED. The client redirects on
        // this rather than on the status code, because a 403 also means "you
        // lack the permission", and sending someone to the pricing page for
        // that would be nonsense.
        code: decision.code,
        trialEndsAt: decision.trialEndsAt?.toISOString() ?? null,
        upgradeRequired: true,
      });
    })
    .catch((error) => {
      logger.error('access gate failed open', {
        organizationId,
        path,
        error: String(error),
        requestId: (req as any).id,
      });
      next();
    });
}
