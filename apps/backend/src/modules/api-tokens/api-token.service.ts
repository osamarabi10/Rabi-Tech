import crypto from 'crypto';
import { prisma } from '../../prisma';
import { getTenantId, runAsPlatform } from '../../lib/tenant-context';

/**
 * Bearer tokens for the public API.
 *
 * ## The shape of a token
 *
 * ```
 * rbt_<prefix>_<secret>
 *     └ 12 hex  └ 48 hex
 * ```
 *
 * The prefix is stored in clear and is how a token is found: an inbound request
 * carries a credential and nothing else, so there is no tenant to narrow by and
 * hashing every row to find one is not an option. The secret half is stored
 * only as SHA-256, so a database copy yields no working credential.
 *
 * **SHA-256 rather than bcrypt, deliberately.** A password is low-entropy and
 * needs a slow KDF to survive a dictionary attack. This is 192 bits from
 * `randomBytes`; there is no dictionary, brute force is not on the table, and a
 * slow hash would cost real latency on every single API request. The threat a
 * KDF defends against does not exist here.
 *
 * ## Scopes deny by default
 *
 * An empty scope list grants nothing. That is the opposite of the usual
 * accident — a list that means "everything" when empty turns a restricted
 * credential into an unrestricted one by omission, and the omission is
 * invisible in every screen that renders it.
 */

/** Every scope the API understands. Adding an endpoint means adding it here. */
export const API_SCOPES = [
  'contacts:read',
  'contacts:write',
  /*
    Erasure is its own grant, never part of contacts:write.

    A sync job needs to write contact fields; almost none of them need to
    destroy a person's entire conversation history. Bundling the two would mean
    every integration ever given write access could delete, and the day one has
    a bug the workspace discovers what "cascade" means. Being a new scope also
    means no token issued before it existed can hold it.
  */
  'contacts:delete',
  'conversations:read',
  'conversations:write',
  'messages:read',
  'messages:send',
  'tags:read',
  'tags:write',
  'workspace:read',
  /*
    Starting an automation is strictly more powerful than reading.

    A workflow can send messages, reassign threads and move lifecycle stages, so
    triggering one is not covered by any read scope and must be granted
    deliberately. Appended, so no token issued before today holds it.
  */
  'workflows:trigger',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Default lifetime offered by the console. Null (never) stays possible. */
export const DEFAULT_TOKEN_DAYS = 90;

const PREFIX_BYTES = 6;   // 12 hex characters
const SECRET_BYTES = 24;  // 48 hex characters, 192 bits

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export type IssuedToken = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
  /** Inherited from the creator. Carried into every response the token reads. */
  maskContactDetails: boolean;
  /** The only time the full token exists anywhere. Never stored, never re-shown. */
  token: string;
};

export function isValidScope(scope: unknown): scope is ApiScope {
  return typeof scope === 'string' && (API_SCOPES as readonly string[]).includes(scope);
}

/**
 * Issue a token. Call inside the organization scope.
 *
 * Returns the plaintext exactly once. Nothing persists it, no log line carries
 * it, and no endpoint can retrieve it afterwards — a token that can be read
 * back later is a token that leaks from wherever it is readable.
 */
export async function issueApiToken(input: {
  name: string;
  scopes: ApiScope[];
  expiresInDays: number | null;
  createdById: string | null;
  /**
   * The creating user's `maskPhoneAndEmail`.
   *
   * A token must not see what the person who minted it cannot. Passed in rather
   * than read here, because the route already holds the authenticated user and
   * a second lookup would be a second answer to the same question.
   */
  maskContactDetails: boolean;
}): Promise<IssuedToken> {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('hex');

  const expiresAt = input.expiresInDays === null
    ? null
    : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const row = await prisma.apiToken.create({
    data: {
      // Passed explicitly as well as injected by the tenancy extension, matching
      // the convention in segments.routes.ts: the extension is a convenience
      // layer, not the boundary, and a reader should see the tenant at the call
      // site rather than infer it.
      organizationId: getTenantId(),
      name: input.name,
      prefix,
      tokenHash: hashSecret(secret),
      // De-duplicated and filtered: a repeated or unknown scope in the request
      // must not become a stored scope nothing checks.
      scopes: [...new Set(input.scopes)].filter(isValidScope),
      expiresAt,
      maskContactDetails: input.maskContactDetails,
      createdById: input.createdById,
    },
    select: { id: true, name: true, prefix: true, scopes: true, expiresAt: true, maskContactDetails: true },
  });

  return { ...row, token: `rbt_${prefix}_${secret}` };
}

export type ResolvedToken = {
  id: string;
  organizationId: string;
  scopes: string[];
  /**
   * Whether responses must hide contact phone numbers and email addresses.
   *
   * Travels with the resolved token rather than being looked up per handler:
   * a masking rule that each endpoint has to remember to apply is a masking
   * rule that the next endpoint forgets.
   */
  maskContactDetails: boolean;
};

/**
 * Resolve a bearer credential, or explain why not.
 *
 * ## Why this runs in platform scope
 *
 * Resolution is what *establishes* the tenant, so there is none yet. The
 * tenancy extension is fail-closed and `ApiToken` is not a platform model, so
 * an unwrapped read here throws `TENANT_ISOLATION_VIOLATION` — correctly, and
 * on every single API request. The extension caught this during development.
 *
 * `runAsPlatform` is the right answer rather than adding `ApiToken` to
 * `PLATFORM_MODELS`: that list removes tenant scoping from a model *everywhere*,
 * which would also unscope the management routes where one organization must never
 * see another's tokens. The narrow, audited exemption is here, at the one call
 * that legitimately has no tenant yet — the same shape the Meta webhook uses to
 * resolve a `phone_number_id` before it knows whose it is.
 *
 * Returns a reason rather than throwing, so a route can answer 401 without a
 * stack trace. The reason is for logs only and never reaches the client:
 * "expired" versus "revoked" versus "unknown prefix" tells an attacker which of
 * the three they are holding.
 */
export async function resolveApiToken(
  authorization: string | undefined,
): Promise<{ ok: true; token: ResolvedToken } | { ok: false; reason: string }> {
  if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };

  const raw = authorization.slice(7).trim();
  const parts = raw.split('_');
  if (parts.length !== 3 || parts[0] !== 'rbt' || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, prefix, secret] = parts;

  const row = await runAsPlatform('api-token-resolve', () =>
    prisma.apiToken.findUnique({
      where: { prefix },
      select: {
        id: true, organizationId: true, tokenHash: true, scopes: true,
        expiresAt: true, revokedAt: true, lastUsedAt: true, maskContactDetails: true,
      },
    }),
  );
  if (!row) return { ok: false, reason: 'unknown prefix' };

  /*
    Constant-time comparison.

    The prefix lookup already narrowed to one row, so a timing signal here
    reveals how much of the *secret* is correct — which is exactly the leak that
    turns a 192-bit secret into a byte-at-a-time search. Buffers are the same
    length by construction (both SHA-256 hex), so timingSafeEqual cannot throw.
  */
  const expected = Buffer.from(row.tokenHash, 'hex');
  const provided = Buffer.from(hashSecret(secret), 'hex');
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad secret' };
  }

  if (row.revokedAt) return { ok: false, reason: 'revoked' };
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  /*
    Last-used, at most once a minute.

    An unused token is the strongest signal that a credential can be revoked
    safely, so this is worth recording — but writing on every request would put
    an UPDATE in front of every read in the API, and the minute of resolution
    nobody needs is not worth that. Failures are swallowed: a bookkeeping write
    must never fail a request that was properly authenticated.
  */
  const stale = !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000;
  if (stale) {
    // Also platform-scoped, and for the same reason: there is still no tenant.
    runAsPlatform('api-token-touch', () =>
      prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }),
    ).catch(() => {});
  }

  return {
    ok: true,
    token: {
      id: row.id,
      organizationId: row.organizationId,
      scopes: row.scopes,
      maskContactDetails: row.maskContactDetails,
    },
  };
}

/** Whether this token carries the scope an endpoint requires. */
export function tokenHasScope(token: ResolvedToken, scope: ApiScope): boolean {
  return token.scopes.includes(scope);
}
