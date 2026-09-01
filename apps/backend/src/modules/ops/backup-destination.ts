import { promises as fs } from 'fs';
import path from 'path';

/**
 * Where the encrypted copy of a verified dump goes.
 *
 * ## Why an interface for one implementation
 *
 * F4.1b asks for an encrypted object-store copy and a restore drill from that
 * copy. The drill is the half that carries the value — a remote copy nobody has
 * ever pulled back is an assertion about the past, not a tested path, which is
 * the same reasoning this repository already applies to `down.sql`. The drill
 * can be built and proven today; the object store is an account decision.
 *
 * So the seam is here, deliberately narrow: four methods, no provider concepts
 * leaking through. A Backblaze B2 or Cloudflare R2 implementation is one file
 * against this interface and nothing else in the codebase moves.
 *
 * **This does not close F4.1b.** A directory on the same host survives a
 * container replacement — which the existing bind mount already does — and does
 * not survive the disk or VPS loss that the item exists for. The checklist
 * should keep saying so until a real destination is configured.
 */
export interface BackupDestination {
  /** Named in logs and alerts, so a failure says *where* it failed. */
  readonly name: string;
  /** True only for a destination that survives this host dying. */
  readonly offHost: boolean;
  put(localFile: string, key: string): Promise<{ bytes: number }>;
  get(key: string, destFile: string): Promise<void>;
  /** Newest first. Only keys this destination wrote. */
  list(): Promise<Array<{ key: string; bytes: number; at: string }>>;
  /** Delete our own oldest past `keep`. Returns what went. */
  prune(keep: number): Promise<string[]>;
}

/**
 * Only keys carrying this prefix are ever listed or deleted.
 *
 * The local dump directory already holds hand-made dumps taken before risky
 * migrations, and `backup.service.ts` guards them the same way. The rule
 * matters more here, not less: a bucket is the kind of place that ends up
 * shared, and a retention policy that tidies up somebody else's work is a
 * data-loss feature wearing a housekeeping hat.
 */
const REPLICA_PREFIX = 'auto-';
const REPLICA_SUFFIX = '.dump.enc';

export function replicaKeyFor(dumpFileName: string): string {
  return `${dumpFileName}.enc`;
}

function ours(key: string): boolean {
  return key.startsWith(REPLICA_PREFIX) && key.endsWith(REPLICA_SUFFIX);
}

/**
 * A second directory on a filesystem this process can write to.
 *
 * Useful as a real destination only when it is a different physical device —
 * another drive, a mounted NAS, a syncing folder. Pointed at a sibling of the
 * dump directory it proves the pipeline and protects against almost nothing,
 * which is why `offHost` is a constructor argument the operator has to assert
 * rather than something this class decides about itself.
 */
export class LocalDirectoryDestination implements BackupDestination {
  readonly name: string;

  constructor(private readonly dir: string, readonly offHost: boolean) {
    this.name = `local:${dir}`;
  }

  async put(localFile: string, key: string): Promise<{ bytes: number }> {
    await fs.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, key);
    /*
     * Copy to a temporary name, then rename into place.
     *
     * A rename within one directory is atomic, so a reader — the drill, or a
     * human during an incident — never sees a key that is still being written.
     * Without this, a copy interrupted mid-write leaves a short file under the
     * real name, which lists fine, passes a size check, and fails on restore.
     */
    const staging = `${target}.partial`;
    await fs.copyFile(localFile, staging);
    await fs.rename(staging, target).catch(async (error) => {
      await fs.unlink(staging).catch(() => {});
      throw error;
    });
    const { size } = await fs.stat(target);
    return { bytes: size };
  }

  async get(key: string, destFile: string): Promise<void> {
    await fs.copyFile(path.join(this.dir, key), destFile);
  }

  async list(): Promise<Array<{ key: string; bytes: number; at: string }>> {
    const entries = await fs.readdir(this.dir).catch(() => [] as string[]);
    const stats = await Promise.all(
      entries.filter(ours).map(async (key) => {
        const s = await fs.stat(path.join(this.dir, key));
        return { key, bytes: s.size, at: s.mtime.toISOString() };
      }),
    );
    // By key, not mtime: the stamp is zero-padded UTC and therefore sorts
    // correctly, while mtime is whatever the copy happened to set and reorders
    // if the directory is ever rsynced.
    return stats.sort((a, b) => b.key.localeCompare(a.key));
  }

  async prune(keep: number): Promise<string[]> {
    const existing = await this.list();
    const doomed = existing.slice(keep).map((entry) => entry.key);
    for (const key of doomed) {
      await fs.unlink(path.join(this.dir, key));
    }
    return doomed;
  }
}

/**
 * The configured destination, or `null` when replication is switched off.
 *
 * Null is a supported state and not an error: this is a system that runs on a
 * laptop today and on a VPS later, and a backup that refuses to run because it
 * cannot reach a bucket would be a worse outcome than one that runs and says it
 * did not replicate.
 */
export function getBackupDestination(): BackupDestination | null {
  const dir = process.env.BACKUP_REPLICA_DIR;
  if (!dir) return null;
  // The operator asserts this, because nothing observable from inside the
  // process can tell a second physical device from a sibling folder.
  const offHost = process.env.BACKUP_REPLICA_OFFHOST === '1';
  return new LocalDirectoryDestination(dir, offHost);
}
