/**
 * API/Socket base URL — uses same-origin paths, avoiding subdomain routing issues.
 *
 * The frontend and backend should be served from the same origin (e.g., http://localhost:8080 with /api proxied to backend).
 * This avoids hostname-dependent logic which is error-prone and causes issues with custom domains in Phase 1.5.
 */
export function getBackendBaseUrl(): string {
  if (typeof window !== 'undefined') {
    // Same-origin: use absolute path that works from any browser on the LAN
    return '';  // Empty string means use relative paths within the same origin
  }
  // Server-side rendering: use internal URL
  return process.env.NEXT_PUBLIC_API_URL?.replace('localhost', 'backend') || `http://localhost:4000`;
}
