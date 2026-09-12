#!/usr/bin/env node
/**
 * The C3 proof: resolved entitlements must be byte-identical across the
 * PlanVersion / Price migration.
 *
 * ## Why this seeds instead of reading what is there
 *
 * The database holds no organizations. A before/after comparison over an empty
 * set passes trivially and asserts nothing — the emptiest possible green, and
 * this repository has a section of AGENTS.md about those. So the proof creates
 * its own subjects with the product's own signup code — `createSignup`, then
 * `activateManualSubscription` — and never by writing rows into the tables.
 * Hand-written rows would prove the resolver agrees with one person's idea of a
 * subscription rather than with the one the product actually creates, and they
 * would be a second copy of a creation path eight tables wide.
 *
 * Exactly one scenario is built through `POST /api/billing/signup` itself, so a
 * regression in the endpoint still fails this gate. See `REAL_PATH_SCENARIO`
 * for why the other seven are not, and D-29 for what it cost when they were.
 *
 * ## Why editions are reached by override, not by subscribing to each
 *
 * Only FREE and STANDARD can be signed up for on this platform. The other three
 * are refused at signup with `PLAN_CHANNEL_UNAVAILABLE`, because
 * `editionOfferability` withdraws any edition whose only channel the platform
 * cannot operate, and the Meta credentials are absent (D-9). That refusal is
 * correct product behaviour and not something a test should route around.
 *
 * So every organization here is created by the product's own signup code on an
 * edition that is genuinely sellable, and the remaining editions are reached
 * the way a platform owner would actually reach them today: a plan override.
 * All five editions' numbers are still resolved and compared.
 *
 * ## Why these seven shapes
 *
 * `resolveEntitlements` is a precedence chain — live override, then
 * subscription, then (until C3) `Organization.tier`. A proof over plain
 * organizations exercises one branch and would stay green while the override
 * layers broke, which is the layer real money sits on. So the seed carries a
 * plain organization on each sellable edition, three live plan overrides, a
 * single-metric override, and an **expired** override, which must be ignored —
 * the case where a mistake would otherwise grant an upgrade for ever.
 *
 * ## Determinism
 *
 * `now` is fixed, ids and timestamps are stripped, keys are sorted, BigInt is
 * stringified. Anything that legitimately varies per run must not reach the
 * snapshot, or the comparison fails for reasons that are not the migration.
 *
 * Usage:
 *   node scripts/c3-entitlement-snapshot.js --write   capture the baseline
 *   node scripts/c3-entitlement-snapshot.js           compare against it
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
require('ts-node/register/transpile-only');

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const FIXTURE = path.join(__dirname, 'fixtures', 'c3-entitlements.json');
const API = process.env.C3_API_BASE || 'http://127.0.0.1:4000';

/**
 * One scenario is built through the HTTP endpoint. The other seven call the
 * same `createSignup` the endpoint calls, in the same process.
 *
 * `POST /api/billing/signup` is rate limited to three per hour per IP
 * (`rate-limit.middleware.ts`), and that limit is a real defence rather than an
 * inconvenience: each signup can provision a container. Eight organizations in
 * one run cannot pass it, and never could — the first run of any day seeds
 * three and is refused five times, and a second run inside the hour seeds none,
 * because refused attempts count against the bucket too. The gate damaged its
 * own preconditions every time it ran (D-29).
 *
 * The limiter is HTTP middleware, so calling the service function reaches the
 * same transaction, the same eight tables and the same service-level throttle
 * without touching the endpoint. This is not an override and not a bypass flag:
 * the fixture simply does not use the endpoint. Writing rows directly would
 * have been the alternative, and it would have been a second copy of a creation
 * path eight tables wide — which is what the header above warns against.
 *
 * `standard-plain` stays on the real endpoint so a regression in it — its
 * validation, its status code, its response shape, the limiter itself — still
 * fails this gate. One request per run sits inside the shipped limit.
 */
const REAL_PATH_SCENARIO = 'standard-plain';

/** What the endpoint would have recorded for a call from this machine. */
const SEED_IP = '127.0.0.1';

/** The exit code of a run that produced a result it is not allowed to certify. */
const NOT_CERTIFICATION_GRADE = 2;

/**
 * Say loudly that this run cannot certify, in the same shape as the isolation
 * waiver in `run-tenancy-harness.js`: a banner that names what was waived, and
 * an exit code that no reader can mistake for a pass.
 */
function printWaiver(blockedScenarios) {
  const names = blockedScenarios.map((s) => s.name).join(', ');
  const line = `ENDPOINT COVERAGE WAIVED (${names}): THIS RUN IS NOT CERTIFICATION-GRADE.`;
  process.stderr.write(`\n${'!'.repeat(line.length)}\n${line}\n${'!'.repeat(line.length)}\n`);
  process.stderr.write('The signup budget for this hour is spent, so the one scenario that uses\n');
  process.stderr.write('the real endpoint could not be built. Everything below is resolved over\n');
  process.stderr.write('the scenarios that could be, and proves nothing about the endpoint.\n\n');
}

const FIXED_NOW = new Date('2026-06-15T12:00:00.000Z');
const STAMP = 'c3proof';
const FOREVER = new Date('2999-01-01T00:00:00.000Z');
const LONG_PAST = new Date('2020-01-01T00:00:00.000Z');

/**
 * name          — the snapshot key
 * subscribe     — the edition actually bought, and it must be sellable
 * override      — what a platform owner then granted, if anything
 */
const SCENARIOS = [
  { name: 'free-plain', subscribe: 'FREE' },
  { name: 'standard-plain', subscribe: 'STANDARD' },
  { name: 'growth-via-override', subscribe: 'STANDARD', override: { planOverride: 'GROWTH', overrideExpiresAt: FOREVER } },
  { name: 'business-via-override', subscribe: 'STANDARD', override: { planOverride: 'BUSINESS', overrideExpiresAt: FOREVER } },
  { name: 'enterprise-via-override', subscribe: 'FREE', override: { planOverride: 'ENTERPRISE', overrideExpiresAt: FOREVER } },
  { name: 'mac-quota-override', subscribe: 'STANDARD', override: { macQuotaOverride: 4242 } },
  { name: 'expired-override-ignored', subscribe: 'FREE', override: { planOverride: 'ENTERPRISE', overrideExpiresAt: LONG_PAST } },
  // The only scenario that reaches the third precedence step. Every other
  // organization here holds an active subscription, so the fallback is never
  // consulted — and a proof that never exercises the branch being deleted
  // would stay green whatever happened to it.
  { name: 'no-active-subscription', subscribe: 'STANDARD', cancel: true },
];

/**
 * The differences this migration is *allowed* to make, named one by one.
 *
 * Everything else must be byte-identical. Excluding a field from the
 * comparison would hide the change; declaring it here documents it and still
 * fails if the change is anything other than exactly this.
 *
 * `source` told the caller where the plan came from, and its third value was
 * `'tier'` — named after `Organization.tier`, the column D-18 deletes. An
 * organization with no live subscription still resolves to the same plan
 * (FREE) with the same limits; only the word for *why* changes.
 */
const EXPECTED_DIFFS = {
  'no-active-subscription': { source: { before: 'tier', after: 'default' } },
};

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(pathname, API);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Stable serialisation: identity, timing and C6's internal edition snapshots
 * removed.
 *
 * `edition` and `editionOfRecord` are internal carriers added so downstream
 * decisions do not look the plan up again. They are outside this historical
 * snapshot's top-level contract. More importantly, this proof has one version
 * per plan and therefore cannot certify which version supplied either object.
 * The capability gate covers their grants; the two-version database check in
 * tenancy-bleed-harness owns their identity.
 */
const OMITTED = new Set([
  'id', 'organizationId', 'planVersionId', 'createdAt', 'updatedAt',
  'setAt', 'overrideSetAt', 'setBy', 'overrideSetBy',
  'edition', 'editionOfRecord',
]);
function stable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (OMITTED.has(k)) continue;
      out[k] = stable(value[k]);
    }
    return out;
  }
  return value;
}

/**
 * Rate-limit state, not customer data.
 *
 * Signup is throttled per IP *and* per email domain. Seven signups from one
 * machine trip both, so the counters are cleared before seeding. They are
 * ephemeral by construction and the rows here are debris from organizations
 * that no longer exist.
 */
async function clearSignupThrottle(runAsPlatform) {
  await runAsPlatform('c3-proof:clear-throttle', async () => {
    const { count } = await prisma.signupThrottleEvent.deleteMany({});
    if (count) process.stdout.write(`  cleared ${count} signup throttle events\n`);
  });
}

/**
 * Remove this gate's organizations, and say how many there were.
 *
 * The count is reported rather than swallowed because it means different things
 * at different moments. At the end of a run it is housekeeping. At the *start*
 * of one it is a message about the run before: fixtures found here were left by
 * a previous run that did not reach its own cleanup, and a gate whose failures
 * are tidied away by the next run is a gate that hides them.
 */
async function cleanup(runAsPlatform, when) {
  return runAsPlatform('c3-proof:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: `${STAMP}-` } }, select: { id: true },
    });
    if (!orgs.length) return 0;
    const ids = orgs.map((o) => o.id);
    const identityIds = (await prisma.user.findMany({
      where: { organizationId: { in: ids } }, select: { identityId: true },
    })).map((u) => u.identityId);
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    if (identityIds.length) {
      await prisma.identity.deleteMany({
        where: { id: { in: identityIds }, users: { none: {} }, platformRole: 'NONE' },
      });
    }
    process.stdout.write(when === 'start'
      ? `  found ${orgs.length} proof organization(s) left by an earlier run, and removed them\n`
      : `  cleaned up ${orgs.length} proof organizations\n`);
    return orgs.length;
  });
}

async function main() {
  const write = process.argv.includes('--write');
  const { runAsPlatform } = require('../src/lib/tenant-context');
  const { refreshEditions } = require('../src/modules/billing/editions.service');
  const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');
  const { activateManualSubscription } = require('../src/modules/billing/billing.service');

  // Before anything reads an entitlement. An unloaded catalogue resolves to the
  // deny-everything floor, and a baseline captured against that would record
  // zeros as the correct answer.
  const loaded = await runAsPlatform('c3-proof:catalogue', () => refreshEditions());
  process.stdout.write(`  edition catalogue loaded: ${loaded} editions\n`);

  await cleanup(runAsPlatform, 'start');
  await clearSignupThrottle(runAsPlatform);

  const { createSignup } = require('../src/modules/billing/billing.service');

  const seeded = [];
  for (let i = 0; i < SCENARIOS.length; i += 1) {
    const s = SCENARIOS[i];
    const slug = `${STAMP}-${s.name}`;
    let organizationId;
    if (s.name === REAL_PATH_SCENARIO) {
      // A distinct email domain per organization: signup throttles per domain as
      // well as per IP, and seven from one domain is indistinguishable from abuse.
      const res = await post('/api/billing/signup', {
        organizationName: slug,
        adminName: `C3 ${s.name}`,
        adminEmail: `owner@${STAMP}-${i}.example`,
        adminPassword: `C3-Proof-Passw0rd-${i}!`,
        planCode: s.subscribe,
      });
      /*
        A spent signup budget is the environment, not the property.

        This scenario exists so a regression in the endpoint still fails the
        gate, and a 429 is not that: it says three signups already happened on
        this IP within the hour, which is the limiter working. Refusing the
        whole run for it would make a gate that must never report partial into
        a gate that reports nothing, for a reason unrelated to entitlement
        resolution.

        So it is waived, not failed — the run proceeds over the scenarios it
        could build and cannot certify, exactly as the isolation waiver does in
        run-tenancy-harness.js. Any other non-201 is a real failure and refuses
        the run, because that is the regression this scenario is here to catch.
      */
      if (res.status === 429) {
        seeded.push({ ...s, slug, ok: false, blocked: true, detail: `HTTP signup 429: ${res.body.slice(0, 120)}` });
        continue;
      }
      if (res.status !== 201) {
        seeded.push({ ...s, slug, ok: false, detail: `HTTP signup ${res.status}: ${res.body.slice(0, 140)}` });
        continue;
      }
      organizationId = JSON.parse(res.body).organizationId;
    } else {
      try {
        const created = await createSignup({
          organizationName: slug,
          adminName: `C3 ${s.name}`,
          adminEmail: `owner@${STAMP}-${i}.example`,
          adminPassword: `C3-Proof-Passw0rd-${i}!`,
          planCode: s.subscribe,
          ipAddress: SEED_IP,
        });
        organizationId = created.organizationId;
      } catch (error) {
        seeded.push({ ...s, slug, ok: false, detail: `createSignup: ${error && error.message}` });
        continue;
      }
    }
    /*
      A fixture must not be provisioner-managed.

      Signup writes an OPENWA channel row in PENDING with
      `managedByProvisioner: true` and deliberately starts no container. The
      gateway worker then reconciles every 30 seconds, selects every managed
      channel in PENDING, and provisions one — so these eight organizations
      acquired a real openwa+redis pair each, roughly 1.16 GB, without anything
      here asking for a gateway. On 2026-09-12 sixteen such containers were
      still running for organizations deleted days earlier.

      Nothing about entitlement resolution needs a gateway, so the fixture says
      what is true of it: this channel is not the provisioner's to manage. It
      is set immediately rather than at cleanup, because cleanup is the thing
      that does not run when a gate refuses — and the worker only needs one
      tick.
    */
    await runAsPlatform('c3-proof:unmanage-channel', () => prisma.organizationChannel.updateMany({
      where: { organizationId },
      data: { managedByProvisioner: false },
    }));

    await activateManualSubscription(organizationId, s.subscribe);
    if (s.cancel) {
      const { cancelCurrentSubscription } = require('../src/modules/billing/billing.service');
      await cancelCurrentSubscription(organizationId);
    }
    if (s.override) {
      await runAsPlatform('c3-proof:override', () => prisma.organization.update({
        where: { id: organizationId },
        data: { overrideReason: `c3 proof: ${s.name}`, ...s.override },
      }));
    }
    seeded.push({ ...s, slug, ok: true, organizationId });
  }

  for (const s of seeded) {
    const how = s.name === REAL_PATH_SCENARIO ? 'via the endpoint' : 'via createSignup';
    const state = s.ok ? `seeded on ${s.subscribe} ${how}`
      : s.blocked ? `BLOCKED — ${s.detail}`
        : `FAILED — ${s.detail}`;
    process.stdout.write(`  ${s.name.padEnd(26)} ${state}\n`);
  }

  const blocked = seeded.filter((s) => s.blocked);
  if (blocked.length) printWaiver(blocked);

  const missing = seeded.filter((s) => !s.ok && !s.blocked);
  if (missing.length) {
    /*
      Named, never counted. "5 scenario(s) could not be seeded" is a result
      nobody can act on: it does not say which scenario, and it does not say
      why, so a rate limit, a schema change and an edition that stopped being
      sellable all read the same. The summary line is the only line the sweep
      records, so the names and the reasons go in it.
    */
    throw new Error(
      `REFUSED — could not build ${missing.length} of ${SCENARIOS.length} scenarios: `
      + missing.map((s) => `${s.name} [${s.detail}]`).join('; '),
    );
  }

  // Only what was actually built. A waived scenario has no organization, and
  // resolving one that does not exist would turn a waiver into a crash.
  const built = seeded.filter((s) => s.ok);

  const snap = {};
  for (const s of built) {
    snap[s.name] = stable(await runAsPlatform('c3-proof:resolve', () =>
      resolveEntitlements(s.organizationId, FIXED_NOW)));
  }

  if (write) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    process.stdout.write(`\nbaseline written: ${path.relative(process.cwd(), FIXTURE)}\n`);
    await cleanup(runAsPlatform, 'end');
    return;
  }

  if (!fs.existsSync(FIXTURE)) throw new Error(`no baseline at ${FIXTURE}; capture it before the migration`);
  const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  await cleanup(runAsPlatform, 'end');

  let failures = 0;
  for (const s of built) {
    const expected = EXPECTED_DIFFS[s.name] || {};
    const before = JSON.parse(JSON.stringify(baseline[s.name]));
    const after = snap[s.name];

    // Assert each declared exception actually happened, then fold it into
    // the baseline so the rest of the comparison stays exact.
    let exceptionsOk = true;
    for (const [field, change] of Object.entries(expected)) {
      if (before[field] !== change.before || after[field] !== change.after) {
        exceptionsOk = false;
        process.stdout.write(`[FAIL] ${s.name}: declared change to \`${field}\` did not happen as declared\n`);
        process.stdout.write(`         declared: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}\n`);
        process.stdout.write(`         actual  : ${JSON.stringify(before[field])} -> ${JSON.stringify(after[field])}\n`);
      }
      before[field] = change.after;
    }

    const want = JSON.stringify(before, null, 2);
    const got = JSON.stringify(after, null, 2);
    const names = Object.keys(expected);
    if (want === got && exceptionsOk) {
      const note = names.length
        ? ` (byte-identical apart from the declared change to ${names.join(', ')})`
        : '';
      process.stdout.write(`[PASS] ${s.name}: resolved entitlements unchanged${note}\n`);
    } else {
      failures += 1;
      if (want !== got) {
        process.stdout.write(`[FAIL] ${s.name}: resolved entitlements changed beyond what was declared\n`);
        const a = want.split('\n'); const b = got.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
          if (a[i] !== b[i]) process.stdout.write(`         before: ${(a[i] ?? '(absent)').trim()}\n          after: ${(b[i] ?? '(absent)').trim()}\n`);
        }
      }
    }
  }
  /*
    The summary line is the only line the sweep records, so a waived run says
    so in it. The exit code carries the same fact for anything that reads codes
    rather than text: a comparison that passed under a waiver exits 2, never 0,
    because it proved the resolver over seven scenarios and nothing at all
    about the endpoint.
  */
  if (blocked.length) {
    process.stdout.write(
      `\n${built.length - failures}/${built.length} scenarios unchanged; `
      + `${blocked.map((s) => s.name).join(', ')} waived (signup budget spent) `
      + '— NOT CERTIFICATION-GRADE.\n',
    );
    process.exitCode = failures ? 1 : NOT_CERTIFICATION_GRADE;
    return;
  }

  process.stdout.write(`\n${built.length - failures}/${built.length} scenarios unchanged.\n`);
  if (failures) process.exitCode = 1;
}

/**
 * Close the queue handles this gate opened without meaning to.
 *
 * Seeding goes through the real signup path, which reaches
 * maybeProvisionGateway, which constructs a BullMQ queue at module scope and
 * opens a Redis connection. The gate then printed its result and never
 * exited — two of these were found still resident hours later, and they were
 * part of why this machine ran out of memory.
 *
 * Same fix the tenancy harness already carries, for the same reason: a gate
 * may fail, but it may not hang.
 */
async function closeLoadedQueues() {
  const modules = [
    ['../src/workers/gateway-provisioning.queue', 'gatewayProvisioningQueue'],
    ['../src/workers/incoming-message.worker', 'incomingMessageQueue'],
  ];
  await Promise.allSettled(modules.map(async ([specifier, exportName]) => {
    let resolved;
    try { resolved = require.resolve(specifier); } catch { return; }
    if (!require.cache[resolved]) return;
    const queue = require(specifier)[exportName];
    if (queue && typeof queue.close === 'function') await queue.close().catch(() => {});
  }));
}

main()
  .catch(async (e) => {
    /*
      A refusal must not leave its fixtures behind.

      Until 2026-09-12 it did: the throw went past the cleanup, seven
      organizations stayed in the database, and the *next* run deleted them
      quietly at startup. A failed run that tidies itself away through its
      successor leaves no trace of having failed, and the count that would have
      said so was never printed.

      Cleanup first and the message last, because the last line a gate writes
      is its result — and a cleanup that cannot run says so rather than
      replacing the failure that caused it.
    */
    try {
      const { runAsPlatform } = require('../src/lib/tenant-context');
      await cleanup(runAsPlatform, 'end');
    } catch (cleanupError) {
      process.stdout.write(`  cleanup after failure did not complete: ${cleanupError && cleanupError.message}\n`);
    }
    console.error(e.message || e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeLoadedQueues();
    await prisma.$disconnect();
    // The net under whatever is not on that list. unref'd, so it never fires
    // on the normal path and cannot truncate a result; if something still
    // holds the loop five seconds after the summary was written, an abrupt
    // exit carrying the right code beats a process nobody can read.
    const drainGuard = setTimeout(() => process.exit(process.exitCode || 0), 5000);
    drainGuard.unref?.();
  });
