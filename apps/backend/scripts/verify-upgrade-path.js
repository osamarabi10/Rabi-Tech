#!/usr/bin/env node
/**
 * A customer who decides to buy must be able to buy, on the organization they
 * already have.
 *
 * ## Why this gate exists
 *
 * `/pricing` offered every visitor `/signup?plan=X`, signed in or not, and six
 * in-product routes lead there: the trial banner, the upgrade prompt, Settings,
 * the abandoned-checkout page, and the access gate's own TRIAL_EXPIRED and
 * SUBSCRIBER_SUSPENDED redirects. So the customer whose trial had just expired -
 * the likeliest buyer in the product - was sent by our own code to a form that
 * creates a *second* organization.
 *
 * Both branches of that dead-ended. Signing up with the same address is refused
 * with "Administrator email is already in use": the customer is told their email
 * is taken, by themselves. Signing up with a different address builds a second
 * organization with its own trial, its own channel and its own session, while
 * the paired WhatsApp number, the contacts and the history stay on the first.
 *
 * And there was no endpoint to call instead. The billing router had signup,
 * verification, checkout-status, current, summary and cancel - nothing an
 * authenticated customer could use to purchase.
 *
 * ## Pinned at purchase, not at activation
 *
 * D-24 made activation preserve the version a customer bought. That is about
 * paying for what you already have. A *purchase* has the same requirement one
 * step earlier: the terms a customer agreed to are the ones on the screen when
 * they clicked, not the ones current whenever the payment is confirmed - which
 * with the manual provider can be the next day, after a new version is
 * published.
 *
 * So the checkout carries the version. The provider stores it where it stores
 * the rest of the purchase - the manual provider in its reference, Stripe in
 * session metadata - and activation pins exactly that, rather than re-deriving
 * today's version from a plan code, which is the defect D-23 named.
 *
 * ## What it asserts about the route
 *
 * Two properties no behavioural check can see from in-process: that the handler
 * reads the organization from the session and never from the request body, and
 * that its path was not added to the auth-exempt list in index.ts. Both are
 * read from the source, because both are the difference between an upgrade and
 * a way to buy things for other people's organizations.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

require('ts-node/register/transpile-only');

const { prisma } = require('../src/prisma');
const { runAsPlatform } = require('../src/lib/tenant-context');
const { refreshEditions, createEditionRows, applyEditionChanges } = require('../src/modules/billing/editions.service');
const billing = require('../src/modules/billing/billing.service');
const { getPaymentProvider } = require('../src/modules/billing/provider-registry');
const { currentVersionIdForPlan } = require('../src/modules/billing/subscription-plan');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND = path.resolve(ROOT, '..', 'frontend');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const STAMP = Date.now();
const SOLD = `UPGRADE${STAMP % 100000}`;
const SLUG = `upgradepath-${STAMP}`;

const V1 = { monthlyPriceCents: 2900, monthlyActiveContactsLimit: 250 };
const V2 = { monthlyPriceCents: 7900, monthlyActiveContactsLimit: 750 };

const editionFields = (numbers) => ({
  name: 'Upgrade path gate',
  pricingModel: 'FIXED',
  currency: 'ILS',
  billingInterval: 'MONTHLY',
  allowedChannels: ['OPENWA'],
  monthlyOutboundMessagesLimit: 5000,
  monthlyCampaignSendsLimit: 5000,
  usersLimit: 5,
  ...numbers,
});

async function cleanup() {
  await runAsPlatform('upgrade-path:cleanup', async () => {
    const orgs = await prisma.organization.findMany({
      where: { slug: { startsWith: 'upgradepath-' } }, select: { id: true },
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
      where: { code: { startsWith: 'UPGRADE' } }, select: { id: true },
    });
    if (plans.length) {
      const planIds = plans.map((p) => p.id);
      const versionIds = (await prisma.planVersion.findMany({
        where: { planId: { in: planIds } }, select: { id: true },
      })).map((v) => v.id);
      if (versionIds.length) await prisma.price.deleteMany({ where: { planVersionId: { in: versionIds } } });
      await prisma.planVersion.deleteMany({ where: { planId: { in: planIds } } });
      await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
    }
    if (orgs.length || plans.length) {
      process.stdout.write(`  cleaned up ${orgs.length} organization(s) and ${plans.length} fixture edition(s)\n`);
    }
  });
  await runAsPlatform('upgrade-path:refresh', () => refreshEditions());
}

/** The handler must take the organization from the session, and the path must stay authenticated. */
function routeIsScopedAndAuthenticated() {
  const routes = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'billing', 'billing.routes.ts'), 'utf8');
  const handler = /router\.post\(\s*'\/upgrade'[\s\S]{0,800}?\n\}\);/.exec(routes);

  check('the billing router exposes an authenticated upgrade route',
    Boolean(handler),
    'no POST /upgrade handler in billing.routes.ts');

  if (handler) {
    const body = handler[0];
    check('the upgrade route takes the organization from the session, never from the request body',
      /req\.user!?\.organizationId/.test(body) && !/req\.body\.organizationId/.test(body),
      'a handler that accepts an organizationId from the caller is a way to buy things for other tenants');
  } else {
    failed += 1;
    console.log('[FAIL] the upgrade route takes the organization from the session, never from the request body — no handler to read');
  }

  const index = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
  const exemptBlock = index.slice(0, index.indexOf('@auth-exempt /v1'));
  check('the upgrade route was not added to the auth-exempt list',
    !/\/billing\/upgrade/.test(exemptBlock),
    'checkout-status is exempt because a checkout can precede a tenant; an upgrade always has one');
}

/**
 * A signed-in customer must not be offered a signup form.
 *
 * Read from the page rather than from a browser because the property is which
 * branch exists, not how it renders: `/signup?plan=` must be reachable only
 * where there is no session. The six in-product routes to /pricing all land on
 * this one decision, so a page that offers signup to a session is the entire
 * upgrade funnel pointing at a second account.
 */
function pricingOffersPurchaseToASession() {
  const page = fs.readFileSync(path.join(FRONTEND, 'app', 'pricing', 'page.tsx'), 'utf8');
  const signedInBranch = /signedIn \? \(([\s\S]{0,3000}?)\) : \(/.exec(page);

  check('the pricing page has a branch for a customer who is already signed in',
    Boolean(signedInBranch),
    'no signedIn branch: every visitor gets the same call to action');

  check('a signed-in customer is offered a purchase, not a signup form',
    Boolean(signedInBranch) && !/\/signup\?plan=/.test(signedInBranch[1])
      && /startPurchase\(/.test(signedInBranch[1]),
    'the branch shown to a session still links to /signup, which is where the second organization comes from');
}

/** The destination a paying customer is sent to must exist. */
function manualDestinationExists() {
  const provider = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'billing', 'manual.provider.ts'), 'utf8');
  const url = /checkoutUrl: `\$\{appBaseUrl\(\)\}\/([a-z0-9-]+)/i.exec(provider);
  if (!url) {
    check('the manual provider names a destination', false, 'could not read the checkout URL it builds');
    return;
  }
  const route = url[1];
  const page = path.join(FRONTEND, 'app', route, 'page.tsx');
  check(`the destination the manual provider sends customers to exists (/${route})`,
    fs.existsSync(page),
    `${path.relative(path.resolve(ROOT, '..', '..'), page).replace(/\\/g, '/')} does not exist, so a customer who chooses to pay lands on a 404`);
}

/**
 * Give this gate back the budget it spends on itself.
 *
 * Seeding through `createSignup` writes a `SignupThrottleEvent`, and the
 * service refuses at ten per IP per hour. Between this gate, the entitlement
 * proof and the terms-pin gate, an evening of runs exhausts it and every later
 * run fails with "Too many signups from this network" - a gate consuming the
 * resource it needs in order to run, which is D-29's class at a second limiter.
 *
 * The rows are the limiter, so deleting them is the reset; there is nothing
 * in-memory to escape. That is also why calling the service function rather
 * than the endpoint did not help: the HTTP limiter and this one are different
 * mechanisms, and only the first was avoided.
 *
 * Cleared rather than hand-writing the eight tables signup creates, which would
 * be a second copy of a creation path that drifts - the objection the
 * entitlement proof's own header raises against exactly that shortcut.
 */
async function clearSignupThrottle() {
  await runAsPlatform('upgrade-path:clear-throttle', async () => {
    const { count } = await prisma.signupThrottleEvent.deleteMany({});
    if (count) process.stdout.write(`  cleared ${count} signup throttle event(s) this gate and its siblings filed\n`);
  });
}

async function main() {
  await cleanup();
  await clearSignupThrottle();

  await runAsPlatform('upgrade-path:create-edition', () =>
    createEditionRows(prisma, SOLD, `plan_${SOLD.toLowerCase()}`, editionFields(V1)));
  await runAsPlatform('upgrade-path:refresh', () => refreshEditions());

  const created = await billing.createSignup({
    organizationName: SLUG,
    adminName: 'Upgrade Path Gate',
    adminEmail: `owner@${SLUG}.example`,
    adminPassword: `Upgrade-Path-Passw0rd-${STAMP}!`,
    planCode: 'FREE',
    ipAddress: '127.0.0.1',
  });
  const organizationId = created.organizationId;

  const before = await runAsPlatform('upgrade-path:census', () => prisma.organization.count());
  const subscriptionBefore = await runAsPlatform('upgrade-path:read', () =>
    prisma.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' }, select: { id: true } }));

  if (typeof billing.startUpgradeCheckout !== 'function') {
    for (const label of [
      'a signed-in customer can start a purchase without creating a second organization',
      'the purchase attaches to the subscription they already have',
      'the checkout records the version that was on the screen when they clicked',
      'activation pins the version bought, not the version current when payment lands',
    ]) {
      failed += 1;
      console.log(`[FAIL] ${label} — billing.service exports no startUpgradeCheckout: there is no way for an existing customer to buy`);
    }
    routeIsScopedAndAuthenticated();
    manualDestinationExists();
    await cleanup();
    console.log(`${passed}/${passed + failed} checks passed.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const purchase = await billing.startUpgradeCheckout(organizationId, SOLD);
  const after = await runAsPlatform('upgrade-path:census', () => prisma.organization.count());

  check('a signed-in customer can start a purchase without creating a second organization',
    after === before,
    `organizations went from ${before} to ${after} — buying must not fork the account`);

  const subscriptionAfter = await runAsPlatform('upgrade-path:read', () =>
    prisma.subscription.findFirst({
      where: { organizationId }, orderBy: { createdAt: 'desc' },
      select: { id: true, externalRef: true },
    }));

  check('the purchase attaches to the subscription they already have',
    subscriptionAfter && subscriptionBefore && subscriptionAfter.id === subscriptionBefore.id
      && subscriptionAfter.externalRef === purchase.externalRef,
    `subscription ${subscriptionBefore && subscriptionBefore.id} -> ${subscriptionAfter && subscriptionAfter.id}, `
    + `externalRef ${subscriptionAfter && subscriptionAfter.externalRef} vs checkout ${purchase.externalRef}`);

  const status = await getPaymentProvider().getCheckoutStatus(purchase.externalRef);
  check('the checkout records the version that was on the screen when they clicked',
    status.planVersionId === purchase.planVersionId,
    `checkout says ${status.planVersionId}, purchase was ${purchase.planVersionId}`);

  // A new version lands between the click and the payment - which with a manual
  // provider is an ordinary afternoon.
  await runAsPlatform('upgrade-path:publish', () =>
    prisma.$transaction((tx) => applyEditionChanges(tx, SOLD, { ...V2 })));
  await runAsPlatform('upgrade-path:refresh', () => refreshEditions());

  await billing.activateManualSubscription(organizationId, SOLD, {}, purchase.planVersionId);
  const activated = await runAsPlatform('upgrade-path:read', () =>
    prisma.subscription.findFirst({
      where: { organizationId }, orderBy: { createdAt: 'desc' },
      select: { planVersionId: true, planVersion: { select: { version: true } } },
    }));
  const config = await runAsPlatform('upgrade-path:read', () =>
    prisma.organizationConfig.findUnique({
      where: { organizationId }, select: { monthlyActiveContactsLimit: true },
    }));

  check('activation pins the version bought, not the version current when payment lands',
    activated && activated.planVersionId === purchase.planVersionId
      && config && Number(config.monthlyActiveContactsLimit) === V1.monthlyActiveContactsLimit,
    `activated on v${activated && activated.planVersion.version} with contacts `
    + `${config && Number(config.monthlyActiveContactsLimit)}; they bought v1 with ${V1.monthlyActiveContactsLimit}`);

  /*
    The guard that decides whether option 3 works or re-creates D-24 quietly.

    The version a customer bought lives with the checkout, which is external
    state: Stripe metadata can be absent, a reference can be malformed, and a
    checkout created before this existed carries no version at all. If
    activation answers that by falling back to the current version, the defect
    D-24 fixed returns through the door built to close it - and every happy-path
    test still passes.

    So: a legacy reference, the real signed webhook, and the subscription must
    not move.
  */
  // Put them back where a buyer actually stands: on the edition they hold, with
  // an open checkout for a different one. The guard only governs a *purchase* -
  // a payment for terms already held keeps its pin and is not this case.
  const legacyRef = `manual_${organizationId}_${Date.now()}_deadbeefdeadbeef`;
  const freeVersionId = await runAsPlatform('upgrade-path:free-version', () =>
    currentVersionIdForPlan(prisma, 'FREE'));
  await runAsPlatform('upgrade-path:legacy-ref', () => prisma.subscription.updateMany({
    where: { organizationId },
    data: { externalRef: legacyRef, status: 'TRIALING', planVersionId: freeVersionId },
  }));
  const beforeRefusal = await runAsPlatform('upgrade-path:read', () =>
    prisma.subscription.findFirst({
      where: { organizationId }, orderBy: { createdAt: 'desc' },
      select: { planVersionId: true, status: true },
    }));

  const event = Buffer.from(JSON.stringify({
    eventId: `evt_${STAMP}`,
    type: 'manual.subscription_activated',
    organizationId,
    planCode: SOLD,
  }), 'utf8');
  const secret = process.env.MANUAL_PAYMENT_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET;
  const signature = require('crypto').createHmac('sha256', secret).update(event).digest('hex');
  await billing.handlePaymentWebhook(event, { 'x-payment-signature': signature });

  const afterRefusal = await runAsPlatform('upgrade-path:read', () =>
    prisma.subscription.findFirst({
      where: { organizationId }, orderBy: { createdAt: 'desc' },
      select: { planVersionId: true, status: true },
    }));

  check('a payment whose purchased version cannot be read does not activate at the current one',
    afterRefusal && beforeRefusal && afterRefusal.planVersionId === beforeRefusal.planVersionId
      && afterRefusal.status !== 'ACTIVE',
    `subscription went to ${afterRefusal && afterRefusal.status} on version `
    + `${afterRefusal && afterRefusal.planVersionId} — a checkout that does not say which version was `
    + 'bought must be refused, not resolved to whatever is current today');

  routeIsScopedAndAuthenticated();
  manualDestinationExists();
  pricingOffersPurchaseToASession();

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
