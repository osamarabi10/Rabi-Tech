import { NextFunction, Request, Response } from 'express';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
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
 * support ticket. The reason goes to the log, where the organization owner's
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
    449 — the workspace is still being set up.

    Checked before the access gate because it is the more specific state: a
    provisioning workspace is not suspended and not expired, it is simply not
    ready yet, and answering with either of the other two would be wrong.

    Respond.io publishes a 449 for "resource is still being created" and it is
    worth copying, because the alternative is worse in a specific way: a
    workspace mid-provisioning has no channel yet, so a send would 409 and a read
    would return an empty list. Both look like a permanent answer. A client that
    gets 409 stops; a client that gets an empty list writes it down as fact.

    449 says "this will work shortly, come back", which is the truth, and
    `Retry-After` tells them when rather than leaving them to poll.
  */
  const provisioning = await runAsPlatform(`api-provisioning-check:${token.organizationId}`, () =>
    prisma.organization.findUnique({
      where: { id: token.organizationId },
      select: { status: true },
    }),
  );
  if (provisioning?.status === 'PROVISIONING') {
    res.setHeader('Retry-After', '30');
    return res.status(449).json({
      error: 'workspace_provisioning',
      // The error CODE stays workspace_provisioning: it is published in
      // docs/PUBLIC-API.md and integrations already branch on it. Renaming a
      // wire identifier to fix a vocabulary problem breaks callers who did
      // nothing wrong, so only the sentence a human reads changes.
      message: 'This organization is still being set up. Retry shortly.',
      retryAfter: 30,
    });
  }

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
