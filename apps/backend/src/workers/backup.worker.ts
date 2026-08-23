import { Queue, Worker } from 'bullmq';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import logger from '../lib/logger';
import { prisma } from '../prisma';
import { runAsPlatform } from '../lib/tenant-context';
import { runBackup } from '../modules/ops/backup.service';
import { queueMail } from '../modules/mail/mail.service';

/**
 * The nightly backup.
 *
 * ## Why this does not ride the reconciliation pass
 *
 * Dunning shares the half-hourly billing job deliberately — they are the same
 * work in different words. This is not. A backup takes minutes, holds a
 * connection, and writes hundreds of megabytes; putting it on a job that must
 * stay responsive means one slow night delays every payment reconciliation
 * behind it.
 *
 * ## A failure has to be noticed
 *
 * The whole point of a scheduled backup is that nobody thinks about it, which
 * is also how a silently failing one goes unnoticed for months. So a failure
 * raises a platform alert *and* queues mail to the owner. A backup that fails
 * quietly is worse than no backup, because it is a backup you are counting on.
 */

const QUEUE = 'database-backup';

/**
 * The shared connection, not a second one.
 *
 * A private client here would be a second Redis handle to configure, to
 * notice had died, and to close on shutdown — and it would hold the process
 * open the way the campaign queue once did.
 */
const backupQueue = new Queue(QUEUE, { connection: gatewayQueueConnection });
/** 03:20 UTC: after the nightly usage rollup, well clear of business hours. */
const NIGHTLY = '20 3 * * *';

async function announceFailure(error: unknown) {
  const message = String(error).slice(0, 500);
  await runAsPlatform('backup-failure', async () => {
    await prisma.platformAlert.create({
      data: {
        // Platform-wide, not a subscriber's problem: this is our promise to all
        // of them at once.
        organizationId: null,
        type: 'BACKUP_FAILED',
        severity: 'ERROR',
        message: `Nightly database backup failed: ${message}`,
      },
    }).catch((alertError) =>
      logger.error('could not record backup failure alert', { error: String(alertError) }),
    );

    const owners = await prisma.identity.findMany({
      where: { platformRole: 'OWNER', platformDisabledAt: null },
      select: { email: true },
    });
    for (const owner of owners) {
      await queueMail({
        to: owner.email,
        kind: 'ops.backup-failed',
        // One per day at most: a failure that repeats every night should not
        // produce a mailbox nobody reads by the third morning.
        dedupeKey: `ops.backup-failed:${new Date().toISOString().slice(0, 10)}`,
        subject: 'RabiTech: last night’s database backup FAILED',
        body: [
          'The scheduled database backup did not complete.',
          '',
          `Reason: ${message}`,
          '',
          'Until this is fixed there is no verified recent copy of the database.',
          'Run `npm run backup:now` in the backend to retry and see the full error.',
        ].join('\n'),
      });
    }
  });
}

export function startBackupWorker(): Worker {
  const worker = new Worker(
    QUEUE,
    async () => {
      const result = await runBackup();
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    logger.error('Nightly backup FAILED', { jobId: job?.id, error: String(error) });
    announceFailure(error).catch((announceError) =>
      logger.error('could not announce backup failure', { error: String(announceError) }),
    );
  });

  worker.on('completed', (_job, result) => {
    logger.info('Nightly backup completed', result as object);
  });

  backupQueue
    .upsertJobScheduler(`platform:${QUEUE}-nightly`, { pattern: NIGHTLY }, { name: 'nightly', data: {} })
    .catch((error: unknown) =>
      logger.error('Failed to schedule nightly backup', { error: String(error) }),
    );

  logger.info('Backup worker started', { schedule: NIGHTLY });
  return worker;
}
