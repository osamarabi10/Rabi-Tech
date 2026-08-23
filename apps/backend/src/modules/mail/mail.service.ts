import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { runAsPlatform } from '../../lib/tenant-context';
import { getMailProvider } from './mail.provider';

/**
 * The outbox: queue a message, and let a worker deliver it.
 *
 * ## Why nothing sends inline
 *
 * Every message this product sends is caused by something else succeeding. A
 * payment failed and the subscriber must be told. A trial ended. A password was
 * reset. Calling a mail API from inside those transactions makes the mail
 * provider's availability a condition of them committing — a provider timeout
 * would roll back the payment state that caused the message.
 *
 * So the transaction records what is owed, and delivery is somebody else's
 * problem. A send that fails is retried; a send that keeps failing is visible
 * in a table rather than lost in a log line.
 *
 * ## Deduplication is a database constraint, not a check
 *
 * `dedupeKey` is unique. The alternative — reading first to see whether this
 * message was already queued — lets two dunning passes running a second apart
 * both decide it was not, and warn the same customer twice about the same
 * invoice. The insert simply fails the second time, which is the correct
 * outcome and needs no coordination.
 */

const MAX_ATTEMPTS = 5;
/** Minutes before each retry: ~1m, 5m, 25m, 2h. Bounded by MAX_ATTEMPTS. */
const BACKOFF_MINUTES = [1, 5, 25, 125];

export type QueuedMail = {
  to: string;
  subject: string;
  body: string;
  /** Message type, for the outbox view and for grouping. */
  kind: string;
  organizationId?: string | null;
  /** "This exact message, once." Omit for messages that may legitimately repeat. */
  dedupeKey?: string | null;
  /** Hold delivery until this moment. */
  sendAfter?: Date;
};

/**
 * Record a message as owed.
 *
 * Returns whether it was queued. `false` means an identical message was already
 * waiting — which is a success, not a failure, and callers should treat it as
 * one.
 */
export async function queueMail(mail: QueuedMail): Promise<boolean> {
  try {
    await runAsPlatform(`mail-queue:${mail.kind}`, () =>
      prisma.emailOutbox.create({
        data: {
          organizationId: mail.organizationId ?? null,
          toEmail: mail.to,
          kind: mail.kind,
          subject: mail.subject,
          body: mail.body,
          dedupeKey: mail.dedupeKey ?? null,
          sendAfter: mail.sendAfter ?? new Date(),
        },
      }),
    );
    return true;
  } catch (error) {
    // A unique violation on dedupeKey is the constraint doing its job.
    if (String(error).includes('Unique constraint') || (error as any)?.code === 'P2002') {
      return false;
    }
    // Queuing must never fail the thing that caused it. A subscriber whose
    // payment was recorded and whose warning email was lost is recoverable; one
    // whose payment rolled back because of a mail table is not.
    logger.error('failed to queue mail', { kind: mail.kind, to: mail.to, error: String(error) });
    return false;
  }
}

export type FlushResult = { sent: number; failed: number; retried: number };

/**
 * Deliver what is due.
 *
 * Claims each row before sending, so two workers cannot send the same message.
 * The claim is an `updateMany` filtered on the status it expects to find — the
 * row it did not update is the row somebody else took.
 */
export async function flushOutbox(limit = 50, now: Date = new Date()): Promise<FlushResult> {
  const result: FlushResult = { sent: 0, failed: 0, retried: 0 };
  const mailProvider = getMailProvider();

  return runAsPlatform('mail-flush', async () => {
    const due = await prisma.emailOutbox.findMany({
      where: { status: 'PENDING', sendAfter: { lte: now } },
      orderBy: { sendAfter: 'asc' },
      take: limit,
    });

    for (const row of due) {
      // Claim it. If another worker got there first this updates nothing and we
      // move on rather than sending a second copy.
      const claimed = await prisma.emailOutbox.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: { status: 'SENDING', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;

      try {
        await mailProvider.send({ to: row.toEmail, subject: row.subject, body: row.body });
        await prisma.emailOutbox.update({
          where: { id: row.id },
          data: { status: 'SENT', sentAt: new Date(), lastError: null },
        });
        result.sent += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        const waitMinutes = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)];
        await prisma.emailOutbox.update({
          where: { id: row.id },
          data: {
            // Back to PENDING so the next pass picks it up. FAILED is terminal
            // and means a person has to look — it is not a synonym for "not yet".
            status: exhausted ? 'FAILED' : 'PENDING',
            lastError: String(error).slice(0, 500),
            sendAfter: exhausted ? row.sendAfter : new Date(now.getTime() + waitMinutes * 60_000),
          },
        });
        if (exhausted) {
          result.failed += 1;
          logger.error('mail permanently failed', {
            id: row.id,
            kind: row.kind,
            to: row.toEmail,
            attempts,
            error: String(error),
          });
        } else {
          result.retried += 1;
        }
      }
    }

    return result;
  });
}
