import crypto from 'crypto';
import { signingSecret } from '../lib/signing-secret';

/**
 * Time-limited signed URLs for media.
 *
 * A browser cannot put an `Authorization` header on an `<img src>`, so media
 * has to authenticate itself in the URL. Possession of a valid signature *is*
 * the authorisation: it is an HMAC over the exact resource plus an expiry, so
 * it cannot be edited to point at anything else and stops working within the
 * hour.
 *
 * ## The organization is in the payload, and has to be
 *
 * The first version signed only `msgId:session`, and the proxy then demanded
 * `req.user.organizationId` — which exists on the bearer path and never on the
 * signed one. So a correctly signed token was rejected with "Organization token
 * required", and the entire signed-URL mechanism was unreachable code. Carrying
 * the organization makes the token self-sufficient, which is the only thing it
 * could ever have been.
 *
 * ## Parsed from the right
 *
 * The expiry and signature are always the last two fields. Reading from the
 * left breaks the day a session name or an upstream URL contains a colon —
 * WhatsApp ids already contain `@` and `_`, and betting they will never contain
 * `:` is a bet with no upside.
 */

const MEDIA_URL_EXPIRY_SECONDS = 3600; // 1 hour

function sign(payload: string): string {
  return crypto
    .createHmac('sha256', signingSecret())
    .update(payload)
    .digest('hex');
}

function signatureMatches(payload: string, signature: string): boolean {
  const expected = sign(payload);
  const given = Buffer.from(signature, 'hex');
  const want = Buffer.from(expected, 'hex');
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

/** Split into [body, expiresAt, signature], reading the two fixed fields off the end. */
function splitFromRight(token: string): { body: string; expiresAt: number; signature: string } | null {
  const lastColon = token.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const signature = token.slice(lastColon + 1);

  const rest = token.slice(0, lastColon);
  const expiryColon = rest.lastIndexOf(':');
  if (expiryColon <= 0) return null;

  const expiresAt = Number.parseInt(rest.slice(expiryColon + 1), 10);
  if (!Number.isFinite(expiresAt)) return null;

  return { body: rest.slice(0, expiryColon), expiresAt, signature };
}

export function generateMediaToken(
  msgId: string,
  session: string,
  organizationId: string,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + MEDIA_URL_EXPIRY_SECONDS;
  const payload = `${msgId}:${session}:${organizationId}:${expiresAt}`;
  return `${payload}:${sign(payload)}`;
}

export function generateMediaProxyToken(url: string, organizationId: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + MEDIA_URL_EXPIRY_SECONDS;
  const payload = `${url}:${organizationId}:${expiresAt}`;
  return `${payload}:${sign(payload)}`;
}

export function verifyMediaToken(
  token: string,
): { msgId: string; session: string; organizationId: string } | null {
  const parts = splitFromRight(token);
  if (!parts) return null;
  if (Date.now() / 1000 > parts.expiresAt) return null;
  if (!signatureMatches(`${parts.body}:${parts.expiresAt}`, parts.signature)) return null;

  // The body is msgId:session:organizationId. Session and organization ids
  // never contain a colon; a WhatsApp message id might, so it takes the rest.
  const bodyLastColon = parts.body.lastIndexOf(':');
  if (bodyLastColon <= 0) return null;
  const organizationId = parts.body.slice(bodyLastColon + 1);

  const head = parts.body.slice(0, bodyLastColon);
  const headLastColon = head.lastIndexOf(':');
  if (headLastColon <= 0) return null;

  return {
    msgId: head.slice(0, headLastColon),
    session: head.slice(headLastColon + 1),
    organizationId,
  };
}

export function verifyMediaProxyToken(
  token: string,
): { url: string; organizationId: string } | null {
  const parts = splitFromRight(token);
  if (!parts) return null;
  if (Date.now() / 1000 > parts.expiresAt) return null;
  if (!signatureMatches(`${parts.body}:${parts.expiresAt}`, parts.signature)) return null;

  // The body is url:organizationId. The URL contains colons; the id does not.
  const lastColon = parts.body.lastIndexOf(':');
  if (lastColon <= 0) return null;

  return {
    url: parts.body.slice(0, lastColon),
    organizationId: parts.body.slice(lastColon + 1),
  };
}
