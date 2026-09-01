import crypto from 'crypto';

/**
 * Signing an outbound webhook.
 *
 * ## The timestamp is part of what is signed, deliberately
 *
 * A signature over the body alone proves the body came from us and nothing
 * else — including *when*. Anyone who captures one valid request can replay it
 * forever, and every replay verifies. Signing `<timestamp>.<body>` and sending
 * the timestamp alongside lets a receiver reject anything older than their
 * tolerance, which is the whole difference between "this is authentic" and
 * "this is authentic and current".
 *
 * This is the scheme Stripe uses. Respond.io's published webhook signature is
 * over the body only; copying the shape of their API is worth doing, copying
 * that particular decision is not.
 *
 * ## Header format
 *
 * ```
 * X-RabiTech-Signature: t=1730000000,v1=<hex hmac>
 * X-RabiTech-Event: message.received
 * X-RabiTech-Delivery: <delivery id>
 * ```
 *
 * `v1` is versioned so a future scheme can ship alongside this one rather than
 * replacing it mid-flight — a receiver written against `v1` keeps working while
 * they migrate.
 */

export const SIGNATURE_HEADER = 'X-RabiTech-Signature';
export const EVENT_HEADER = 'X-RabiTech-Event';
export const DELIVERY_HEADER = 'X-RabiTech-Delivery';

/** 32 bytes of hex. Long enough that guessing is not a strategy. */
export function generateWebhookSecret(): string {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

export function signPayload(secret: string, body: string, timestampSeconds: number): string {
  const signed = `${timestampSeconds}.${body}`;
  const mac = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

/**
 * Verify a signature the way a receiver should.
 *
 * Exported because the gate uses it, and because it is the reference
 * implementation the documentation points at — a receiver copying working code
 * gets constant-time comparison and the freshness window for free, rather than
 * writing `===` and shipping a timing leak.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((piece) => piece.split('='))
      .filter((pair) => pair.length === 2)
      .map(([k, v]) => [k.trim(), v.trim()]),
  );

  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return { ok: false, reason: 'malformed signature header' };

  // Checked before the HMAC, so a replay is rejected without spending a hash.
  if (Math.abs(now - timestamp) > toleranceSeconds) return { ok: false, reason: 'timestamp outside tolerance' };

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  // Length is checked first because timingSafeEqual throws on a mismatch, and a
  // thrown exception is itself a signal about the input.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
