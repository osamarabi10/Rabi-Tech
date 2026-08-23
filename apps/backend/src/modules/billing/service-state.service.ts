import { prisma } from '../../prisma';
import { runAsPlatform } from '../../lib/tenant-context';

/**
 * Whether this workspace is in trouble, and how much warning it has had.
 *
 * ## Why this is not the access gate
 *
 * The gate answers "may this request proceed" and returns 403 when the answer
 * is no. This answers "is something about to go wrong" — a question the gate
 * cannot express, because the interesting case is the one where everything
 * still works and stops working on Thursday.
 *
 * A subscriber inside their dunning grace period has full access and a deadline.
 * Saying nothing until the morning access disappears is how a customer finds out
 * they were warned by email they never opened.
 */

export type ServiceState =
  /** Nothing to say. */
  | { kind: 'ok' }
  /**
   * Working, with a deadline. The one state that exists purely to be shown —
   * every other kind is already obvious from the product being unusable.
   */
  | { kind: 'overdue'; suspendAt: string; reason: string | null }
  | { kind: 'suspended'; reason: string | null }
  | { kind: 'trial_expired' };

export async function getServiceState(organizationId: string): Promise<ServiceState> {
  const organization = await runAsPlatform(`service-state:${organizationId}`, () =>
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        status: true,
        suspendAt: true,
        suspendReason: true,
        subscriptions: {
          where: { status: { in: ['TRIALING'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { trialEndsAt: true },
        },
      },
    }),
  );

  if (!organization) return { kind: 'ok' };

  // Order matters: a suspended workspace is suspended whatever else is true of
  // it, and saying "your trial ends in an hour" to somebody already locked out
  // is worse than saying nothing.
  if (organization.status === 'SUSPENDED') {
    return { kind: 'suspended', reason: organization.suspendReason };
  }

  const trialEndsAt = organization.subscriptions[0]?.trialEndsAt;
  if (trialEndsAt && trialEndsAt.getTime() <= Date.now()) {
    return { kind: 'trial_expired' };
  }

  // A deadline in the future is the warning. One in the past means the dunning
  // pass has not run yet — the subscriber is living on borrowed time rather than
  // on a promise, and telling them about a date that has passed reads as a bug.
  if (organization.suspendAt && organization.suspendAt.getTime() > Date.now()) {
    return {
      kind: 'overdue',
      suspendAt: organization.suspendAt.toISOString(),
      reason: organization.suspendReason,
    };
  }

  return { kind: 'ok' };
}
