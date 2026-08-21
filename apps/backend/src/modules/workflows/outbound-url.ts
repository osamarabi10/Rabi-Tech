import dns from 'dns/promises';
import net from 'net';

/**
 * Guard for tenant-supplied outbound URLs.
 *
 * The `HTTP_WEBHOOK` action is the first place this backend makes an HTTP
 * request to an address a *customer* chose. That is a server-side request
 * forgery primitive, and this backend sits on a Docker network with:
 *
 *   - `postgres:5432`     — every tenant's data
 *   - `redis:6379`        — every queue
 *   - `openwa:2785`       — every tenant's WhatsApp session
 *   - `backend.local:4000` — this API, including `/api/platform/*`
 *   - `169.254.169.254`   — cloud instance metadata, once this leaves the laptop
 *
 * Without a guard, a workflow action pointed at any of those turns a tenant
 * feature into a read of the whole platform. The gateway already runs its own
 * SSRF allowlist for the same reason; this is the backend's half.
 *
 * Two checks, and both are needed:
 *
 *  1. **Scheme and shape** — https only (http allowed solely when explicitly
 *     enabled for local development), no credentials in the URL, no odd ports.
 *  2. **Resolved address** — the hostname is resolved and *every* returned
 *     address is checked. A name that looks public can resolve to 127.0.0.1,
 *     and a name that resolves publicly once can resolve privately on the
 *     second lookup (DNS rebinding), which is why the caller is handed the
 *     resolved IP to connect to rather than the hostname.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/** Hostnames that are never valid targets regardless of what they resolve to. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'postgres',
  'redis',
  'openwa',
  'waha',
  'backend',
  'backend.local',
  'frontend',
  'metadata',
  'metadata.google.internal',
]);

/** Ports that are our own infrastructure. Blocked even on a public address. */
const BLOCKED_PORTS = new Set([22, 25, 445, 3000, 3306, 4000, 5432, 6379, 2785, 27017, 9200]);

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;                        // 10/8
  if (a === 127) return true;                       // loopback
  if (a === 0) return true;                         // "this network"
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;          // 192.168/16
  if (a === 169 && b === 254) return true;          // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                        // multicast + reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const value = ip.toLowerCase();
  if (value === '::1' || value === '::') return true;
  if (value.startsWith('fe80')) return true;             // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // unique-local
  // IPv4-mapped (::ffff:127.0.0.1) must be judged as the v4 address it carries.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // not an IP at all — refuse rather than guess
}

export type SafeTarget = {
  /** The URL to request, with the hostname replaced by a verified address. */
  url: string;
  /** Sent as Host so virtual hosting and TLS SNI still work. */
  hostHeader: string;
  address: string;
};

/**
 * Validate a webhook URL and resolve it to an address that was actually checked.
 *
 * Returns the resolved IP so the request connects to the address this function
 * approved. Re-resolving at request time would reopen the rebinding window it
 * just closed.
 */
export async function assertSafeWebhookUrl(raw: string): Promise<SafeTarget> {
  let parsed: URL;
  try {
    parsed = new URL(String(raw || '').trim());
  } catch {
    throw new BlockedUrlError('Webhook URL is not a valid URL');
  }

  const allowHttp = process.env.WORKFLOW_WEBHOOK_ALLOW_HTTP === '1';
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new BlockedUrlError('Webhook URL must use https');
  }

  if (parsed.username || parsed.password) {
    throw new BlockedUrlError('Webhook URL must not contain credentials');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) throw new BlockedUrlError('Webhook URL has no host');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new BlockedUrlError(`Webhook URL host "${hostname}" is not allowed`);
  }
  // A single-label host can only be something on our own network.
  if (!hostname.includes('.') && net.isIP(hostname) === 0) {
    throw new BlockedUrlError('Webhook URL must use a fully qualified host');
  }

  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  if (BLOCKED_PORTS.has(port)) {
    throw new BlockedUrlError(`Webhook URL port ${port} is not allowed`);
  }

  let addresses: string[];
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await dns.lookup(hostname, { all: true });
      addresses = resolved.map((entry) => entry.address);
    } catch {
      throw new BlockedUrlError(`Webhook URL host "${hostname}" could not be resolved`);
    }
  }

  if (!addresses.length) {
    throw new BlockedUrlError(`Webhook URL host "${hostname}" resolved to nothing`);
  }

  // EVERY address must be public. A host with one public and one private
  // address would otherwise be a coin flip that eventually lands inside.
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new BlockedUrlError(
        `Webhook URL host "${hostname}" resolves to a private address and is not allowed`,
      );
    }
  }

  const target = new URL(parsed.toString());
  target.hostname = addresses[0];
  return { url: target.toString(), hostHeader: parsed.host, address: addresses[0] };
}
