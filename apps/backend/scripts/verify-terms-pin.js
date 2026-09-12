#!/usr/bin/env node
/**
 * The terms a customer bought must survive the moment they pay for them.
 *
 * ## Why this gate exists
 *
 * A subscription pins a `PlanVersion` — the edition *as it was defined when the
 * customer bought it* (D-19). Resolution reads that pin exactly. The write path
 * did not: `activateManualSubscription` took a plan code and, for an existing
 * subscription, replaced `planVersionId` with the code's **current** version and
 * then rewrote `OrganizationConfig` from the **current** catalogue.
 *
 * Two production paths reach that writer, and both derive the plan code from the
 * subscription itself: the payment webhook and provider reconciliation. So a
 * customer who bought v1 and paid after v2 was published silently received v2's
 * price, seats and limits — the pin held at signup and broke at the till (D-23,
 * D-24).
 *
 * ## What it asserts, and why in two scenarios
 *
 * Preserving the pin unconditionally would be the wrong fix. An edition change
 * is a new purchase: STANDARD → GROWTH is the customer choosing new terms at
 * today's price, and must land on GROWTH's current version. Moving between
 * versions of the *same* edition without the customer choosing it is the defect.
 * So the gate asserts both halves — same code holds the pin, different code
 * moves to the new edition's current version — because a fix that only ever
 * preserved would pass a one-scenario gate and break upgrades.
 *
 * ## Why a fixture edition
 *
 * Publishing a new version of a real edition would change the product catalogue
 * every time this ran, and leave a version trail nobody chose. The gate creates
 * its own edition through the real creation path, publishes its second version
 * through the real publication path, and deletes both afterwards.
 *
 * The two versions differ in **price and limit together**. A fixture whose
 * fields coincide cannot see a mis-wire between them: reading the right version
 * for the price and the wrong one for the limit would pass.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

require('ts-node/register/transpile-only');

const { prisma } = require('../src/prisma');
const { runAsPlatform, runAsOrganization } = require('../src/lib/tenant-context');
const { refreshEditions, createEditionRows, applyEditionChanges } = require('../src/modules/billing/editions.service');
const { createSignup, activateManualSubscription } = require('../src/modules/billing/billing.service');
const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const STAMP = Date.now();
const SOLD = `TERMSPIN${STAMP % 100000}`;
const OTHER = `TERMSPINUP${STAMP % 100000}`;
const SLUG = `termspin-${STAMP}`;

/** v1 of the edition the customer buys, and v2 published after they bought it. */
const SOLD_V1 = { monthlyPriceCents: 1900, monthlyActiveContactsLimit: 100 };
const SOLD_V2 = { monthlyPriceCents: 4900, monthlyActiveContactsLimit: 500 };
/** A different edition entirely: an upgrade, which must land on current terms. */
const OTHER_V1 = { monthlyPriceCents: 9900, monthlyActiveContactsLimit: 2000 };

const editionFields = (numbers) => ({
  name: 'Terms pin gate',
  pricingModel: 'FIXED',
  currency: 'ILS',
  billingInterval: 'MONTHLY',
  allowedChannels: ['OPENWA'],
  monthlyOutboundMessagesLimit: 1000,
  monthlyCampaignSendsLimit: 1000,
  usersLimit: 3,
  ...numbers,
});

async function seedEditions() {
  await runAsPlatform('terms-pin:create-editions', async () => {
    await createEditionRows(prisma, SOLD, `plan_${SOLD.toLowerCase()}`, editionFields(SOLD_V1));
    await createEditionRows(prisma, OTHER, `plan_${OTHER.toLowerCase()}`, editionFields(OTHER_V1));
  });
  await runAsPlatform('terms-pin:refresh', () => refreshEditions());
}

/** The real publication path, the one the platform console calls. */
async function publishSecondVersion() {
  await runAsPlatform('terms-pin:publish', () =>
    prisma.$transaction((tx) => applyEditionChanges(tx, SOLD, { ...SOLD_V2 })));
  await runAsPlatform('terms-pin:refresh', () => refreshEditions());
}

async function seedSubscriber() {
  const created = await createSignup({
    organizationName: SLUG,
    adminName: 'Terms Pin Gate',
    adminEmail: `owner@${SLUG}.example`,
    adminPassword: `Terms-Pin-Passw0rd-${STAMP}!`,
    planCode: 'FREE',
    ipAddress: '127.0.0.1',
  });
  // Signup is on a sellable edition; the purchase under test is the activation.
  await activateManualSubscription(created.organizationId, SOLD);
  return created.organizationId;
}

/** What the subscriber is pinned to, and what is actually enforced on them. */
async function termsOf(organizationId) {
  return runAsPlatform('terms-pin:read', async () => {
    const subscription = await prisma.subscription.findFirst({
      where: { organizationId, status: { not: 'CANCELED' } },
      orderBy: { createdAt: 'desc' },
      select: {
        planVersionId: true,
        planVersion: { select: { version: true, plan: { select: { code: true } } } },
      },
    });
    const config = await prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: { monthlyActiveContactsLimit: true },
    });
    const resolved = await resolveEntitlements(organizationId, new Date());
    return {
      planVersionId: subscription && subscription.planVersionId,
      version: subscription && subscription.planVersion.version,
      code: subscription && subscription.planVersion.plan.code,
      configuredMac: config && Number(config.monthlyActiveContactsLimit),
      resolvedMac: resolved.limits.active_contacts === null ? null : Number(resolved.limits.active_contacts),
      resolvedPrice: Number(resolved.listPriceCents),
    };
  });
}

async function cleanup() {
  await runAsPlatform('terms-pin:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: 'termspin-' } }, select: { id: true },
    });
    if (orgs.length) {
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
    }
    const plans = await prisma.plan.findMany({
      where: { code: { startsWith: 'TERMSPIN' } }, select: { id: true },
    });
    if (plans.length) {
      const planIds = plans.map((p) => p.id);
      const versions = await prisma.planVersion.findMany({
        where: { planId: { in: planIds } }, select: { id: true },
      });
      const versionIds = versions.map((v) => v.id);
      if (versionIds.length) await prisma.price.deleteMany({ where: { planVersionId: { in: versionIds } } });
      await prisma.planVersion.deleteMany({ where: { planId: { in: planIds } } });
      await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
    }
    if (orgs.length || plans.length) {
      process.stdout.write(`  cleaned up ${orgs.length} organization(s) and ${plans.length} fixture edition(s)\n`);
    }
  });
  await runAsPlatform('terms-pin:refresh', () => refreshEditions());
}

/**
 * The two production callers must reach terms only through the one writer.
 *
 * Asserted from the source rather than by forging a signed provider payload:
 * what matters is that neither path has a writer of its own to get wrong, and
 * that is a property of the code, not of a round trip.
 */
function noIndependentWriter() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'src'));

  // A write, not a mention. `planVersionId` appears in type declarations and in
  // API responses all over this codebase; what matters is the argument of a
  // subscription create or update, so the scan starts from the call and looks
  // inside it rather than matching the field name anywhere it occurs.
  const writers = [];
  const CALL = /\.subscription\.(?:update|create|upsert)\(/g;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    let match;
    CALL.lastIndex = 0;
    while ((match = CALL.exec(text)) !== null) {
      const body = text.slice(match.index, match.index + 1200);
      if (!/planVersionId:/.test(body)) continue;
      writers.push(`${rel}:${text.slice(0, match.index).split(/\r?\n/).length}`);
    }
  }
  const outside = writers.filter((w) => !w.startsWith('src/modules/billing/billing.service.ts:'));
  check('the subscription pin is written in one file, so both payment paths share one writer',
    outside.length === 0,
    `also written at ${outside.join(', ')}`);

  const billing = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'billing', 'billing.service.ts'), 'utf8');
  const callers = (billing.match(/await activateManualSubscription\(/g) || []).length;
  check('the payment webhook and reconciliation both go through that writer',
    callers >= 2,
    `found ${callers} call(s) to activateManualSubscription in billing.service.ts`);
}

async function main() {
  await cleanup();
  await seedEditions();

  const organizationId = await seedSubscriber();
  const sold = await termsOf(organizationId);
  process.stdout.write(`  bought ${sold.code} v${sold.version}: price ${sold.resolvedPrice}, contacts ${sold.configuredMac}\n`);

  await publishSecondVersion();
  process.stdout.write(`  published ${SOLD} v2: price ${SOLD_V2.monthlyPriceCents}, contacts ${SOLD_V2.monthlyActiveContactsLimit}\n`);

  // The re-activation a payment webhook or a reconciliation performs: same
  // edition, same customer, no choice made by them.
  await activateManualSubscription(organizationId, SOLD);
  const after = await termsOf(organizationId);

  check('paying does not move the subscriber onto a version published after they bought',
    after.planVersionId === sold.planVersionId,
    `pinned v${sold.version} at purchase, now v${after.version} — the customer bought one set of `
    + 'terms and a payment event replaced it with another');

  check('the enforced contact limit is still the one they bought',
    after.configuredMac === SOLD_V1.monthlyActiveContactsLimit,
    `OrganizationConfig says ${after.configuredMac}, they bought ${SOLD_V1.monthlyActiveContactsLimit} `
    + `and v2 says ${SOLD_V2.monthlyActiveContactsLimit}`);

  check('resolved entitlements still carry the purchased price and limit',
    after.resolvedPrice === SOLD_V1.monthlyPriceCents && after.resolvedMac === SOLD_V1.monthlyActiveContactsLimit,
    `resolves to price ${after.resolvedPrice} / contacts ${after.resolvedMac}, bought `
    + `${SOLD_V1.monthlyPriceCents} / ${SOLD_V1.monthlyActiveContactsLimit}`);

  // The other half: an edition change is a new purchase and must land on the
  // new edition's current terms. A fix that preserved the pin unconditionally
  // would break every upgrade, and would pass the three checks above.
  await activateManualSubscription(organizationId, OTHER);
  const upgraded = await termsOf(organizationId);

  check('changing edition moves to the new edition, at its current terms',
    upgraded.code === OTHER && upgraded.resolvedPrice === OTHER_V1.monthlyPriceCents
      && upgraded.configuredMac === OTHER_V1.monthlyActiveContactsLimit,
    `after activating ${OTHER} the subscriber is on ${upgraded.code} v${upgraded.version} at price `
    + `${upgraded.resolvedPrice} / contacts ${upgraded.configuredMac}`);

  noIndependentWriter();

  await cleanup();
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch(async (error) => {
    try { await cleanup(); } catch (cleanupError) {
      process.stdout.write(`  cleanup after failure did not complete: ${cleanupError && cleanupError.message}\n`);
    }
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(process.exitCode || 0);
  });
