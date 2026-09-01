import { NextFunction, Request, Response } from 'express';
import logger from '../../lib/logger';
import { runAsOrganization } from '../../lib/tenant-context';
import { decideAccess } from '../../middleware/access-gate.middleware';
import { resolveApiToken, tokenHasScope, type ApiScope, type ResolvedToken } from './api-token.service';

/**
 * Authentication for `/api/v1` — the public API.
 *
 * ## Why this is separate from `verifyToken`
 *
 * A browser session and a machine credential fail differently and should be
 * built differently. A JWT is short-lived, carries a user, and is refreshed by
 * a login screen that a human is sitting in front of. An API token is
 * long-lived, carries no user, and is held by software that will retry a 401
 * forever. Sharing one middleware between them means every future change to
 * session handling silently changes how integrations authenticate.
 *
 * The two paths meet at exactly one point, and it is the important one: both
 * end inside `runAsOrganization`, so every query a public-API handler makes is
 * scoped by the same fail-closed extension that scopes the console. There is no
 * second tenancy story for the public API.
 *
 * ## The error body is deliberately uninformative
 *
 * `resolveApiToken` distinguishes malformed from unknown from expired from
 * revoked from wrong-secret. The caller is told `invalid_token` for all five.
 * Telling an attacker that a prefix is real but the secret is wrong halves
 * their problem; telling a legitimate integrator the same thing saves them a
 * support ticket. The reason goes to the log, where the workspace owner's
 * support request can be answered from it.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `apiTokenAuth`. Present on `/api/v1` requests and nowhere else. */
      apiToken?: ResolvedToken;
    }
  }
}

/** RFC 6750 §3 — a 401 on a bearer scheme must say which scheme. */
function unauthorized(res: Response, description: string) {
  res.setHeader('WWW-Authenticate', `Bearer realm="RabiTech API", error="invalid_token"`);
  return res.status(401).json({ error: 'invalid_token', message: description });
}

/**
 * Resolve the bearer credential and establish tenant scope for the request.
 *
 * Everything downstream runs inside the organization context, so a handler that
 * forgets to filter by organization is still scoped — the same property the
 * console relies on.
 */
export async function apiTokenAuth(req: Request, res: Response, next: NextFunction) {
  const result = await resolveApiToken(req.headers.authorization);

  if (!result.ok) {
    logger.warn('API token rejected', {
      reason: result.reason,
      path: req.path,
      method: req.method,
      requestId: (req as any).id,
    });
    return unauthorized(res, 'The access token is missing, malformed, expired or revoked.');
  }

  const token = result.token;
  req.apiToken = token;

  /*
    A suspended or expired workspace loses its API too.

    Leaving it open would make the billing lockout cosmetic: the console would
    refuse the subscriber's staff while their integration kept reading every
    conversation. There is no allow-list here, unlike the console gate — that
    list exists so a locked-out human can still reach the payment page, and no
    machine credential needs to reach a payment page.
  */
  const access = await decideAccess(token.organizationId);
  if (!access.allowed) {
    logger.warn('API token refused by access gate', {
      organizationId: token.organizationId,
      code: access.code,
      requestId: (req as any).id,
    });
    return res.status(403).json({ error: access.code, message: access.message });
  }

  return runAsOrganization(token.organizationId, () => {
    next();
  }).catch((err) => {
    logger.error('Failed to establish tenant context for API token', {
      organizationId: token.organizationId,
      error: err?.message,
    });
    res.status(500).json({ error: 'server_error' });
  });
}

/**
 * Require a scope. Chain after `apiTokenAuth`.
 *
 * 403 rather than 401: the credential is valid, and re-authenticating with the
 * same token will never help. A client that retries a 401 forever is correct to
 * do so; one that retries a 403 is not, and the distinction is what stops an
 * integration from hammering an endpoint its token was never granted.
 */
export function requireScope(scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = req.apiToken;
    // Unreachable through the router, but a scope check that passes when
    // authentication is missing is the wrong thing to leave lying around for
    // whoever mounts this next.
    if (!token) return unauthorized(res, 'Authentication is required.');

    if (!tokenHasScope(token, scope)) {
      return res.status(403).json({
        error: 'insufficient_scope',
        message: `This token does not carry the "${scope}" scope.`,
        required: scope,
      });
    }
    return next();
  };
}
