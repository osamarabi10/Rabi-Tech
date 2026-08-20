import type { AutoReplyKind } from '@prisma/client';
import { prisma } from '../prisma';
import { getTenantCache } from '../lib/tenant-context';

/**
 * Resolves an organization's configured auto-reply text.
 *
 * THE RULE: there are no code-level fallbacks for customer-facing messages.
 * If an organization has not configured a template for this event, or has
 * deactivated it, this returns null and the caller MUST NOT send anything.
 *
 * A hardcoded default would put words the subscriber never approved in front of
 * their customers -- which is exactly how one company's support phone number
 * ended up being sent by every other subscriber.
 *
 * Defaults are seeded as editable database rows when an organization is created
 * (see seedDefaultAutoReplies), never as constants here.
 */
export async function resolveAutoReply(kind: AutoReplyKind): Promise<string | null> {
  const cache = getTenantCache();
  const cacheKey = `auto-reply:${kind}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached as string | null;

  const row = await prisma.messageTemplate.findFirst({
    where: { autoReplyKind: kind, isActive: true },
    select: { body: true },
  });
  const body = row?.body?.trim() || null;
  cache.set(cacheKey, body);
  return body;
}

/**
 * Renders an auto-reply with simple {{variable}} substitution, or returns null
 * when the organization has not configured this auto-reply.
 */
export async function renderAutoReply(
  kind: AutoReplyKind,
  vars: Record<string, string | number> = {},
): Promise<string | null> {
  const template = await resolveAutoReply(kind);
  if (!template) return null;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/**
 * Sends an auto-reply only if the organization configured one.
 * Returns the sent body, or null when nothing was sent.
 */
export async function withAutoReply(
  kind: AutoReplyKind,
  vars: Record<string, string | number>,
  send: (body: string) => Promise<unknown>,
): Promise<string | null> {
  const body = await renderAutoReply(kind, vars);
  if (!body) return null;
  await send(body);
  return body;
}

export function invalidateAutoReplyCache(kind?: AutoReplyKind): void {
  const cache = getTenantCache();
  if (kind) cache.delete(`auto-reply:${kind}`);
  else for (const key of [...cache.keys()]) if (key.startsWith('auto-reply:')) cache.delete(key);
}
