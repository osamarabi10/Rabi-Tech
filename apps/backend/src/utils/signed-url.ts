import crypto from 'crypto';

/**
 * Generate a time-limited signed URL for media access.
 * Prevents unauthorized direct access to media without authentication.
 *
 * Usage: /media-proxy?token=<signed>&msgId=123&session=it-support
 * Token contains HMAC(msgId + session + expiresAt, secret)
 */

const MEDIA_URL_EXPIRY_SECONDS = 3600; // 1 hour

export function generateMediaToken(msgId: string, session: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + MEDIA_URL_EXPIRY_SECONDS;
  const payload = `${msgId}:${session}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'default-secret')
    .update(payload)
    .digest('hex');
  return `${payload}:${signature}`;
}

export function generateMediaProxyToken(url: string): string {
  const expiresAt = Math.floor(Date.now() / 1000) + MEDIA_URL_EXPIRY_SECONDS;
  const payload = `${url}:${expiresAt}`;
  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET || 'default-secret')
    .update(payload)
    .digest('hex');
  return `${payload}:${signature}`;
}

export function verifyMediaToken(token: string): { msgId: string; session: string } | null {
  try {
    const parts = token.split(':');
    if (parts.length !== 4) return null;

    const [msgId, session, expiresAtStr, signature] = parts;
    const expiresAt = parseInt(expiresAtStr, 10);

    // Check expiry
    if (Date.now() / 1000 > expiresAt) return null;

    // Verify HMAC
    const payload = `${msgId}:${session}:${expiresAtStr}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'default-secret')
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

    return { msgId, session };
  } catch {
    return null;
  }
}

export function verifyMediaProxyToken(token: string): string | null {
  try {
    const lastColonIndex = token.lastIndexOf(':');
    if (lastColonIndex === -1) return null;

    const payload = token.substring(0, lastColonIndex);
    const signature = token.substring(lastColonIndex + 1);
    const parts = payload.split(':');

    if (parts.length < 2) return null;

    const expiresAtStr = parts[parts.length - 1];
    const expiresAt = parseInt(expiresAtStr, 10);

    // Check expiry
    if (Date.now() / 1000 > expiresAt) return null;

    // Verify HMAC
    const expectedSignature = crypto
      .createHmac('sha256', process.env.JWT_SECRET || 'default-secret')
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expectedSignature, 'hex');
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;


    // Extract URL (everything except last colon and expiry)
    const url = parts.slice(0, -1).join(':');
    return url;
  } catch {
    return null;
  }
}
