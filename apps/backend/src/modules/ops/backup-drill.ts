import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import logger from '../../lib/logger';
import { backupEncryptionConfigured, decryptFile } from './backup-crypto';
import { getBackupDestination } from './backup-destination';
import { restoreAndCount, type RestoredCounts } from './backup.service';

/**
 * The restore drill: pull the off-host copy back and restore *that*.
 *
 * ## What this proves that the nightly verify does not
 *
 * `runBackup` restores the local dump, which proves `pg_dump` produced
 * something usable. It says nothing about the copy that would actually be
 * reached for after a disk failure, because that copy went through two more
 * steps — encryption and transfer — and each can fail in ways that leave a
 * file of plausible size behind.
 *
 * The drill closes that gap by doing the whole recovery: download, decrypt,
 * restore, count. It is the same reasoning this repository already applies to
 * `down.sql` — a path that has never been executed is an assertion about the
 * past, not a tested path.
 *
 * ## Why staleness is a failure and not a note
 *
 * The failure mode worth designing against is not a corrupt copy; GCM catches
 * that on the first byte. It is replication stopping quietly — a rotated key, a
 * full disk, a destination that started refusing writes — while the drill keeps
 * restoring the last good file and keeps reporting green. That is precisely the
 * D-5 / D-10 / D-16 family in `KNOWN-DEFECTS.md`: a check that reports on its
 * environment rather than on the thing it names.
 *
 * So the drill fails on an off-host copy older than `BACKUP_REPLICA_MAX_AGE_HOURS`
 * even when that copy restores perfectly. A backup you cannot lose data past is
 * the claim; a three-week-old copy does not support it however cleanly it
 * restores.
 */

/**
 * Nightly plus a full day of slack, so one skipped night is not an alert.
 *
 * Read at call time rather than at import. A module-level constant would bind
 * whatever the environment held when the process started, which makes the
 * threshold untestable without a restart and silently ignores an operator who
 * changes it — the same shape as the ambient-`DATABASE_URL` problem in D-12.
 */
export function maxReplicaAgeHours(): number {
  return Number(process.env.BACKUP_REPLICA_MAX_AGE_HOURS || 48);
}

/**
 * How old the newest off-host copy is, and whether that is too old.
 *
 * Pure, and exported, so the gate can prove the threshold without a database:
 * the drill's other half needs Postgres, and a check that needs the stack up
 * fails for environmental reasons rather than for code reasons.
 */
export function replicaAge(at: string, now: Date): { ageHours: number; stale: boolean } {
  const ageHours = (now.getTime() - new Date(at).getTime()) / 3_600_000;
  return { ageHours, stale: ageHours > maxReplicaAgeHours() };
}

export type DrillResult = {
  destination: string;
  offHost: boolean;
  key: string;
  encryptedBytes: number;
  restoredBytes: number;
  verified: RestoredCounts;
  ageHours: number;
  durationMs: number;
};

export class DrillNotConfiguredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DrillNotConfiguredError';
  }
}

/**
 * Run the drill, or explain why it could not run.
 *
 * Throws `DrillNotConfiguredError` when replication is switched off — the
 * caller treats that as "nothing to do", not as a fault, because a system with
 * no destination configured is not failing at replication, it is not doing it.
 * Every other throw is a real failure: the off-host copy cannot be recovered
 * from, which is the one thing this whole feature exists to know.
 */
export async function runBackupDrill(now: Date = new Date()): Promise<DrillResult> {
  const started = Date.now();
  const destination = getBackupDestination();
  if (!destination) {
    throw new DrillNotConfiguredError('no BACKUP_REPLICA_DIR configured — replication is off');
  }
  if (!backupEncryptionConfigured()) {
    throw new DrillNotConfiguredError('BACKUP_ENCRYPTION_KEY is not set — replication is off');
  }

  const copies = await destination.list();
  const newest = copies[0];
  if (!newest) {
    // Configured but empty is a failure, not an absence. Somebody asked for
    // off-host copies and there are none.
    throw new Error(`destination ${destination.name} holds no backup copies`);
  }

  const { ageHours, stale } = replicaAge(newest.at, now);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rabitech-drill-'));
  const encrypted = path.join(scratch, newest.key);
  const decrypted = path.join(scratch, newest.key.replace(/\.enc$/, ''));

  try {
    await destination.get(newest.key, encrypted);
    const { bytes: restoredBytes } = await decryptFile(encrypted, decrypted);
    const verified = await restoreAndCount(decrypted);

    /*
     * Age is checked last, deliberately.
     *
     * Checking it first would skip the restore on a stale copy and report only
     * "too old" — leaving whoever reads the alert unable to tell a late backup
     * from a late *and unusable* one. Restoring first means the alert can say
     * both, and the more urgent half is never hidden behind the less urgent.
     */
    if (stale) {
      throw new Error(
        `newest off-host copy ${newest.key} is ${ageHours.toFixed(1)}h old ` +
        `(limit ${maxReplicaAgeHours()}h) — it restored cleanly, so replication has stopped rather than broken`,
      );
    }

    const result: DrillResult = {
      destination: destination.name,
      offHost: destination.offHost,
      key: newest.key,
      encryptedBytes: newest.bytes,
      restoredBytes,
      verified,
      ageHours: Number(ageHours.toFixed(2)),
      durationMs: Date.now() - started,
    };
    logger.info('Backup restore drill passed', result);
    return result;
  } finally {
    // The decrypted dump is the live database in plaintext on local disk.
    // It does not outlive the drill by a second, whatever else happened.
    await fs.rm(scratch, { recursive: true, force: true }).catch((error) =>
      logger.error('could not remove drill scratch directory — it holds a decrypted dump', {
        scratch,
        error: String(error),
      }),
    );
  }
}
