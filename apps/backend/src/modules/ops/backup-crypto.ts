import crypto from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { pipeline } from 'stream/promises';

/**
 * File-level AES-256-GCM, for the copy that leaves this machine.
 *
 * ## Why not `credential-crypto.ts`
 *
 * That module encrypts short strings and returns base64url, which is the right
 * shape for a token in a column and the wrong shape for a database dump: it
 * holds the whole plaintext and the whole ciphertext in memory at once, and
 * base64 adds a third on top. It is also keyed on `CHANNEL_ENCRYPTION_KEY`,
 * whose blast radius is already every stored channel token — the backup has no
 * business widening it.
 *
 * ## The key must outlive the machine
 *
 * An encrypted off-host copy whose only key lives in the `.env` that dies with
 * the host is not a backup, it is ciphertext. `BACKUP_ENCRYPTION_KEY` is
 * therefore deliberately separate and deliberately *absent by default*:
 * replication stays off until somebody sets it, and the boot log says so.
 * There is no plaintext fallback — uploading an unencrypted dump because a key
 * was missing is the one failure this module exists to prevent.
 *
 * ## Layout
 *
 * ```
 * [ 4 bytes magic "RBK1" ][ 12 bytes IV ][ ciphertext ... ][ 16 bytes GCM tag ]
 * ```
 *
 * The tag trails rather than leads because GCM produces it only after the last
 * block; writing it first would mean buffering the entire ciphertext to find
 * out what to put at the front. Decryption reads it from the end, which needs
 * the file size — cheap, since the file is already on disk.
 */

/** Identifies the format and its version, so a future v2 fails loudly rather than as garbage. */
const MAGIC = Buffer.from('RBK1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + IV_BYTES;

export class BackupKeyMissingError extends Error {
  constructor() {
    super('BACKUP_ENCRYPTION_KEY is not set (or is under 32 characters)');
    this.name = 'BackupKeyMissingError';
  }
}

/** Whether replication can run at all. Checked at boot so the log can say so once. */
export function backupEncryptionConfigured(): boolean {
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  return Boolean(secret && secret.length >= 32);
}

function encryptionKey(): Buffer {
  const secret = process.env.BACKUP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new BackupKeyMissingError();
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt `sourceFile` to `targetFile`.
 *
 * On any failure the partial target is removed. A half-written archive that
 * looks like a file is exactly the thing this whole module is here to avoid —
 * it would upload, list, and pass a size check, and fail only on restore.
 */
export async function encryptFile(sourceFile: string, targetFile: string): Promise<{ bytes: number }> {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const out = createWriteStream(targetFile);
  try {
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.write(Buffer.concat([MAGIC, iv]), (error) => (error ? reject(error) : resolve()));
    });
    await pipeline(createReadStream(sourceFile), cipher, out, { end: false });

    // Only valid after the cipher has flushed, which pipeline above guarantees.
    await new Promise<void>((resolve, reject) => {
      out.end(cipher.getAuthTag(), (error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } catch (error) {
    out.destroy();
    await fs.unlink(targetFile).catch(() => {});
    throw error;
  }

  const { size } = await fs.stat(targetFile);
  return { bytes: size };
}

/**
 * Decrypt `sourceFile` to `targetFile`.
 *
 * A wrong key, a flipped byte or a truncated upload all fail here at
 * `final()`, which is GCM doing its job: the tag is checked over the whole
 * message, so there is no partial-success case where some of the dump is
 * trustworthy. The partial target is removed for the same reason as above.
 */
export async function decryptFile(sourceFile: string, targetFile: string): Promise<{ bytes: number }> {
  const key = encryptionKey();
  const { size } = await fs.stat(sourceFile);
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new Error(`encrypted backup is too small to be valid (${size} bytes)`);
  }

  const header = Buffer.alloc(HEADER_BYTES);
  const tag = Buffer.alloc(TAG_BYTES);
  const handle = await fs.open(sourceFile, 'r');
  try {
    await handle.read(header, 0, HEADER_BYTES, 0);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('encrypted backup does not carry the RBK1 header — wrong file or wrong format');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAuthTag(tag);

  try {
    await pipeline(
      // Inclusive `end`, hence the -1: the tag is not ciphertext and feeding it
      // through the decipher would fail the tag check it is supposed to satisfy.
      createReadStream(sourceFile, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(targetFile),
    );
  } catch (error) {
    await fs.unlink(targetFile).catch(() => {});
    throw error;
  }

  const stat = await fs.stat(targetFile);
  return { bytes: stat.size };
}
