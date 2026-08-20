import { prisma } from '../prisma';
import logger from '../lib/logger';
import { getTenantId } from '../lib/tenant-context';
import { OpenWAService } from '../modules/whatsapp/openwa.service';

/** Events the backend needs to keep conversations and delivery state current. */
export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.ack',
  'session.status',
  'session.authenticated',
  'session.disconnected',
] as const;

/**
 * Base URL the gateway container uses to reach this backend.
 *
 * Note this is the *gateway's* view of us, not a public URL — the gateway runs
 * beside the backend. Two constraints shape the default: the gateway's URL
 * validator rejects single-label hosts (`backend`), and its SSRF guard must
 * allowlist whatever host we pick (`SSRF_ALLOWED_HOSTS` on the gateway).
 * `backend.local` is a compose network alias, so it works on any Docker host —
 * unlike host.docker.internal, which only exists on Docker Desktop.
 */
export function webhookBaseUrl(): string {
  return (process.env.BACKEND_INTERNAL_URL || 'http://backend.local:4000').replace(/\/$/, '');
}

/**
 * Makes sure the current organization's gateway session posts events back to us.
 *
 * Registration previously happened only inside the provisioning state machine.
 * Any session linked outside that path — an existing session, a re-scan, a
 * manually created one — ended up with no webhook at all, and inbound messages
 * were dropped without a single error anywhere. This is idempotent and cheap, so
 * it can be called from any path that observes a live session.
 */
export async function reconcileSessionWebhook(): Promise<boolean> {
  const organizationId = getTenantId();

  const channel = await prisma.organizationChannel.findUnique({
    where: { organizationId_kind: { organizationId, kind: 'OPENWA' } },
    select: { webhookToken: true, status: true },
  });
  if (!channel?.webhookToken || channel.status !== 'ACTIVE') return false;

  const url = `${webhookBaseUrl()}/webhooks/openwa/${channel.webhookToken}`;

  try {
    const created = await OpenWAService.ensureWebhook(url);
    if (created > 0) {
      logger.info('Registered missing gateway webhook', { organizationId, created });
    }
    return created > 0;
  } catch (error) {
    logger.warn('Could not reconcile gateway webhook', { organizationId, error: String(error) });
    return false;
  }
}
