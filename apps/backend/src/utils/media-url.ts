import { generateMediaProxyToken, generateMediaToken } from './signed-url';

/**
 * Add the signature an `<img>` tag needs to a stored media URL.
 *
 * The proxy accepts a Bearer header or a signed `token` query parameter. The
 * webhook stores the URL with neither, and a browser cannot put an
 * Authorization header on an `<img src>` — so every image in every
 * conversation was fetched, refused with 401, and hidden by the tag's own
 * onError handler. The tokens were designed for exactly this and nothing ever
 * minted one.
 *
 * Signed at read time, never stored: it expires in an hour, and a token in the
 * database would be a permanently valid one the moment somebody copied it.
 */
export function signMediaUrl(
  mediaUrl: string | null,
  organizationId: string,
): string | null {
  if (!mediaUrl || !mediaUrl.startsWith('/media-proxy')) return mediaUrl;

  // Already carries one — a caller that signed it itself, or a replay.
  if (mediaUrl.includes('token=')) return mediaUrl;

  try {
    // A relative URL needs a base to parse; the base is thrown away again.
    const parsed = new URL(mediaUrl, 'http://internal');

    if (parsed.pathname === '/media-proxy/message') {
      const msgId = parsed.searchParams.get('msgId');
      const session = parsed.searchParams.get('session');
      if (!msgId || !session) return mediaUrl;
      parsed.searchParams.set('token', generateMediaToken(msgId, session, organizationId));
      return parsed.pathname + parsed.search;
    }

    if (parsed.pathname === '/media-proxy') {
      const upstream = parsed.searchParams.get('url');
      if (!upstream) return mediaUrl;
      parsed.searchParams.set('token', generateMediaProxyToken(upstream, organizationId));
      return parsed.pathname + parsed.search;
    }
  } catch {
    // A URL we cannot parse is one we cannot sign. Returned unchanged so the
    // failure stays visible rather than becoming a blank attachment.
  }

  return mediaUrl;
}
