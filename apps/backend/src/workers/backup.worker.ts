import { Queue, Worker } from 'bullmq';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import logger from '../lib/logger';
import { prisma } from '../prisma';
import { runAsPlatform } from '../lib/tenant-context';
import { runBackup } from '../modules/ops/backup.service';
import { runBackupDrill, DrillNotConfiguredError } from '../modules/ops/backup-drill';
import { backupEncryptionConfigured } from '../modules/ops/backup-crypto';
import { getBackupDestination } from '../modules/ops/backup-destination';
import { queueMail } from '../modules/mail/mail.service';

/**
 * The nightly backup, and the weekly drill on its off-host copy.
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
 *
 * ## Three failures, three alerts, deliberately not one
 *
 * `BACKUP_FAILED` — no verified dump exists at all. Everything else is
 * secondary to this one.
 *
 * `BACKUP_REPLICATION_FAILED` — the dump is good and did not leave the host.
 * Survivable for a night; the local copy is verified and current.
 *
 * `BACKUP_DRILL_FAILED` — the off-host copy exists and cannot be restored from,
 * or has stopped being refreshed. This is the one that means the disaster plan
 * does not work, and it must not arrive wearing the same label as a missed
 * upload, because the two need different responses on different timescales.
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
const NIGHTLY = process.env.BACKUP_CRON || '20 3 * * *';
/**
 * Sunday 03:50 UTC, half an hour behind the nightly so it drills a copy that
 * was written minutes earlier rather than racing the job that writes it.
 *
 * Weekly rather than nightly because the nightly already restores the local
 * dump: what the drill adds is proof of the encrypt-upload-download-decrypt
 * round trip, and that breaks on config changes, which do not happen daily.
 * At this database's size a nightly drill would also be cheap — hence the env
 * var rather than a constant.
 */
const DRILL_CRON = process.env.BACKUP_DRILL_CRON || '50 3 * * 0';

const JOB_BACKUP = 'nightly';
const JOB_DRILL = 'drill';

/**
 * Record a platform alert and mail the owners.
 *
 * Deliberately swallows its own failures: this runs on the error path, and an
 * alerting system that throws while reporting a backup failure turns one
 * problem into a stack trace about a second one.
 */
async function announce(input: {
  type: string;
  severity: 'ERROR' | 'WARN';
  message: string;
  subject: string;
  body: string[];
}) {
  await runAsPlatform(`backup-alert:${input.type}`, async () => {
    await prisma.platformAlert.create({
      data: {
        // Platform-wide, not a subscriber's problem: this is our promise to all
        // of them at once.
        organizationId: null,
        type: input.type,
        severity: input.severity,
        message: input.message,
      },
    }).catch((alertError) =>
      logger.error('could not record backup alert', { type: input.type, error: String(alertError) }),
    );

    const owners = await prisma.identity.findMany({
      where: { platformRole: 'OWNER', platformDisabledAt: null },
      select: { email: true },
    });
    for (const owner of owners) {
      await queueMail({
        to: owner.email,
        kind: `ops.${input.type.toLowerCase().replace(/_/g, '-')}`,
        // One per day at most: a failure that repeats every night should not
        // produce a mailbox nobody reads by the third morning.
        dedupeKey: `ops.${input.type}:${new Date().toISOString().slice(0, 10)}`,
        subject: input.subject,
        body: input.body.join('\n'),
      });
    }
  });
}

async function announceBackupFailure(error: unknown) {
  const message = String(error).slice(0, 500);
  await announce({
    type: 'BACKUP_FAILED',
    severity: 'ERROR',
    message: `Nightly database backup failed: ${message}`,
    subject: 'RabiTech: last night’s database backup FAILED',
    body: [
      'The scheduled database backup did not complete.',
      '',
      `Reason: ${message}`,
      '',
      'Until this is fixed there is no verified recent copy of the database.',
      'Run `npm run backup:now` in the backend to retry and see the full error.',
    ],
  });
}

async function announceReplicationFailure(reason: string) {
  await announce({
    type: 'BACKUP_REPLICATION_FAILED',
    severity: 'ERROR',
    message: `Backup was verified but not replicated off-host: ${reason}`,
    subject: 'RabiTech: the database backup did not leave this host',
    body: [
      'Last night’s backup completed and was verified by restoring it.',
      'It was not copied off this host.',
      '',
      `Reason: ${reason}`,
      '',
      'The local dump is good and current, so this is not urgent tonight.',
      'It becomes urgent the moment this host’s disk fails, because the only',
      'verified copy is on that disk.',
    ],
  });
}

async function announceDrillFailure(error: unknown) {
  const message = String(error).slice(0, 500);
  await announce({
    type: 'BACKUP_DRILL_FAILED',
    severity: 'ERROR',
    message: `Off-host restore drill failed: ${message}`,
    subject: 'RabiTech: the off-host backup could not be restored',
    body: [
      'The weekly drill downloads the newest off-host backup, decrypts it, and',
      'restores it into a scratch database. It did not succeed.',
      '',
      `Reason: ${message}`,
      '',
      'This means the disaster-recovery copy cannot currently be recovered from,',
      'or has stopped being refreshed. A local dump may still exist and be fine —',
      'check for a BACKUP_FAILED alert separately.',
    ],
  });
}

/** Says once, at boot, what the replication posture actually is. */
function announceReplicationPosture() {
  const destination = getBackupDestination();
  if (!destination) {
    logger.warn(
      'Backup replication is OFF — no BACKUP_REPLICA_DIR. Verified dumps stay on this host only.',
    );
    return;
  }
  if (!backupEncryptionConfigured()) {
    // Loud, and not a silent downgrade to plaintext: a destination is
    // configured, so somebody expects copies to be leaving, and they are not.
    logger.error(
      'Backup replication is OFF despite a configured destination: BACKUP_ENCRYPTION_KEY is ' +
      'unset or shorter than 32 characters. Nothing is uploaded — dumps are never sent in plaintext.',
      { destination: destination.name },
    );
    return;
  }
  logger.info('Backup replication is on', {
    destination: destination.name,
    offHost: destination.offHost,
    drill: DRILL_CRON,
  });
  if (!destination.offHost) {
    logger.warn(
      'Backup destination is not marked off-host (BACKUP_REPLICA_OFFHOST is not 1). ' +
      'It survives a container replacement, not the loss of this disk.',
      { destination: destination.name },
    );
  }
}

export function startBackupWorker(): Worker {
  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === JOB_DRILL) {
        try {
          return await runBackupDrill();
        } catch (error) {
          // Not configured is not a failure — it is a system that was never
          // asked to replicate. Reporting it weekly would train the owner to
          // ignore this alert before it ever fires for a real reason.
          if (error instanceof DrillNotConfiguredError) {
            logger.info('Backup drill skipped', { reason: error.message });
            return { skipped: error.message };
          }
          throw error;
        }
      }

      const result = await runBackup();
      // Reported here rather than from the `completed` handler so it cannot be
      // lost to event ordering, and so it stays attached to the run that
      // produced it.
      if (result.replicaError) {
        await announceReplicationFailure(result.replicaError).catch((announceError) =>
          logger.error('could not announce replication failure', { error: String(announceError) }),
        );
      }
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    const drill = job?.name === JOB_DRILL;
    logger.error(drill ? 'Backup restore drill FAILED' : 'Nightly backup FAILED', {
      jobId: job?.id,
      error: String(error),
    });
    const announced = drill ? announceDrillFailure(error) : announceBackupFailure(error);
    announced.catch((announceError) =>
      logger.error('could not announce backup failure', { error: String(announceError) }),
    );
  });

  worker.on('completed', (job, result) => {
    logger.info(job?.name === JOB_DRILL ? 'Backup drill completed' : 'Nightly backup completed',
      result as object);
  });

  backupQueue
    .upsertJobScheduler(`platform:${QUEUE}-nightly`, { pattern: NIGHTLY }, { name: JOB_BACKUP, data: {} })
    .catch((error: unknown) =>
      logger.error('Failed to schedule nightly backup', { error: String(error) }),
    );
  backupQueue
    .upsertJobScheduler(`platform:${QUEUE}-drill`, { pattern: DRILL_CRON }, { name: JOB_DRILL, data: {} })
    .catch((error: unknown) =>
      logger.error('Failed to schedule backup restore drill', { error: String(error) }),
    );

  logger.info('Backup worker started', { schedule: NIGHTLY, drill: DRILL_CRON });
  announceReplicationPosture();
  return worker;
}
