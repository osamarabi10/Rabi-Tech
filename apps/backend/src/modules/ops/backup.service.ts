import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import logger from '../../lib/logger';

const run = promisify(execFile);

/**
 * Nightly database backup, with the part everyone skips.
 *
 * ## A dump is not a backup until it has been restored
 *
 * Producing a file is the easy half and the half that gives false confidence.
 * A truncated dump, a permissions error that wrote zero bytes, a schema the
 * running server can no longer load — all of these produce a file of plausible
 * size that fails at exactly the moment it is needed, which is the moment
 * nobody can afford to find out.
 *
 * So every backup is restored into a scratch database and counted before it is
 * called a backup. It costs seconds and converts "we have a file" into "we have
 * verified we can come back from this".
 *
 * ## Retention never deletes a file it did not create
 *
 * This directory already holds twenty hand-made dumps taken before risky
 * migrations, some irreplaceable. Automated files carry a prefix and retention
 * considers only that prefix. A retention policy that tidies up somebody else's
 * work is a data-loss feature wearing a housekeeping hat.
 */

const BACKUP_DIR = process.env.BACKUP_DIR || '/app/backups';
/** Only files we wrote are ever deleted. */
const AUTO_PREFIX = 'auto-';
const KEEP = Number(process.env.BACKUP_KEEP || 14);
/** Restored into, then dropped. Never the live database, whatever else breaks. */
const VERIFY_DB = 'rabitech_restore_check';

export type BackupResult = {
  file: string;
  bytes: number;
  /** Rows counted after restoring into the scratch database. */
  verified: { conversations: number; messages: number; contacts: number };
  durationMs: number;
  pruned: string[];
};

/** Connection parts, from the URL the app already uses. */
function connection() {
  const url = new URL(process.env.DATABASE_URL!);
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  };
}

/** `PGPASSWORD` rather than a URL, so the password never lands in a process list. */
function env(password: string): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: password };
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/**
 * Restore the dump into a scratch database and count what came back.
 *
 * The counts are the assertion. A dump that restores into an empty database
 * technically "restored" — and would be a catastrophe to discover during a real
 * recovery.
 */
async function verifyRestore(file: string): Promise<BackupResult['verified']> {
  const db = connection();
  const psql = (sql: string, database: string) =>
    run('psql', ['-h', db.host, '-p', db.port, '-U', db.user, '-d', database, '-tAc', sql], {
      env: env(db.password),
    });

  // Drop first: a previous run that died mid-verify must not fail this one.
  await psql(`DROP DATABASE IF EXISTS "${VERIFY_DB}"`, 'postgres');
  await psql(`CREATE DATABASE "${VERIFY_DB}"`, 'postgres');

  try {
    await run(
      'pg_restore',
      [
        '-h', db.host, '-p', db.port, '-U', db.user,
        '-d', VERIFY_DB,
        // The dump has no owner or ACL statements worth replaying into a
        // throwaway database, and failing on them would report a bad backup
        // when the backup is fine.
        '--no-owner', '--no-acl',
        // No --exit-on-error: pg_restore continues past non-fatal errors by
        // default and reports them at the end, which is what we want. Passing
        // it as `--exit-on-error=0` is invalid — it takes no argument — and
        // pg_restore then aborts having restored nothing. The row counts
        // caught exactly that, which is the point of counting.
        file,
      ],
      { env: env(db.password), maxBuffer: 32 * 1024 * 1024 },
    ).catch((error) => {
      // pg_restore exits non-zero on warnings it considers non-fatal. The
      // counts decide, not the exit code — but the detail is kept for the log.
      logger.warn('pg_restore reported issues; row counts will decide', {
        error: String(error).slice(0, 300),
      });
    });

    const count = async (table: string) => {
      const { stdout } = await psql(`SELECT count(*) FROM "${table}"`, VERIFY_DB);
      return Number(stdout.trim());
    };

    const verified = {
      conversations: await count('Conversation'),
      messages: await count('Message'),
      contacts: await count('Contact'),
    };

    // An empty restore is a failed backup wearing a valid file.
    if (verified.conversations === 0 && verified.messages === 0 && verified.contacts === 0) {
      throw new Error('restore produced an empty database — the dump is not usable');
    }

    return verified;
  } finally {
    // Always, even when verification threw: a scratch database left behind
    // turns the next run's DROP into the only thing standing between us and a
    // confusing failure.
    await psql(`DROP DATABASE IF EXISTS "${VERIFY_DB}"`, 'postgres').catch(() => {});
  }
}

/** Delete our own oldest files past the keep count. Nothing else, ever. */
async function prune(): Promise<string[]> {
  const entries = await fs.readdir(BACKUP_DIR);
  const ours = entries
    .filter((name) => name.startsWith(AUTO_PREFIX) && name.endsWith('.dump'))
    // The stamp sorts lexicographically because it is zero-padded and UTC.
    .sort()
    .reverse();

  const doomed = ours.slice(KEEP);
  for (const name of doomed) {
    await fs.unlink(path.join(BACKUP_DIR, name));
  }
  return doomed;
}

export async function runBackup(now: Date = new Date()): Promise<BackupResult> {
  const started = Date.now();
  const db = connection();
  await fs.mkdir(BACKUP_DIR, { recursive: true });

  const file = path.join(BACKUP_DIR, `${AUTO_PREFIX}${stamp(now)}.dump`);

  await run(
    'pg_dump',
    [
      '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database,
      // Custom format: compressed, and restorable selectively. A plain SQL file
      // cannot be restored table-by-table when only one thing is wrong.
      '-Fc',
      '-f', file,
    ],
    { env: env(db.password), maxBuffer: 32 * 1024 * 1024 },
  );

  const { size } = await fs.stat(file);
  if (size === 0) {
    await fs.unlink(file).catch(() => {});
    throw new Error('pg_dump produced an empty file');
  }

  let verified: BackupResult['verified'];
  try {
    verified = await verifyRestore(file);
  } catch (error) {
    /*
     * Keep the file, but rename it out of the automated set.
     *
     * Deleting it would destroy the evidence needed to diagnose the failure.
     * Leaving it named `auto-*` is worse: retention would count it toward the
     * keep limit and, on a directory listing, an unusable dump would be
     * indistinguishable from a good one — which is how somebody reaches for
     * the newest file during an incident and finds it empty.
     */
    const quarantined = file.replace(AUTO_PREFIX, 'FAILED-');
    await fs.rename(file, quarantined).catch(() => {});
    logger.error('backup verification FAILED — this dump should not be trusted', {
      file: path.basename(quarantined),
      error: String(error),
    });
    throw error;
  }

  const pruned = await prune();

  const result: BackupResult = {
    file: path.basename(file),
    bytes: size,
    verified,
    durationMs: Date.now() - started,
    pruned,
  };
  logger.info('Backup complete and verified', result);
  return result;
}

/** Newest first, for the console. Only ours — their manual dumps are not ours to report on. */
export async function listBackups(): Promise<Array<{ file: string; bytes: number; at: string }>> {
  const entries = await fs.readdir(BACKUP_DIR).catch(() => [] as string[]);
  const ours = entries.filter((n) => n.startsWith(AUTO_PREFIX) && n.endsWith('.dump'));
  const stats = await Promise.all(
    ours.map(async (name) => {
      const s = await fs.stat(path.join(BACKUP_DIR, name));
      return { file: name, bytes: s.size, at: s.mtime.toISOString() };
    }),
  );
  return stats.sort((a, b) => b.at.localeCompare(a.at));
}
