/**
 * Off-host backup replication: encryption, destination, retention, freshness.
 *
 * ## This gate deliberately does not need Postgres
 *
 * The drill's other half — restoring a dump and counting rows — is already
 * proven nightly by `backup.service.ts`, and needs the stack up. Everything
 * *new* in F4.1b is filesystem and crypto, so this runs hermetically in a
 * temporary directory with no database, no Redis and no Docker.
 *
 * That is a deliberate design choice, not a shortcut. Three defects in this
 * repository were gates reporting on their environment rather than on the code
 * (D-5, D-10, D-12, D-16), and this project's own host port proxy has degraded
 * often enough that a check requiring a live Postgres would fail for reasons
 * that say nothing about whether backups replicate. A gate that cannot be
 * broken by Docker is worth more than one that covers a little more ground.
 *
 * Runs against the compiled output in dist/, which is why the npm script builds
 * first — the same reason as the finance gate: importing the TypeScript sources
 * would test code the server does not run.
 */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// No repo-root .env here, and that is intentional: every value this gate needs
// it sets itself. Reading DATABASE_URL or a real BACKUP_REPLICA_DIR from the
// ambient shell is precisely the D-12 failure — a gate whose result depends on
// which terminal it was started from.
const {
  encryptFile,
  decryptFile,
  backupEncryptionConfigured,
} = require('../dist/modules/ops/backup-crypto');
const {
  LocalDirectoryDestination,
  getBackupDestination,
  replicaKeyFor,
} = require('../dist/modules/ops/backup-destination');
const { replicaAge, maxReplicaAgeHours } = require('../dist/modules/ops/backup-drill');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ''}`);
  }
}

async function rejects(label, fn, expected) {
  try {
    await fn();
    check(label, false, 'expected a rejection, got success');
  } catch (error) {
    const message = String(error);
    check(label, expected ? expected.test(message) : true, expected ? message : undefined);
  }
}

async function main() {
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rabitech-backup-gate-'));
  const dumpDir = path.join(scratch, 'dumps');
  const replicaDir = path.join(scratch, 'replica');
  await fs.promises.mkdir(dumpDir, { recursive: true });

  // Deliberately larger than one cipher block and not a round number, so a
  // block-boundary bug cannot pass by coincidence.
  const plaintext = crypto.randomBytes(1024 * 97 + 13);
  const dump = path.join(dumpDir, 'auto-20260901-032000.dump');
  await fs.promises.writeFile(dump, plaintext);

  const previousKey = process.env.BACKUP_ENCRYPTION_KEY;
  const previousDir = process.env.BACKUP_REPLICA_DIR;
  const previousOffHost = process.env.BACKUP_REPLICA_OFFHOST;
  const previousMaxAge = process.env.BACKUP_REPLICA_MAX_AGE_HOURS;

  try {
    // ---- Encryption key posture -------------------------------------------
    delete process.env.BACKUP_ENCRYPTION_KEY;
    check('no key configured reports replication as off', backupEncryptionConfigured() === false);
    await rejects(
      'encrypting without a key refuses rather than writing plaintext',
      () => encryptFile(dump, path.join(scratch, 'nokey.enc')),
      /BACKUP_ENCRYPTION_KEY/,
    );
    check(
      'a refused encryption leaves no output file behind',
      fs.existsSync(path.join(scratch, 'nokey.enc')) === false,
    );

    process.env.BACKUP_ENCRYPTION_KEY = 'short-key-under-32-characters';
    check('a key under 32 characters is refused', backupEncryptionConfigured() === false);

    process.env.BACKUP_ENCRYPTION_KEY = 'gate-backup-encryption-key-at-least-32-chars';
    check('a 32+ character key enables replication', backupEncryptionConfigured() === true);

    // ---- Encrypt / decrypt round trip -------------------------------------
    const encrypted = path.join(scratch, 'roundtrip.enc');
    const { bytes: encryptedBytes } = await encryptFile(dump, encrypted);
    check(
      'ciphertext is header + plaintext + tag in length',
      encryptedBytes === plaintext.length + 16 + 16,
      `${encryptedBytes} vs ${plaintext.length + 32}`,
    );
    check(
      'ciphertext does not contain the plaintext',
      fs.readFileSync(encrypted).includes(plaintext.subarray(0, 64)) === false,
    );

    const decrypted = path.join(scratch, 'roundtrip.dump');
    await decryptFile(encrypted, decrypted);
    check(
      'decrypt round-trips to byte-identical plaintext',
      Buffer.compare(fs.readFileSync(decrypted), plaintext) === 0,
    );

    // ---- Tamper and wrong-key detection -----------------------------------
    const tampered = path.join(scratch, 'tampered.enc');
    const bytes = fs.readFileSync(encrypted);
    // A single flipped bit in the middle of the ciphertext.
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    fs.writeFileSync(tampered, bytes);
    await rejects(
      'a single flipped byte fails the auth tag instead of restoring garbage',
      () => decryptFile(tampered, path.join(scratch, 'tampered.dump')),
    );
    check(
      'a failed decrypt leaves no partial dump behind',
      fs.existsSync(path.join(scratch, 'tampered.dump')) === false,
    );

    process.env.BACKUP_ENCRYPTION_KEY = 'a-different-gate-key-also-at-least-32-chars';
    await rejects(
      'the wrong key fails the auth tag',
      () => decryptFile(encrypted, path.join(scratch, 'wrongkey.dump')),
    );
    process.env.BACKUP_ENCRYPTION_KEY = 'gate-backup-encryption-key-at-least-32-chars';

    const truncated = path.join(scratch, 'truncated.enc');
    fs.writeFileSync(truncated, fs.readFileSync(encrypted).subarray(0, 20));
    await rejects(
      'a truncated upload is refused, not half-restored',
      () => decryptFile(truncated, path.join(scratch, 'truncated.dump')),
    );

    const notOurs = path.join(scratch, 'foreign.enc');
    fs.writeFileSync(notOurs, Buffer.concat([Buffer.from('ZIP0'), crypto.randomBytes(200)]));
    await rejects(
      'a file without the RBK1 header is named as the wrong format',
      () => decryptFile(notOurs, path.join(scratch, 'foreign.dump')),
      /RBK1/,
    );

    // ---- Destination: put / list / get ------------------------------------
    const destination = new LocalDirectoryDestination(replicaDir, false);
    const key = replicaKeyFor(path.basename(dump));
    check('replica key is the dump name plus .enc', key === 'auto-20260901-032000.dump.enc');

    await destination.put(encrypted, key);
    const listed = await destination.list();
    check('a written copy is listed', listed.length === 1 && listed[0].key === key);

    const pulled = path.join(scratch, 'pulled.enc');
    await destination.get(key, pulled);
    check(
      'get returns the same bytes that were put',
      Buffer.compare(fs.readFileSync(pulled), fs.readFileSync(encrypted)) === 0,
    );

    const pulledPlain = path.join(scratch, 'pulled.dump');
    await decryptFile(pulled, pulledPlain);
    check(
      'the full put/get/decrypt path returns the original dump',
      Buffer.compare(fs.readFileSync(pulledPlain), plaintext) === 0,
    );

    check(
      'no .partial staging file is left in the destination',
      fs.readdirSync(replicaDir).some((n) => n.endsWith('.partial')) === false,
    );

    // ---- Retention ---------------------------------------------------------
    for (const stamp of ['20260828-032000', '20260829-032000', '20260830-032000', '20260831-032000']) {
      await destination.put(encrypted, `auto-${stamp}.dump.enc`);
    }
    // A hand-made copy and an unrelated file, neither of which is ours.
    fs.writeFileSync(path.join(replicaDir, 'manual-pre-migration.dump.enc'), 'not ours');
    fs.writeFileSync(path.join(replicaDir, 'notes.txt'), 'not ours either');

    const before = await destination.list();
    check('list ignores files this destination did not write', before.length === 5, `${before.length}`);
    check('list is newest first', before[0].key === 'auto-20260901-032000.dump.enc', before[0].key);

    const doomed = await destination.prune(2);
    check('prune removes exactly the oldest past the keep count', doomed.length === 3, doomed.join(','));
    check(
      'prune keeps the newest',
      (await destination.list()).map((e) => e.key).join(',') ===
        'auto-20260901-032000.dump.enc,auto-20260831-032000.dump.enc',
    );
    check(
      'prune never deletes a file it did not write',
      fs.existsSync(path.join(replicaDir, 'manual-pre-migration.dump.enc')) &&
        fs.existsSync(path.join(replicaDir, 'notes.txt')),
    );

    // ---- Freshness ---------------------------------------------------------
    process.env.BACKUP_REPLICA_MAX_AGE_HOURS = '48';
    const now = new Date('2026-09-01T12:00:00Z');
    check('max age reads the environment at call time', maxReplicaAgeHours() === 48);
    check(
      'a copy from this morning is fresh',
      replicaAge('2026-09-01T03:20:00Z', now).stale === false,
    );
    check(
      'a copy from three weeks ago is stale even though it would restore',
      replicaAge('2026-08-11T03:20:00Z', now).stale === true,
    );
    check(
      'age is reported in hours',
      Math.round(replicaAge('2026-08-31T12:00:00Z', now).ageHours) === 24,
    );

    // ---- Configuration factory --------------------------------------------
    delete process.env.BACKUP_REPLICA_DIR;
    check('no BACKUP_REPLICA_DIR means no destination', getBackupDestination() === null);

    process.env.BACKUP_REPLICA_DIR = replicaDir;
    delete process.env.BACKUP_REPLICA_OFFHOST;
    check(
      'a destination is not off-host unless the operator says so',
      getBackupDestination().offHost === false,
    );

    process.env.BACKUP_REPLICA_OFFHOST = '1';
    check('BACKUP_REPLICA_OFFHOST=1 marks it off-host', getBackupDestination().offHost === true);
  } finally {
    const restore = (name, value) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore('BACKUP_ENCRYPTION_KEY', previousKey);
    restore('BACKUP_REPLICA_DIR', previousDir);
    restore('BACKUP_REPLICA_OFFHOST', previousOffHost);
    restore('BACKUP_REPLICA_MAX_AGE_HOURS', previousMaxAge);
    // Everything this gate made lived under one temporary directory, so cleanup
    // is one call and cannot reach anything real.
    await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
