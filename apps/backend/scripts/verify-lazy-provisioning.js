/**
 * A container is built when the customer asks for one, and at no other moment.
 *
 * ## Why this gate exists
 *
 * Provisioning used to fire from three places nobody was watching: the end of
 * signup, the email-verification endpoint, and payment activation. Each built a
 * real OpenWA container — RAM, two volumes, a port — for a subscriber who had
 * not asked for one and might never pair a number to it. Signing up to look
 * around cost the platform a container.
 *
 * Lazy provisioning moves the trigger to the customer's first Connect click.
 * That is a one-line change in three files, and a one-line change back: nothing
 * about the code makes the old triggers hard to reintroduce, and the symptom of
 * reintroducing one is a hosting bill rather than a failing screen. So the
 * absence is asserted, not assumed.
 *
 * ## What "no container" is measured as
 *
 * The BullMQ job, by its exact id. `queueGatewayAction` keys jobs
 * `<organizationId>--gateway--<action>`, so the presence of that job is
 * precisely "a build was requested for this organization" — closer to the truth
 * than `Organization.status`, which the same function also writes and which a
 * future caller could set for its own reasons.
 *
 * ## And the refusals carry reasons
 *
 * `maybeProvisionGateway` returned a bare boolean while every caller was a
 * background step. Now a customer clicks and waits, so `false` had to stop
 * meaning four different things at once. The outcomes are asserted here because
 * the connect endpoint renders them: a button that reports success when nothing
 * happened is the fabricated-success shape this codebase has fixed three times.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

const { prisma } = require('../dist/prisma');
const { runAsPlatform } = require('../dist/lib/tenant-context');
const {
  createSignup,
  verifyEmail,
  maybeProvisionGateway,
  activateManualSubscription,
} = require('../dist/modules/billing/billing.service');
const { loadEditionCatalogueOrThrow } = require('../dist/modules/billing/editions.service');
const { gatewayProvisioningQueue } = require('../dist/workers/gateway-provisioning.queue');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const stamp = Date.now();
const created = [];

/** Has a build been requested for this organization? */
async function buildRequested(organizationId) {
  const job = await gatewayProvisioningQueue.getJob(`${organizationId}--gateway--provision`);
  return job !== undefined && job !== null;
}

async function signup(planCode, tag) {
  const result = await createSignup({
    organizationName: `Lazy ${tag} ${stamp}`,
    adminName: 'Lazy Gate',
    adminEmail: `lazy-${tag}-${stamp}@example.com`,
    adminPassword: 'Str0ng-Lazy-Passw0rd!',
    planCode,
    // A unique address per run, so the in-service signup throttle counts this
    // gate's own signups separately from anybody else's.
    ipAddress: `203.0.113.${(stamp % 250) + 1}`,
  });
  created.push(result.organizationId);
  return result;
}

async function cleanup() {
  await runAsPlatform('verify-lazy-provisioning:cleanup', async () => {
    for (const organizationId of created) {
      const job = await gatewayProvisioningQueue.getJob(`${organizationId}--gateway--provision`);
      if (job) await job.remove();
      // Sessions before channels: the binding foreign key is RESTRICT.
      await prisma.whatsappSession.deleteMany({ where: { organizationId } });
      await prisma.organizationChannel.deleteMany({ where: { organizationId } });
      const users = await prisma.user.findMany({ where: { organizationId }, select: { identityId: true } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      if (users.length) {
        await prisma.identity.deleteMany({
          where: { id: { in: users.map((u) => u.identityId) }, users: { none: {} }, platformRole: 'NONE' },
        });
      }
    }
  });
}

async function main() {
  await loadEditionCatalogueOrThrow();

  try {
    /* ── 1. signup builds nothing ──────────────────────────────────────── */
    const paid = await signup('STANDARD', 'paid');
    check('signup on a paid plan requests no gateway',
      (await buildRequested(paid.organizationId)) === false,
      'a build was queued at signup — a container for somebody who has not asked for one');

    const org = await runAsPlatform('verify-lazy-provisioning:read', () =>
      prisma.organization.findUnique({ where: { id: paid.organizationId }, select: { status: true } }));
    check('  …and the organization is not left claiming to be PROVISIONING',
      org.status !== 'PROVISIONING', org.status);

    /* ── 2. verifying an address builds nothing ────────────────────────── */
    const token = decodeURIComponent(new URL(paid.verificationUrl).searchParams.get('token'));
    await verifyEmail(token);
    check('confirming the email address requests no gateway',
      (await buildRequested(paid.organizationId)) === false,
      'D-8 removed verification as a gate on provisioning; it must not be a trigger either');

    /* ── 3. paying builds nothing ──────────────────────────────────────── */
    await activateManualSubscription(paid.organizationId, 'STANDARD', { source: 'lazy-provisioning-gate' });
    check('activating the subscription requests no gateway',
      (await buildRequested(paid.organizationId)) === false,
      'money arriving is not the same as a customer wanting a container');

    /* ── 4. the connect request is what builds it ──────────────────────── */
    const connect = await maybeProvisionGateway(paid.organizationId, 'connect-requested');
    check('a connect request on a paid plan queues the build',
      connect.queued === true, JSON.stringify(connect));
    check('  …and the job is really on the queue',
      (await buildRequested(paid.organizationId)) === true);

    /* ── 5. clicking twice is answered, not duplicated ─────────────────── */
    const again = await maybeProvisionGateway(paid.organizationId, 'connect-requested');
    check('a second connect request reports the state instead of a second build',
      again.queued === false && again.code === 'ALREADY_IN_FLIGHT',
      JSON.stringify(again));

    /* ── 6. FREE is refused with a reason and an upgrade ───────────────── */
    /*
      Signing up "on FREE" does not produce an organization on FREE.

      createSignup puts a free signup on a *trial*, and a trial runs on the paid
      entry edition with trialEndsAt set — that is the product's design, and
      this check asserted the wrong thing until it ran. So the fixture makes an
      organization that is genuinely on FREE: the trial subscription is
      cancelled and the tier says FREE, which is what resolveEntitlements falls
      through to and what a subscriber looks like after a trial lapses.
    */
    const free = await signup('FREE', 'free');
    await runAsPlatform('verify-lazy-provisioning:lapse-trial', async () => {
      await prisma.subscription.updateMany({
        where: { organizationId: free.organizationId },
        data: { status: 'CANCELED' },
      });
      await prisma.organization.update({
        where: { id: free.organizationId },
        data: { tier: 'FREE' },
      });
    });
    const refused = await maybeProvisionGateway(free.organizationId, 'connect-requested');
    check('a connect request on FREE is refused, and says so',
      refused.queued === false && refused.code === 'PLAN_UPGRADE_REQUIRED',
      JSON.stringify(refused));
    check('  …naming an edition that would grant it',
      refused.queued === false && typeof refused.requiredPlan === 'string' && refused.requiredPlan.length > 0,
      refused.queued === false ? String(refused.requiredPlan) : 'queued');
    check('  …and queues nothing',
      (await buildRequested(free.organizationId)) === false);

    /* ── 7. one trigger, structurally ──────────────────────────────────── */
    const root = path.join(__dirname, '..', 'src');
    const callers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.ts$/.test(entry.name)) continue;
        const text = fs.readFileSync(full, 'utf8');
        // Calls, not the definition, not the type, not prose about it.
        if (/\bmaybeProvisionGateway\(/.test(text.replace(/export async function maybeProvisionGateway\(/g, ''))) {
          callers.push(path.relative(root, full).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);
    const outsideBilling = callers.filter((file) => file !== 'modules/billing/billing.service.ts');
    check('the connect endpoint is the only caller outside billing.service',
      outsideBilling.length === 1 && outsideBilling[0] === 'modules/channels/channels.routes.ts',
      outsideBilling.join(', ') || 'none');
  } finally {
    await cleanup();
    await gatewayProvisioningQueue.close();
    await prisma.$disconnect();
  }

  console.log('');
  console.log(`${passed}/${passed + failed} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
