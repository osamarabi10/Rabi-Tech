const PRIVATE_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(?::\d+)?$/;

/** Allow localhost and private LAN origins (router Wi‑Fi access). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;

  const extra = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (extra.includes(origin)) return true;
  if (PRIVATE_ORIGIN.test(origin)) return true;

  if (process.env.NODE_ENV === 'development') {
    console.warn(`[cors] blocked origin: ${origin}`);
  }
  return false;
}

/** Express/socket CORS callback — must echo the origin when credentials are enabled. */
export function corsOriginCallback(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean | string) => void
): void {
  if (isAllowedOrigin(origin)) {
    callback(null, origin || true);
  } else {
    callback(null, false);
  }
}
