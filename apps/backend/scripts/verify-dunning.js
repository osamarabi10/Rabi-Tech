/**
 * The dunning sequence: overdue → deadline → cut-off → restored on payment.
 *
 * This one switches real subscribers off, so it is the last place to be
 * trusting. Every branch is exercised against the live database on a
 * throwaway organization, and the organization is deleted afterwards including
 * on failure.
 */
const { runAsPlatform } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const { runDunning, setDunningGraceDays, getDunningGraceDays } = require('../dist/modules/billing/dunning.service');

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

const stamp = Date.now();
const ORG_ID = 'dunning-probe-' + stamp;

async function state() {
  return prisma.organization.findUnique({
    where: { id: ORG_ID },
    select: { status: true, suspendAt: true, suspendReason: true },
  });
}

async function main() {
  await runAsPlatform('verify-dunning', async () => {
    const originalGrace = await getDunningGraceDays();

    try {
      await prisma.organization.create({
        data: { id: ORG_ID, name: 'Dunning Probe', slug: 'dunning-probe-' + stamp, status: 'ACTIVE', tier: 'GROWTH' },
      });

      // ── an invoice that is not yet due changes nothing ────────────────────
      const notYetDue = await prisma.invoice.create({
        data: {
          organizationId: ORG_ID,
          provider: 'manual',
          invoiceRef: 'INV-PROBE-A-' + stamp,
          status: 'OPEN',
          amountDueCents: 4900,
          dueAt: new Date(Date.now() + 7 * 24 * 3600_000),
        },
      });
      await runDunning();
      check('an invoice not yet due starts no countdown', (await state())?.suspendAt === null);

      // ── overdue: a deadline, and the service still running ────────────────
      await setDunningGraceDays(7, null);
      await prisma.invoice.update({
        where: { id: notYetDue.id },
        data: { dueAt: new Date(Date.now() - 24 * 3600_000) },
      });

      const warned = await runDunning();
      const afterWarn = await state();
      check('an overdue invoice sets a deadline', afterWarn?.suspendAt !== null);
      check('and the subscriber keeps working until then', afterWarn?.status === 'ACTIVE',
        String(afterWarn?.status));
      check('the deadline is the grace period away',
        afterWarn?.suspendAt !== null &&
          Math.abs(afterWarn.suspendAt.getTime() - (Date.now() + 7 * 24 * 3600_000)) < 60_000);
      check('the pass reports what it did', warned.warned === 1, JSON.stringify(warned));

      // ── running again does not re-warn or move the deadline ───────────────
      const deadline = afterWarn.suspendAt.getTime();
      const second = await runDunning();
      check('a second pass is a no-op', second.warned === 0 && second.suspended === 0,
        JSON.stringify(second));
      check('and does not move the deadline', (await state())?.suspendAt?.getTime() === deadline);

      // ── deadline passes, still unpaid: service stops ──────────────────────
      await prisma.organization.update({
        where: { id: ORG_ID },
        data: { suspendAt: new Date(Date.now() - 1000) },
      });
      const cut = await runDunning();
      const afterCut = await state();
      check('the deadline passing suspends the subscriber', afterCut?.status === 'SUSPENDED',
        String(afterCut?.status));
      check('the pass reports the suspension', cut.suspended === 1, JSON.stringify(cut));

      // ── paying restores them ──────────────────────────────────────────────
      await prisma.invoice.update({
        where: { id: notYetDue.id },
        data: { status: 'PAID', amountPaidCents: 4900, paidAt: new Date() },
      });
      const restored = await runDunning();
      const afterPay = await state();
      check('settling the balance restores the service', afterPay?.status === 'ACTIVE',
        String(afterPay?.status));
      check('and withdraws the deadline', afterPay?.suspendAt === null);
      check('the pass reports the clearance', restored.cleared === 1, JSON.stringify(restored));

      // ── a manual suspension is not undone by paying ───────────────────────
      await prisma.organization.update({
        where: { id: ORG_ID },
        data: { status: 'SUSPENDED', suspendAt: null, suspendReason: null },
      });
      await runDunning();
      check("an owner's manual suspension survives a paid balance",
        (await state())?.status === 'SUSPENDED');

      // ── a part payment that leaves a balance is still overdue ─────────────
      await prisma.organization.update({ where: { id: ORG_ID }, data: { status: 'ACTIVE' } });
      await prisma.invoice.update({
        where: { id: notYetDue.id },
        data: { status: 'OPEN', amountPaidCents: 2000, paidAt: null },
      });
      await runDunning();
      check('a part payment leaving a balance still counts as overdue',
        (await state())?.suspendAt !== null);
    } finally {
      await prisma.invoice.deleteMany({ where: { organizationId: ORG_ID } }).catch(() => {});
      await prisma.platformAlert.deleteMany({ where: { organizationId: ORG_ID } }).catch(() => {});
      await prisma.organization.delete({ where: { id: ORG_ID } }).catch(() => {});
      await setDunningGraceDays(originalGrace, null).catch(() => {});
    }
  });

  await prisma.$disconnect();

  /*
   * The gateway queue holds a Redis connection open.
   *
   * runDunning() enqueues suspend/resume jobs, and BullMQ keeps the socket
   * alive afterwards, so the script prints its result and then hangs for ever.
   * The tenancy harness learned this the same way.
   */
  const { gatewayProvisioningQueue } = require('../dist/workers/gateway-provisioning.queue');
  await gatewayProvisioningQueue.close().catch(() => {});

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
