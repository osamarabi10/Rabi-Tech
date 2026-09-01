import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import logger from '../../lib/logger';
import { META_GRAPH_VERSION } from './meta.client';
import { signingSecret } from '../../lib/signing-secret';

/**
 * Inbound Meta media: fetched once, at ingest, and kept.
 *
 * Meta does not hand over a URL. It hands over a media **id**, which must be
 * exchanged for a download URL, which must then be fetched with the access
 * token in an Authorization header. That download URL expires in minutes.
 *
 * **Why not proxy on demand?** The expiry is the lesser reason. The real one is
 * where it puts the token.
 *
 * Proxying means re-resolving the media id every time somebody opens a
 * conversation — so the System User access token, the credential that sends *as
 * the customer's business to their own customers*, becomes reachable from the
 * request path of every agent viewing their own inbox. It would have to be
 * decrypted on a read path, held in memory during ordinary page traffic, and
 * passed to an outbound HTTP call triggered by anyone who can load a thread.
 * Every bug on that path — a logged error object, a traced request, a
 * mis-scoped lookup — becomes a token disclosure rather than a broken image.
 *
 * Downloading once at ingest confines the token to the ingest path, which runs
 * on a signed webhook, unattended, with no viewer involved. The expiry
 * behaviour is a second, smaller argument for the same choice: an image fetched
 * now is still there tomorrow, which is usually when someone looks at it.
 *
 * If this is ever revisited, that is the argument to answer. Storage cost is
 * the easy objection and not the one that matters.
 *
 * Storage mirrors the snippet-attachment mechanism (per-organization directory,
 * unguessable key, HMAC-signed URL) without reusing its table: a
 * SnippetAttachment row belongs to a template, and inbound media belongs to a
 * message. The reference needs no new column either way — Message already
 * carries mediaUrl, mediaType and mediaFileName.
 */

/** Refuse anything implausible before it touches the disk. */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export function messageMediaRoot(): string {
  // Shares the configured upload volume with snippets, in its own subtree, so
  // deployments have one directory to mount and back up rather than two.
  const base = process.env.SNIPPET_UPLOAD_DIR || path.resolve(process.cwd(), 'uploads', 'snippets');
  return path.resolve(base, '..', 'message-media');
}

export function newMediaKey(): string {
  return crypto.randomBytes(24).toString('hex');
}

export function messageMediaPath(organizationId: string, storageKey: string): string {
  // Both components are validated before they reach here, but resolve and check
  // anyway: a storage key that escaped its directory would read arbitrary files.
  const root = path.resolve(messageMediaRoot(), organizationId);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error('media path escaped its directory');
  return full;
}

function sign(organizationId: string, storageKey: string): string {
  const secret = signingSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`message-media:${organizationId}:${storageKey}`)
    .digest('hex');
}

export function messageMediaUrl(organizationId: string, storageKey: string): string {
  return `/api/channels/media/${organizationId}/${storageKey}?sig=${sign(organizationId, storageKey)}`;
}

export function verifyMessageMediaSignature(
  organizationId: string,
  storageKey: string,
  signature: string,
): boolean {
  const expected = Buffer.from(sign(organizationId, storageKey));
  const supplied = Buffer.from(String(signature || ''));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export type StoredMedia = {
  url: string;
  mimeType: string | null;
  fileName: string | null;
};

/**
 * Resolve a Meta media id and store the bytes.
 *
 * Returns null on any failure, deliberately: a message whose picture could not
 * be fetched is still a message the customer sent, and losing the whole thing
 * because an image did not arrive would be the worse outcome. The caller
 * persists the text and records that media was expected.
 */
export async function downloadMetaMedia(
  organizationId: string,
  mediaId: string,
  accessToken: string,
  fallbackFileName?: string | null,
): Promise<StoredMedia | null> {
  try {
    // 1. id -> a short-lived, authenticated download URL.
    const lookup = await axios.get(
      `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` }, timeout: DOWNLOAD_TIMEOUT_MS },
    );
    const url = lookup.data?.url;
    const mimeType: string | null = lookup.data?.mime_type ?? null;
    if (!url) return null;

    // 2. Fetch the bytes. The token is required here too - the URL alone is not
    //    a capability, which is the one good thing about it expiring.
    const download = await axios.get<ArrayBuffer>(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxContentLength: MAX_MEDIA_BYTES,
      maxBodyLength: MAX_MEDIA_BYTES,
    });

    const body = Buffer.from(download.data);
    if (!body.length || body.length > MAX_MEDIA_BYTES) return null;

    const storageKey = newMediaKey();
    const target = messageMediaPath(organizationId, storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);

    return {
      url: messageMediaUrl(organizationId, storageKey),
      mimeType,
      fileName: fallbackFileName ?? null,
    };
  } catch (error) {
    // Never the media id and never the token - the id is a handle to the
    // customer's content and the token is the credential that reads it.
    logger.warn('Meta media could not be downloaded; message kept without it', {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Read a stored asset back for the serving route. */
export async function readMessageMedia(
  organizationId: string,
  storageKey: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(messageMediaPath(organizationId, storageKey));
  } catch {
    return null;
  }
}
