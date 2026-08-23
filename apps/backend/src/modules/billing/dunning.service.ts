import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { runAsPlatform } from '../../lib/tenant-context';
import { queueGatewayAction } from '../../workers/gateway-provisioning.queue';

/**
 * What happens between "hasn't paid" and "switched off".
 *
 * Until now: nothing. The only route from an unpaid balance to a stopped
 * service was `markPaymentFailed()`, which suspends the organization in the
 * same transaction that notices the problem — no warning, no deadline, no
 * chance to pay. That is the right response to a provider shouting fraud and
 * the wrong response to an invoice four days late.
 *
 * The sequence a business actually runs is three steps, and this is all three:
 *
 * 1. **Overdue.** An invoice passes its due date unpaid. The subscriber keeps
 *    working and is given a deadline — `suspendAt` — which is a promise, not a
 *    threat: service continues until then.
 * 2. **Deadline passes, still unpaid.** Now the service stops, through the same
 *    suspension path an owner would use by hand.
 * 3. **Paid, at any point.** The deadline is cleared and a suspended subscriber
 *    is restored, because the only reason they were off is now untrue.
 *
 * ## What this does not do
 *
 * It does not tell the customer. There is no mail sender in this codebase, and
 * a dunning system whose notice step silently does nothing is worse than one
 * that admits it: the owner would believe warnings were going out. Each
 * transition raises a `PlatformAlert` so it appears in the console the owner
 * already reads, and the notice itself can be produced as a document to send by
 * hand. Wiring a real channel is a separate decision with its own credentials.
 */

/** How long a subscriber keeps working after an invoice goes overdue. */
const GRACE_DAYS_KEY = 'dunningGraceDays';
const GRACE_DAYS_DEFAULT = 7;

export async function getDunningGraceDays(): Promise<number> {
  const row = await prisma.platformSetting.findUnique({ where: { key: GRACE_DAYS_KEY } });
  const parsed = Number(row?.value);
  // A stored value that is not a sane number falls back rather than producing a
  // deadline in the past — which would suspend everyone on the next pass.
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 365) return GRACE_DAYS_DEFAULT;
  return Math.round(parsed);
}

export async function setDunningGraceDays(days: number, updatedBy: string | null): Promise<number> {
  if (!Number.isFinite(days) || days < 0 || days > 365) {
    throw new Error('Grace period must be between 0 and 365 days');
  }
  const value = String(Math.round(days));
  await prisma.platformSetting.upsert({
    where: { key: GRACE_DAYS_KEY },
    create: { key: GRACE_DAYS_KEY, value, updatedBy },
    update: { value, updatedBy },
  });
  return Math.round(days);
}

export type DunningResult = {
  /** Newly given a deadline. */
  warned: number;
  /** Deadline passed and unpaid — service stopped. */
  suspended: number;
  /** Paid up, so the deadline was withdrawn. */
  cleared: number;
};

/** Organizations with at least one invoice past its due date and not settled. */
async function organizationsWithOverdueInvoices(now: Date): Promise<Set<string>> {
  const overdue = await prisma.invoice.findMany({
    where: {
      status: { not: 'PAID' },
      dueAt: { not: null, lt: now },
    },
    select: { organizationId: true, amountDueCents: true, amountPaidCents: true },
  });

  return new Set(
    overdue
      // `status` alone is not proof: a part-paid invoice can sit at OPEN with
      // nothing left owing if somebody adjusted it. The balance is the truth.
      .filter((invoice) => invoice.amountDueCents - invoice.amountPaidCents > 0)
      .map((invoice) => invoice.organizationId),
  );
}

/**
 * One pass of the sequence. Safe to run repeatedly — every branch is guarded by
 * the state it is about to leave, so a second run inside the same minute does
 * nothing rather than double-suspending or re-warning.
 */
export async function runDunning(now: Date = new Date()): Promise<DunningResult> {
  return runAsPlatform('billing-dunning', async () => {
    const result: DunningResult = { warned: 0, suspended: 0, cleared: 0 };
    const graceDays = await getDunningGraceDays();
    const overdueOrgs = await organizationsWithOverdueInvoices(now);

    // ── 3. Paid up: withdraw the deadline, and restore if we had stopped them ──
    const inGrace = await prisma.organization.findMany({
      where: { suspendAt: { not: null } },
      select: { id: true, name: true, status: true, suspendAt: true },
    });

    for (const organization of inGrace) {
      if (overdueOrgs.has(organization.id)) continue;

      await prisma.organization.update({
        where: { id: organization.id },
        data: {
          suspendAt: null,
          suspendReason: null,
          // Only un-suspend what dunning suspended. An organization an owner
          // switched off by hand stays off — the balance being settled says
          // nothing about why they did that.
          ...(organization.status === 'SUSPENDED' && organization.suspendAt && organization.suspendAt <= now
            ? { status: 'ACTIVE' as const }
            : {}),
        },
      });

      if (organization.status === 'SUSPENDED' && organization.suspendAt && organization.suspendAt <= now) {
        await queueGatewayAction(organization.id, 'resume');
        await prisma.subscription.updateMany({
          where: { organizationId: organization.id, status: 'PAST_DUE' },
          data: { status: 'ACTIVE' },
        });
      }

      await prisma.platformAlert.create({
        data: {
          organizationId: organization.id,
          type: 'DUNNING_CLEARED',
          severity: 'INFO',
          message: `${organization.name} settled their balance`,
        },
      });
      result.cleared += 1;
    }

    // ── 1 & 2. Overdue: give a deadline, or act on one that has passed ────────
    for (const organizationId of overdueOrgs) {
      const organization = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true, name: true, status: true, suspendAt: true },
      });
      if (!organization) continue;

      // Already off. Nothing dunning can add to that.
      if (organization.status === 'SUSPENDED') continue;

      if (!organization.suspendAt) {
        const suspendAt = new Date(now.getTime() + graceDays * 24 * 3600_000);
        const reason = `Unpaid invoice past its due date. Service stops on ${suspendAt.toISOString().slice(0, 10)} unless the balance is cleared.`;

        await prisma.organization.update({
          where: { id: organization.id },
          data: { suspendAt, suspendReason: reason },
        });
        await prisma.platformAlert.create({
          data: {
            organizationId: organization.id,
            type: 'DUNNING_OVERDUE',
            severity: 'WARNING',
            message: `${organization.name}: ${reason}`,
            metadata: { suspendAt: suspendAt.toISOString(), graceDays },
          },
        });
        logger.warn('Subscriber entered dunning', { organizationId: organization.id, suspendAt });
        result.warned += 1;
        continue;
      }

      if (organization.suspendAt <= now) {
        await prisma.$transaction(async (tx) => {
          await tx.organization.update({
            where: { id: organization.id },
            data: { status: 'SUSPENDED' },
          });
          await tx.subscription.updateMany({
            where: { organizationId: organization.id, status: 'ACTIVE' },
            data: { status: 'PAST_DUE' },
          });
          await tx.platformAlert.create({
            data: {
              organizationId: organization.id,
              type: 'DUNNING_SUSPENDED',
              severity: 'ERROR',
              message: `${organization.name} suspended: balance unpaid past the deadline`,
            },
          });
        });
        await queueGatewayAction(organization.id, 'suspend');
        logger.warn('Subscriber suspended by dunning', { organizationId: organization.id });
        result.suspended += 1;
      }
    }

    return result;
  });
}
