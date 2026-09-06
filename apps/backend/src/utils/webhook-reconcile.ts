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
 * Re-exported so existing callers keep their import site. The definition and
 * the reasoning live in lib/gateway-host.ts, which is a leaf module: the
 * provisioning worker needs the same value and must not pull this file in,
 * which reaches OpenWAService and most of the send path behind it.
 */
import { webhookBaseUrl } from '../lib/gateway-host';

export { webhookBaseUrl };

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
