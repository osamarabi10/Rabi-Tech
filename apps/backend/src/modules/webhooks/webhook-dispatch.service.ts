import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantScope } from '../../lib/tenant-context';
import { enqueueWebhookDelivery } from '../../workers/webhook-delivery.worker';
import { newDeliveryId, newEventId } from './webhook-policy';
import type { WebhookEvent, WebhookEnvelope } from './webhook-events';

/**
 * Emitting an event to an organization's configured endpoints.
 *
 * ## Never throws, never blocks
 *
 * `emitWebhook` is called from the middle of things that matter — a message
 * being sent, a conversation closing. A webhook is a *notification about* that
 * work, and it must not be able to fail it. Every path here swallows its errors
 * into a log line, and the actual HTTP call happens on a queue rather than
 * inline, so a receiver that takes ten seconds to answer does not add ten
 * seconds to an agent's send.
 *
 * That is also why the call sites use `void emitWebhook(...)` rather than
 * awaiting: the caller does not want the result and cannot act on it.
 *
 * ## Fan-out is per endpoint, and the event id is shared
 *
 * Three endpoints subscribed to `message.sent` produce three deliveries with
 * three delivery ids and **one** event id. A receiver that also happens to be
 * two of those endpoints can then tell it is the same occurrence — and a retry
 * repeats the event id too, which is what makes deduplication possible at all.
 */

/**
 * Fire an event. Fire-and-forget by design.
 *
 * Takes the organization id explicitly rather than reading tenant context,
 * because some call sites are inside workers where the scope is established
 * around them and being explicit at the call site is what makes that reviewable.
 */
export async function emitWebhook(
  event: WebhookEvent,
  data: Record<string, unknown>,
  organizationId?: string,
): Promise<void> {
  try {
    const scope = getTenantScope();
    const tenantId = organizationId
      ?? (scope && scope.type === 'ORGANIZATION' ? scope.organizationId : null);
    if (!tenantId) {
      // No tenant means nowhere to send. Logged rather than thrown: an event
      // that cannot be addressed is a bug in the caller, not a reason to fail
      // the customer-facing work that produced it.
      logger.warn('emitWebhook called with no organization scope', { event });
      return;
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { organizationId: tenantId, isActive: true, events: { has: event } },
      select: { id: true },
    });
    if (!endpoints.length) return;

    const eventId = newEventId();
    const occurredAt = new Date().toISOString();

    for (const endpoint of endpoints) {
      const envelope: WebhookEnvelope = {
        id: newDeliveryId(),
        event: { id: eventId, type: event, occurredAt },
        workspace: { id: tenantId },
        data,
      };
      await enqueueWebhookDelivery({
        organizationId: tenantId,
        endpointId: endpoint.id,
        envelope,
        attempt: 1,
      });
    }
  } catch (error) {
    logger.warn('Failed to emit webhook', { event, error: String((error as Error)?.message || error) });
  }
}
