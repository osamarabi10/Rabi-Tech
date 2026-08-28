import type { NextFunction, Request, Response } from 'express';
import logger from '../lib/logger';

/**
 * Rate limiting.
 *
 * The platform had none: login was open to unlimited password guessing, and
 * public signup — which provisions a Docker container per organization — was open
 * to automated abuse. That is a resource-exhaustion vector, not just spam.
 *
 * Deliberately in-process rather than Redis-backed. A single backend instance is
 * the current deployment, and an in-memory counter that definitely works today
 * beats a distributed one that needs infrastructure we do not run yet. When the
 * backend is scaled horizontally this must move to Redis — see LIMITS below.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Drop expired buckets so the map cannot grow without bound. */
function sweep(now: number): void {
  if (buckets.size < 5000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  /** Requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Bucket key. Defaults to client IP. */
  keyBy?: (req: Request) => string;
  /** Message returned on 429. */
  message?: string;
}

/**
 * Resolves the client IP. Express `trust proxy` must be set correctly or every
 * request behind a reverse proxy shares one bucket and the limit is useless.
 */
function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function rateLimit(name: string, options: RateLimitOptions) {
  const { max, windowMs, keyBy, message } = options;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);

    const key = `${name}:${keyBy ? keyBy(req) : clientIp(req)}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn('Rate limit exceeded', { limiter: name, key, count: bucket.count });
      return res.status(429).json({
        error: message || 'طلبات كثيرة — جرّب بعد شوي',
        retryAfter,
      });
    }

    return next();
  };
}

/**
 * Named limiters. Auth and signup are strict because they are the abuse targets;
 * the API default is loose enough that a busy agent never notices it.
 */
export const LIMITS = {
  /** Password guessing. Keyed by IP *and* submitted email so one does not mask the other. */
  login: rateLimit('login', {
    max: 10,
    windowMs: 15 * 60_000,
    keyBy: (req) => `${req.ip}:${String((req.body as any)?.email || '').toLowerCase()}`,
    message: 'محاولات دخول كثيرة — جرّب بعد ١٥ دقيقة',
  }),

  /** A valid password challenge still has only one million TOTP possibilities. */
  twoFactorLogin: rateLimit('two-factor-login', {
    max: 8,
    windowMs: 15 * 60_000,
    keyBy: (req) => `${req.ip}:${String((req.body as any)?.challengeToken || '').slice(-32)}`,
    message: 'محاولات تحقق كثيرة — جرّب بعد ١٥ دقيقة',
  }),

  /** Factor enrollment and removal are authenticated but remain high-risk changes. */
  twoFactorManagement: rateLimit('two-factor-management', {
    max: 10,
    windowMs: 15 * 60_000,
    keyBy: (req) => `${req.ip}:${String(req.headers.authorization || '').slice(-32)}`,
    message: 'محاولات تحقق كثيرة — جرّب بعد ١٥ دقيقة',
  }),

  /** Each signup can provision a container. Strictest limit on the platform. */
  signup: rateLimit('signup', {
    max: 3,
    windowMs: 60 * 60_000,
    message: 'محاولات تسجيل كثيرة — جرّب بعد ساعة',
  }),

  /** Verification email resend — cheap to request, costs us to send. */
  emailVerify: rateLimit('email-verify', { max: 5, windowMs: 15 * 60_000 }),

  /** Unauthenticated and enumerable by host. */
  publicBranding: rateLimit('public-branding', { max: 60, windowMs: 60_000 }),

  /** Provider webhooks are legitimately bursty; this only catches a flood. */
  webhook: rateLimit('webhook', { max: 600, windowMs: 60_000 }),

  /** Everything else under /api. Generous — this is a backstop, not a throttle. */
  api: rateLimit('api', { max: 300, windowMs: 60_000 }),
};
