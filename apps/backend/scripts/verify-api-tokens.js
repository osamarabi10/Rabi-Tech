/**
 * API tokens: what a bearer credential must and must not do.
 *
 * ## Why this gate exists
 *
 * Every failure in this file is silent in the dangerous direction. A token that
 * resolves when it should not looks exactly like one that should — the request
 * succeeds, the log line says 200, and nothing anywhere reports that a revoked
 * credential is still reading a subscriber's conversations. There is no screen
 * on which "this expired token still works" is visible.
 *
 * ## Run against the real database, deliberately
 *
 * Unlike `verify-restrictions` and `verify-backup-replication`, this one is not
 * hermetic and should not be. Its subject *is* stored rows: that the secret was
 * never written, that a unique index makes prefixes non-colliding, that
 * `revokedAt` is read on the path a request actually takes. Mocking Prisma here
 * would prove the mock behaves, which is the one thing nobody needs to know.
 * Everything it creates is deleted on the way out, including on failure.
 *
 * ## The load-bearing check
 *
 * `resolveApiToken` is called **outside any tenant scope**, which is where the
 * server calls it — resolution is what establishes the tenant, so there is none
 * yet. That is not incidental to the test setup, it is the regression this file
 * exists to catch: during development `resolveApiToken` read `ApiToken`
 * unwrapped, and the fail-closed tenancy extension threw
 * `TENANT_ISOLATION_VIOLATION` on what would have been every single API
 * request. The fix was `runAsPlatform`, and `main()` below is deliberately NOT
 * wrapped in a scope so that a regression fails here instead of in production.
 */
// D-12: the repo-root .env, before anything that touches prisma.
require('./load-env');

const fs = require('fs');
const path = require('path');
const { runAsPlatform } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const {
  API_SCOPES,
  DEFAULT_TOKEN_DAYS,
  issueApiToken,
  resolveApiToken,
  tokenHasScope,
  isValidScope,
} = require('../dist/modules/api-tokens/api-token.service');
const { requireScope } = require('../dist/modules/api-tokens/api-token.middleware');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail ? ' — ' + detail : ''));
  }
}

/** Issue inside an organization scope, the way a route does. */
function issueIn(organizationId, input) {
  return runAsPlatform('verify-api-tokens:issue', () =>
    require('../dist/lib/tenant-context').runAsOrganization(organizationId, () =>
      issueApiToken(input),
    ),
  );
}

function readRow(id) {
  return runAsPlatform('verify-api-tokens:read', () =>
    prisma.apiToken.findUnique({ where: { id } }),
  );
}

function patchRow(id, data) {
  return runAsPlatform('verify-api-tokens:patch', () =>
    prisma.apiToken.update({ where: { id }, data }),
  );
}

/** A minimal Express double. Records what the middleware did to it. */
function fakeExchange(apiToken) {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return { req: { apiToken }, res, calls: { next: 0 }, next() { this.calls.next += 1; } };
}

async function main() {
  const created = [];

  // Two organizations, because a single-tenant pass proves nothing about
  // tenancy. Ordered so the selection is stable between runs — an unordered
  // findFirst is what made the finance gate fail intermittently.
  const orgs = await runAsPlatform('verify-api-tokens:orgs', () =>
    prisma.organization.findMany({ orderBy: { id: 'asc' }, take: 2, select: { id: true } }),
  );
  if (orgs.length < 2) {
    throw new Error('Need two organizations to prove cross-tenant resolution; found ' + orgs.length);
  }
  const [orgA, orgB] = orgs;

  try {
    // ── shape and secrecy ────────────────────────────────────────────────────
    const live = await issueIn(orgA.id, {
      name: 'gate: live token',
      scopes: ['contacts:read', 'messages:send'],
      expiresInDays: 30,
      createdById: null,
    });
    created.push(live.id);

    check('issued token matches rbt_<12hex>_<48hex>', /^rbt_[0-9a-f]{12}_[0-9a-f]{48}$/.test(live.token),
      live.token.slice(0, 20) + '…');

    const secret = live.token.split('_')[2];
    const row = await readRow(live.id);

    check('the secret is not stored', row.tokenHash !== secret);
    check('the stored hash is SHA-256 hex', /^[0-9a-f]{64}$/.test(row.tokenHash));
    check('no column anywhere holds the plaintext',
      !JSON.stringify(row).includes(secret));
    check('the prefix is stored in clear and matches the token', row.prefix === live.prefix);
    check('the full token is not recoverable from the row',
      !JSON.stringify(row).includes(live.token));

    // ── resolution, outside any tenant scope ────────────────────────────────
    // This is the shape the server uses. If ApiToken ever loses its
    // runAsPlatform wrap, every assertion below throws TENANT_ISOLATION_VIOLATION.
    const ok = await resolveApiToken('Bearer ' + live.token);
    check('a live token resolves with no ambient tenant scope', ok.ok === true,
      ok.ok ? '' : ok.reason);
    check('resolves to the issuing organization', ok.ok && ok.token.organizationId === orgA.id);
    check('resolves with the granted scopes',
      ok.ok && ok.token.scopes.join(',') === 'contacts:read,messages:send');

    // ── rejection: every way a credential can be wrong ───────────────────────
    const badSecret = 'Bearer rbt_' + live.prefix + '_' + 'f'.repeat(48);
    const rejections = [
      ['a valid prefix with the wrong secret', badSecret, 'bad secret'],
      ['an unknown prefix', 'Bearer rbt_' + 'a'.repeat(12) + '_' + 'b'.repeat(48), 'unknown prefix'],
      ['no Authorization header at all', undefined, 'missing bearer'],
      ['a header that is not a bearer scheme', 'Basic ' + live.token, 'missing bearer'],
      ['a bearer value with the wrong scheme prefix', 'Bearer xyz_' + live.prefix + '_' + secret, 'malformed'],
      ['a token missing its secret half', 'Bearer rbt_' + live.prefix, 'malformed'],
      ['a token with an empty secret half', 'Bearer rbt_' + live.prefix + '_', 'malformed'],
      ['a token with an extra segment', 'Bearer rbt_' + live.prefix + '_' + secret + '_extra', 'malformed'],
      ['an empty bearer value', 'Bearer ', 'malformed'],
    ];
    for (const [label, header, expectedReason] of rejections) {
      const result = await resolveApiToken(header);
      check('rejects ' + label, result.ok === false);
      check('  …and says why: ' + expectedReason,
        result.ok === false && result.reason === expectedReason,
        result.ok ? 'accepted' : result.reason);
    }

    // A near-miss secret must not squeak through. One character different from
    // the real one, at the end, where a short-circuiting comparison would be
    // most likely to get it wrong.
    const nearMiss = secret.slice(0, -1) + (secret.endsWith('a') ? 'b' : 'a');
    const near = await resolveApiToken('Bearer rbt_' + live.prefix + '_' + nearMiss);
    check('rejects a secret differing in one final character', near.ok === false);

    /*
      Constant-time comparison.

      A source assertion, not a timing measurement — measuring a nanosecond
      difference reliably on a laptop under load is not something a gate can do
      honestly. What this catches is the regression that actually happens: a
      later edit replacing timingSafeEqual with `===` because it reads more
      simply. The prefix lookup narrows to one row, so a timing signal here
      leaks how much of the secret is right, one byte at a time.
    */
    const compiled = fs.readFileSync(
      path.join(__dirname, '..', 'dist', 'modules', 'api-tokens', 'api-token.service.js'),
      'utf8',
    );
    check('the secret comparison uses timingSafeEqual', compiled.includes('timingSafeEqual'));

    // ── scopes deny by default ──────────────────────────────────────────────
    const empty = await issueIn(orgA.id, {
      name: 'gate: no scopes',
      scopes: [],
      expiresInDays: 30,
      createdById: null,
    });
    created.push(empty.id);
    const emptyResolved = await resolveApiToken('Bearer ' + empty.token);
    check('a token with no scopes still authenticates', emptyResolved.ok === true);
    for (const scope of API_SCOPES) {
      check('  …but grants nothing: ' + scope,
        emptyResolved.ok && tokenHasScope(emptyResolved.token, scope) === false);
    }

    check('tokenHasScope is true for a granted scope',
      ok.ok && tokenHasScope(ok.token, 'contacts:read'));
    check('tokenHasScope is false for an ungranted scope',
      ok.ok && !tokenHasScope(ok.token, 'contacts:write'));

    // Unknown and duplicate scopes never reach storage. A stored scope nothing
    // checks is a permission the console displays and the server ignores.
    const messy = await issueIn(orgA.id, {
      name: 'gate: messy scopes',
      scopes: ['contacts:read', 'contacts:read', 'not:a:scope', 'tags:read'],
      expiresInDays: 30,
      createdById: null,
    });
    created.push(messy.id);
    check('duplicate scopes are stored once',
      messy.scopes.filter((s) => s === 'contacts:read').length === 1);
    check('an unknown scope is dropped rather than stored',
      !messy.scopes.includes('not:a:scope'));
    check('the valid scopes survive', messy.scopes.includes('contacts:read') && messy.scopes.includes('tags:read'));
    check('isValidScope rejects a made-up scope', isValidScope('not:a:scope') === false);
    check('isValidScope rejects a non-string', isValidScope(42) === false);
    for (const scope of API_SCOPES) {
      check('isValidScope accepts ' + scope, isValidScope(scope) === true);
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    const revoked = await issueIn(orgA.id, {
      name: 'gate: to be revoked',
      scopes: ['contacts:read'],
      expiresInDays: 30,
      createdById: null,
    });
    created.push(revoked.id);
    check('the token works before revocation',
      (await resolveApiToken('Bearer ' + revoked.token)).ok === true);
    await patchRow(revoked.id, { revokedAt: new Date() });
    const afterRevoke = await resolveApiToken('Bearer ' + revoked.token);
    check('a revoked token is rejected', afterRevoke.ok === false);
    check('  …for the reason "revoked"', afterRevoke.ok === false && afterRevoke.reason === 'revoked');

    const expired = await issueIn(orgA.id, {
      name: 'gate: to expire',
      scopes: ['contacts:read'],
      expiresInDays: 1,
      createdById: null,
    });
    created.push(expired.id);
    await patchRow(expired.id, { expiresAt: new Date(Date.now() - 1000) });
    const afterExpiry = await resolveApiToken('Bearer ' + expired.token);
    check('an expired token is rejected', afterExpiry.ok === false);
    check('  …for the reason "expired"', afterExpiry.ok === false && afterExpiry.reason === 'expired');

    // The boundary itself. A token expiring exactly now is expired, not valid —
    // `<=` rather than `<`, which is the difference between a credential that
    // ends and one that ends a millisecond later than it claims.
    await patchRow(expired.id, { expiresAt: new Date() });
    check('a token expiring at this instant is expired',
      (await resolveApiToken('Bearer ' + expired.token)).ok === false);

    const eternal = await issueIn(orgA.id, {
      name: 'gate: never expires',
      scopes: ['workspace:read'],
      expiresInDays: null,
      createdById: null,
    });
    created.push(eternal.id);
    check('expiresInDays null stores no expiry', eternal.expiresAt === null);
    check('a token with no expiry resolves',
      (await resolveApiToken('Bearer ' + eternal.token)).ok === true);

    const defaulted = await issueIn(orgA.id, {
      name: 'gate: default expiry',
      scopes: ['workspace:read'],
      expiresInDays: DEFAULT_TOKEN_DAYS,
      createdById: null,
    });
    created.push(defaulted.id);
    const expectedMs = Date.now() + DEFAULT_TOKEN_DAYS * 24 * 60 * 60 * 1000;
    check('the default lifetime is ' + DEFAULT_TOKEN_DAYS + ' days',
      Math.abs(defaulted.expiresAt.getTime() - expectedMs) < 60_000);

    // ── tenancy ─────────────────────────────────────────────────────────────
    const otherOrg = await issueIn(orgB.id, {
      name: 'gate: other workspace',
      scopes: ['contacts:read'],
      expiresInDays: 30,
      createdById: null,
    });
    created.push(otherOrg.id);
    const resolvedB = await resolveApiToken('Bearer ' + otherOrg.token);
    check('a second workspace\'s token resolves to that workspace',
      resolvedB.ok && resolvedB.token.organizationId === orgB.id);
    check('  …and not to the first', resolvedB.ok && resolvedB.token.organizationId !== orgA.id);
    check('the two workspaces\' tokens are distinct credentials',
      otherOrg.token !== live.token && otherOrg.prefix !== live.prefix);

    // ── uniqueness and entropy ──────────────────────────────────────────────
    const prefixes = new Set();
    const secrets = new Set();
    for (let i = 0; i < 25; i += 1) {
      const t = await issueIn(orgA.id, {
        name: 'gate: uniqueness ' + i,
        scopes: ['workspace:read'],
        expiresInDays: 1,
        createdById: null,
      });
      created.push(t.id);
      prefixes.add(t.prefix);
      secrets.add(t.token.split('_')[2]);
    }
    check('25 issued tokens produce 25 distinct prefixes', prefixes.size === 25);
    check('25 issued tokens produce 25 distinct secrets', secrets.size === 25);

    // ── the scope middleware ────────────────────────────────────────────────
    const granted = fakeExchange({ id: 'x', organizationId: orgA.id, scopes: ['contacts:read'] });
    requireScope('contacts:read')(granted.req, granted.res, () => granted.next());
    check('requireScope calls next when the scope is held', granted.calls.next === 1);
    check('  …and writes no status', granted.res.statusCode === null);

    const denied = fakeExchange({ id: 'x', organizationId: orgA.id, scopes: ['contacts:read'] });
    requireScope('messages:send')(denied.req, denied.res, () => denied.next());
    check('requireScope refuses when the scope is absent', denied.calls.next === 0);
    check('  …with 403, not 401', denied.res.statusCode === 403);
    check('  …as insufficient_scope', denied.res.body && denied.res.body.error === 'insufficient_scope');
    check('  …naming the scope required', denied.res.body && denied.res.body.required === 'messages:send');

    const anonymous = fakeExchange(undefined);
    requireScope('contacts:read')(anonymous.req, anonymous.res, () => anonymous.next());
    check('requireScope refuses an unauthenticated request', anonymous.calls.next === 0);
    check('  …with 401', anonymous.res.statusCode === 401);
    check('  …and a WWW-Authenticate header', Boolean(anonymous.res.headers['WWW-Authenticate']));

    // ── last-used bookkeeping ───────────────────────────────────────────────
    // Written fire-and-forget so it can never fail an authenticated request,
    // which means polling rather than asserting immediately. Bounded: if it has
    // not landed in two seconds it is not landing.
    const fresh = await issueIn(orgA.id, {
      name: 'gate: last used',
      scopes: ['workspace:read'],
      expiresInDays: 1,
      createdById: null,
    });
    created.push(fresh.id);
    check('a new token has never been used', (await readRow(fresh.id)).lastUsedAt === null);
    await resolveApiToken('Bearer ' + fresh.token);
    let touched = null;
    for (let i = 0; i < 20 && !touched; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      touched = (await readRow(fresh.id)).lastUsedAt;
    }
    check('a successful resolve records lastUsedAt', touched !== null);

    // A rejected credential must not update anything. Otherwise "last used"
    // reports on the attacker rather than on the integration.
    const before = (await readRow(revoked.id)).lastUsedAt;
    await resolveApiToken('Bearer ' + revoked.token);
    await new Promise((r) => setTimeout(r, 300));
    check('a rejected credential does not update lastUsedAt',
      String((await readRow(revoked.id)).lastUsedAt) === String(before));
  } finally {
    await runAsPlatform('verify-api-tokens:cleanup', () =>
      prisma.apiToken.deleteMany({ where: { id: { in: created } } }),
    );
    await prisma.$disconnect();
  }

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

// NOT wrapped in runAsPlatform — see the header. Resolution must work with no
// ambient scope, because that is the state the server is in when it calls it.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
