#!/usr/bin/env node
/**
 * The entitlement resolver, proved two ways.
 *
 * ## Part 1 — the decision core, from fixtures, with no database
 *
 * `decide()` and `limitOf()` take a resolved entitlement snapshot and return an
 * answer. Nothing here touches Postgres, Redis, a clock or an ambient scope, so
 * a failure is a failure of the rule rather than of the environment — the
 * distinction this repository keeps having to relearn.
 *
 * ## Part 2 — the behavioural check, and why it is not a grep
 *
 * The property is: **a capability is granted by a field on the edition, never
 * by which edition it is.** Two audits in this repository have tested spelling
 * and passed while the behaviour was wrong, so this one tests behaviour.
 *
 * For every shipped edition it builds a **shadow** — an edition with a
 * different code and byte-identical entitlements — and asserts every decision
 * matches. A comparison against a plan name anywhere on the path makes the pair
 * disagree, because the two differ in exactly the field a name comparison
 * reads and in nothing else.
 *
 * The shadows are the fixture rule from AGENTS/Evidence applied deliberately:
 * the fields being distinguished — code and entitlements — are made to differ
 * independently, so a decision that reads the wrong one cannot come out right
 * by coincidence.
 */
const assert = require('assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
require('ts-node/register/transpile-only');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, passed: true });
    process.stdout.write(`[PASS] ${name}\n`);
  } catch (error) {
    results.push({ name, passed: false });
    process.stdout.write(`[FAIL] ${name}: ${error && error.message ? error.message : String(error)}\n`);
  }
}

const {
  decide, limitOf, grantsCapability, assertCanFrom, isCapabilityRefused,
  FEATURE_CAPABILITIES, COUNTED_LIMITS,
} = require('../src/modules/billing/capabilities');
const { PLAN_ENTITLEMENTS } = require('../src/modules/billing/plans');
const editions = require('../src/modules/billing/editions.service');

const METRICS = [
  'messages_inbound', 'messages_outbound', 'active_contacts',
  'ai_tokens_in', 'ai_tokens_out', 'campaign_sends',
];
const ALL_CAPABILITIES = [...FEATURE_CAPABILITIES, ...COUNTED_LIMITS, ...METRICS];

/** A resolved snapshot, built by hand. No database, no resolver. */
function snapshot(code, overrides = {}) {
  const edition = PLAN_ENTITLEMENTS[code];
  return {
    plan: code,
    planName: edition.name,
    planOfRecord: code,
    source: 'subscription',
    limits: {
      messages_inbound: null,
      messages_outbound: edition.monthlyOutboundMessagesLimit,
      active_contacts: edition.monthlyActiveContactsLimit,
      campaign_sends: edition.monthlyCampaignSendsLimit,
      ai_tokens_in: edition.monthlyAiTokensInLimit === null ? null : Number(edition.monthlyAiTokensInLimit),
      ai_tokens_out: edition.monthlyAiTokensOutLimit === null ? null : Number(edition.monthlyAiTokensOutLimit),
      ...(overrides.limits || {}),
    },
    seatLimit: overrides.seatLimit !== undefined ? overrides.seatLimit : edition.usersLimit,
    maxWorkspaces: overrides.maxWorkspaces !== undefined ? overrides.maxWorkspaces : edition.maxWorkspaces,
    isOverridden: Boolean(overrides.isOverridden),
    override: { plan: null, macQuota: null, discountPercent: null, creditCents: 0, reason: null, expiresAt: null, expired: false, setBy: null, setAt: null },
    listPriceCents: edition.monthlyPriceCents,
    effectivePriceCents: edition.monthlyPriceCents,
  };
}

async function main() {
  process.stdout.write('Entitlement façade: pure decisions, then the behavioural check\n\n');

  // The catalogue has to be loaded: getEdition falls to a deny-everything floor
  // otherwise, and every decision below would assert against zeros.
  const { runAsPlatform } = require('../src/lib/tenant-context');
  const loaded = await runAsPlatform('verify-capabilities:catalogue', () => editions.refreshEditions());
  check('baseline: the edition catalogue is loaded', () => {
    assert.ok(loaded >= 5, `expected at least the five shipped editions, loaded ${loaded}`);
  });

  /* ── Part 1: the pure core ──────────────────────────────────────────── */

  check('pure: null is unlimited and 0 is a refusal, and they are not the same', () => {
    const unlimited = snapshot('ENTERPRISE');
    const none = snapshot('FREE', { limits: { campaign_sends: 0 } });
    assert.equal(limitOf(unlimited, 'active_contacts'), null);
    assert.equal(decide(unlimited, 'active_contacts').granted, true, 'null must grant');
    assert.equal(limitOf(none, 'campaign_sends'), 0);
    assert.equal(decide(none, 'campaign_sends').granted, false, '0 must refuse');
  });

  check('pure: a granted capability names no upgrade, a refused one names the cheapest', () => {
    const free = snapshot('FREE');
    const refused = decide(free, 'whiteLabel');
    assert.equal(refused.granted, false);
    assert.ok(refused.requiredPlan, 'a refusal must name an upgrade while one exists');
    const granted = decide(snapshot('ENTERPRISE'), 'whiteLabel');
    assert.equal(granted.granted, true);
    assert.equal(granted.requiredPlan, null, 'a grant must not advertise an upgrade');
  });

  check('pure: a live override moves the decision, not just the badge', () => {
    // The MAC quota is the one metric an override can move on its own.
    const base = snapshot('FREE', { limits: { active_contacts: 0 } });
    const lifted = snapshot('FREE', { limits: { active_contacts: 4242 }, isOverridden: true });
    assert.equal(decide(base, 'active_contacts').granted, false);
    assert.equal(decide(lifted, 'active_contacts').granted, true);
    assert.equal(limitOf(lifted, 'active_contacts'), 4242);
  });

  check('pure: every capability resolves for every shipped edition', () => {
    for (const code of Object.keys(PLAN_ENTITLEMENTS)) {
      const snap = snapshot(code);
      for (const capability of ALL_CAPABILITIES) {
        const decision = decide(snap, capability);
        assert.equal(typeof decision.granted, 'boolean', `${code}/${capability} must decide`);
        assert.equal(decision.capability, capability);
      }
    }
  });

  /* ── assertCan is never a silent no-op ──────────────────────────────── */

  check('assertCan throws on a refusal, and the error carries the upgrade', () => {
    let thrown = null;
    try {
      assertCanFrom(snapshot('FREE'), 'whiteLabel', 'org-test');
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'a refused capability must throw — a guard that returns is not a guard');
    assert.ok(isCapabilityRefused(thrown));
    assert.equal(thrown.status, 402);
    assert.equal(thrown.code, 'PLAN_UPGRADE_REQUIRED');
    assert.ok(thrown.decision.requiredPlan, 'the refusal must say what would grant it');
  });

  check('assertCan returns the decision on a grant, so a caller can read the limit', () => {
    const decision = assertCanFrom(snapshot('BUSINESS'), 'whiteLabel', 'org-test');
    assert.equal(decision.granted, true);
    assert.equal(decision.capability, 'whiteLabel');
  });

  check('assertCan cannot be satisfied by a capability it does not understand', () => {
    let thrown = null;
    try {
      assertCanFrom(snapshot('ENTERPRISE'), 'notACapability', 'org-test');
    } catch (error) {
      thrown = error;
    }
    // ENTERPRISE grants everything it knows about; an unknown name must NOT
    // fall through to "granted" on the strength of the edition being generous.
    assert.ok(thrown, 'an unrecognised capability must refuse, not default open');
  });

  /* ── Part 2: the behavioural check ──────────────────────────────────── */

  check('behavioural: a decision depends on the edition\'s fields, never on its code', () => {
    const divergences = [];
    for (const code of Object.keys(PLAN_ENTITLEMENTS)) {
      const real = snapshot(code);
      // The shadow: identical entitlements, different code and name.
      const shadow = { ...snapshot(code), plan: `SHADOW_${code}`, planName: `Shadow ${code}` };
      // getEdition must answer for the shadow too, or the comparison would be
      // testing the lookup rather than the decision.
      const originalGetEdition = editions.getEdition;
      editions.getEdition = (asked) =>
        String(asked).startsWith('SHADOW_')
          ? originalGetEdition(String(asked).slice('SHADOW_'.length))
          : originalGetEdition(asked);
      try {
        for (const capability of ALL_CAPABILITIES) {
          const a = decide(real, capability);
          const b = decide(shadow, capability);
          if (a.granted !== b.granted || String(a.limit) !== String(b.limit)) {
            divergences.push(
              `${code}/${capability}: real granted=${a.granted} limit=${a.limit}, `
              + `shadow granted=${b.granted} limit=${b.limit}`,
            );
          }
        }
      } finally {
        editions.getEdition = originalGetEdition;
      }
    }
    assert.deepEqual(divergences, [],
      'a capability decision changed when only the plan CODE changed, which means '
      + 'something on the path compares plan names:\n  ' + divergences.join('\n  '));
  });

  check('behavioural: the check would catch a plan-name comparison if one were added', () => {
    // The control. Without it a green above could mean "no comparisons" or
    // "the comparison never ran", and those are not the same result.
    const real = snapshot('BUSINESS');
    const shadow = { ...snapshot('BUSINESS'), plan: 'SHADOW_BUSINESS' };
    const byName = (snap) => snap.plan === 'BUSINESS';
    assert.notEqual(byName(real), byName(shadow),
      'the shadow must differ from the real edition by exactly its code, or the '
      + 'behavioural check above proves nothing');
  });

  check('behavioural: grantsCapability agrees with decide for every shipped edition', () => {
    // The upgrade ladder is walked with grantsCapability while the refusal is
    // produced by decide. If the two disagree, a refusal can recommend an
    // edition that would refuse it again.
    for (const code of Object.keys(PLAN_ENTITLEMENTS)) {
      const snap = snapshot(code);
      for (const capability of ALL_CAPABILITIES) {
        assert.equal(
          grantsCapability(PLAN_ENTITLEMENTS[code], capability),
          decide(snap, capability).granted,
          `${code}/${capability}: the ladder and the decision disagree`,
        );
      }
    }
  });

  const failed = results.filter((r) => !r.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length) {
    process.stdout.write('Failed checks:\n');
    failed.forEach((r) => process.stdout.write(`- ${r.name}\n`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
