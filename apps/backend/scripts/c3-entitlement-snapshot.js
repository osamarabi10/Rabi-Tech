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
 * its own subjects through the **real signup path**
 * (`POST /api/billing/signup`, then `activateManualSubscription`), because rows
 * written straight into the tables would prove the resolver agrees with my idea
 * of a subscription rather than with the one the product actually creates.
 *
 * ## Why editions are reached by override, not by subscribing to each
 *
 * Only FREE and STANDARD can be signed up for on this platform. The other three
 * are refused at signup with `PLAN_CHANNEL_UNAVAILABLE`, because
 * `editionOfferability` withdraws any edition whose only channel the platform
 * cannot operate, and the Meta credentials are absent (D-9). That refusal is
 * correct product behaviour and not something a test should route around.
 *
 * So every organization here is created through the real signup path on an
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

/** Stable serialisation: sorted keys, identity and timing removed. */
const VOLATILE = new Set(['id', 'organizationId', 'planVersionId', 'createdAt', 'updatedAt', 'setAt', 'overrideSetAt', 'setBy', 'overrideSetBy']);
function stable(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE.has(k)) continue;
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

async function cleanup(runAsPlatform) {
  await runAsPlatform('c3-proof:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: `${STAMP}-` } }, select: { id: true },
    });
    if (!orgs.length) return;
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
    process.stdout.write(`  cleaned up ${orgs.length} proof organizations\n`);
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

  await cleanup(runAsPlatform);
  await clearSignupThrottle(runAsPlatform);

  const seeded = [];
  for (let i = 0; i < SCENARIOS.length; i += 1) {
    const s = SCENARIOS[i];
    const slug = `${STAMP}-${s.name}`;
    // A distinct email domain per organization: signup throttles per domain as
    // well as per IP, and seven from one domain is indistinguishable from abuse.
    const res = await post('/api/billing/signup', {
      organizationName: slug,
      adminName: `C3 ${s.name}`,
      adminEmail: `owner@${STAMP}-${i}.example`,
      adminPassword: `C3-Proof-Passw0rd-${i}!`,
      planCode: s.subscribe,
    });
    if (res.status !== 201) {
      seeded.push({ ...s, slug, ok: false, detail: `signup ${res.status}: ${res.body.slice(0, 140)}` });
      continue;
    }
    const { organizationId } = JSON.parse(res.body);
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
    process.stdout.write(`  ${s.name.padEnd(26)} ${s.ok ? 'seeded on ' + s.subscribe : 'FAILED — ' + s.detail}\n`);
  }
  const missing = seeded.filter((s) => !s.ok);
  if (missing.length) throw new Error(`${missing.length} scenario(s) could not be seeded; the proof would be partial`);

  const snap = {};
  for (const s of seeded) {
    snap[s.name] = stable(await runAsPlatform('c3-proof:resolve', () =>
      resolveEntitlements(s.organizationId, FIXED_NOW)));
  }

  if (write) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    process.stdout.write(`\nbaseline written: ${path.relative(process.cwd(), FIXTURE)}\n`);
    await cleanup(runAsPlatform);
    return;
  }

  if (!fs.existsSync(FIXTURE)) throw new Error(`no baseline at ${FIXTURE}; capture it before the migration`);
  const baseline = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  await cleanup(runAsPlatform);

  let failures = 0;
  for (const s of SCENARIOS) {
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
  process.stdout.write(`\n${SCENARIOS.length - failures}/${SCENARIOS.length} scenarios unchanged.\n`);
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
  .catch((e) => { console.error(e.message || e); process.exitCode = 1; })
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
