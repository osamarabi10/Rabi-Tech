import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { signingSecret } from '../../lib/signing-secret';
import { webhookBaseUrl } from '../../lib/gateway-host';

export const MAX_SNIPPET_FILES = 5;
export const MAX_SNIPPET_FILE_BYTES = 20 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
]);

export function snippetUploadRoot(): string {
  return process.env.SNIPPET_UPLOAD_DIR || path.resolve(process.cwd(), 'uploads', 'snippets');
}

export function cleanSnippetFileName(value: unknown): string {
  const decoded = decodeURIComponent(String(value || '')).trim();
  const fileName = path.basename(decoded).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  if (!fileName || fileName === '.' || fileName === '..') throw new Error('A valid file name is required');
  return fileName;
}

export function validateSnippetUpload(body: Buffer, contentType: unknown): { body: Buffer; contentType: string } {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new Error('Upload body is required');
  if (body.length > MAX_SNIPPET_FILE_BYTES) throw new Error('Snippet files must be 20MB or smaller');
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(normalized)) throw new Error('This file type is not supported');
  return { body, contentType: normalized };
}

export function newStorageKey(): string {
  return crypto.randomUUID();
}

function assertPathPart(value: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid Snippet asset path');
}

export function snippetAssetPath(organizationId: string, storageKey: string): string {
  assertPathPart(organizationId);
  assertPathPart(storageKey);
  return path.join(snippetUploadRoot(), organizationId, storageKey);
}

export async function storeSnippetAsset(organizationId: string, storageKey: string, body: Buffer): Promise<void> {
  const directory = path.join(snippetUploadRoot(), organizationId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(snippetAssetPath(organizationId, storageKey), body, { mode: 0o600 });
}

export async function removeSnippetAsset(organizationId: string, storageKey: string): Promise<void> {
  await fs.rm(snippetAssetPath(organizationId, storageKey), { force: true });
}

export function signSnippetAsset(organizationId: string, storageKey: string): string {
  const secret = signingSecret();
  return crypto.createHmac('sha256', secret).update(`snippet:${organizationId}:${storageKey}`).digest('hex');
}

export function snippetAssetUrl(organizationId: string, storageKey: string): string {
  return `/api/snippets/assets/${organizationId}/${storageKey}?sig=${signSnippetAsset(organizationId, storageKey)}`;
}

export function verifySnippetAssetSignature(organizationId: string, storageKey: string, signature: string): boolean {
  const expected = Buffer.from(signSnippetAsset(organizationId, storageKey));
  const supplied = Buffer.from(String(signature || ''));
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

/**
 * Absolute URL for a snippet asset, addressed as the *gateway* must fetch it.
 *
 * Same host requirement as the webhook base, and the same former bug: while
 * this defaulted to `backend.local`, a per-tenant gateway could not resolve it,
 * so snippet media sent through a managed tenant fetched from nothing (D-14).
 */
export function gatewayReachableAssetUrl(url: string): string {
  if (!url.startsWith('/')) return url;
  return webhookBaseUrl() + url;
}
