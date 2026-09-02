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
 * Who is calling the public API — the token prefix, never the secret.
 *
 * An IP key would be wrong in both directions: several integrations behind one
 * corporate NAT would throttle each other for reasons none of them can see, and
 * one integration spread across a serverless fleet would get a fresh budget per
 * cold start. The token is the thing whose behaviour we want to bound and whose
 * owner can be told about it. Falls back to IP only when there is no usable
 * credential, so an unauthenticated flood is still bounded rather than sharing
 * one empty-string bucket.
 */
export function publicApiCaller(req: Request): string {
  const raw = String(req.headers.authorization || '');
  const prefix = raw.startsWith('Bearer rbt_') ? raw.slice(11).split('_')[0] : '';
  return prefix || `ip:${req.ip}`;
}

/**
 * Collapse a concrete path to the route it belongs to.
 *
 * "Per method + path" means the *route*, not the URL. Keying on the raw path
 * would give every contact its own bucket — `/contacts/id:A` and
 * `/contacts/id:B` would never share a limit, so a client sweeping ten thousand
 * contacts would never be throttled at all, and the limit would exist only on
 * paper.
 *
 * Express does not expose the matched route here (this runs before the router),
 * so the collapse is by shape: anything that looks like an identifier becomes
 * `:id`.
 */
export function routeTemplate(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (!segment) return segment;
      // The API's own identifier grammar: id:, phone:, email:.
      if (/^(id|phone|email):/i.test(segment)) return ':id';
      // A cuid, or any long opaque token.
      if (/^c[a-z0-9]{20,}$/i.test(segment) || segment.length > 20) return ':id';
      return segment;
    })
    .join('/');
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

  /**
   * The growth-widget redirect — the only unauthenticated endpoint that writes.
   *
   * Same shape as `publicBranding`, and a stricter reason. This one inserts a
   * row per request, so an unbounded caller could fill a subscriber's click
   * table and inflate their numbers. The limit bounds the flood; it does not
   * make the count trustworthy, which is why the sources report leads with
   * contacts and treats clicks as unverified context.
   */
  widgetRedirect: rateLimit('widget-redirect', { max: 60, windowMs: 60_000 }),

  /** Provider webhooks are legitimately bursty; this only catches a flood. */
  webhook: rateLimit('webhook', { max: 600, windowMs: 60_000 }),

  /** Everything else under /api. Generous — this is a backstop, not a throttle. */
  api: rateLimit('api', { max: 300, windowMs: 60_000 }),

  /*
    The public API, keyed by *token* rather than by IP.

    An IP key is wrong here in both directions. Several integrations behind one
    corporate NAT would throttle each other for reasons none of them can see,
    and one integration spread across a serverless fleet would get a fresh
    budget per cold start. The token is the thing whose behaviour we actually
    want to bound, and it is the thing whose owner can be told about it.

    Only the prefix is keyed — the secret half never reaches this map, which
    lives in memory and appears in the log line above on every 429.
  */
  publicApi: rateLimit('public-api', {
    /*
      5 per second per method+path, matching Respond.io's published limit.

      Configurable only so the verification gate can raise it: at five a second
      the gate's own ~130 sequential assertions trip the limiter and fail as
      though the endpoints were broken, which is what happened the first time
      this shipped. The default is the shipped value and production never sets
      the variable.
    */
    max: Number(process.env.PUBLIC_API_RATE_PER_SECOND) || 5,
    windowMs: 1_000,
    keyBy: (req) => `${publicApiCaller(req)}:${req.method}:${routeTemplate(req.path)}`,
    message: 'Rate limit exceeded. Retry after the interval in the Retry-After header.',
  }),

  /**
   * A wider backstop on the same credential, across all endpoints.
   *
   * The per-method limit above bounds hammering one endpoint; it does nothing
   * about a client sweeping thirty endpoints at five a second each. This is the
   * ceiling on the credential as a whole, and it is generous enough that no
   * legitimate integration meets it.
   */
  publicApiTotal: rateLimit('public-api-total', {
    max: Number(process.env.PUBLIC_API_RATE_PER_MINUTE) || 600,
    windowMs: 60_000,
    keyBy: publicApiCaller,
    message: 'Rate limit exceeded. Retry after the interval in the Retry-After header.',
  }),
};
