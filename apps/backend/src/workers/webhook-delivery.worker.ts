import { Queue, Worker } from 'bullmq';
import { prisma } from '../prisma';
import logger from '../lib/logger';
import { runAsOrganization, runAsPlatform } from '../lib/tenant-context';
import { recordDelivery } from '../modules/webhooks/webhook-log.service';
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  signPayload,
} from '../modules/webhooks/webhook-signature';
import type { WebhookEnvelope } from '../modules/webhooks/webhook-events';
import {
  DEACTIVATE_AFTER_FAILURES,
  DEACTIVATE_WINDOW_MINUTES,
  MAX_ATTEMPTS,
  REQUEST_TIMEOUT_MS,
  WEBHOOK_RETRY_DELAYS_MS,
} from '../modules/webhooks/webhook-policy';

/**
 * Delivering outbound webhooks.
 *
 * ## Retries: 30s, 60s, 90s, then stop
 *
 * Four attempts total, the schedule Respond.io publishes. Deliberately linear
 * rather than exponential: these are a subscriber's own endpoints, usually a
 * small server or a serverless function, and the failure being recovered from
 * is a deploy or a restart — minutes, not hours. An exponential ladder would
 * still be retrying tomorrow, long after the event stopped being useful.
 *
 * ## Auto-deactivation: 30 failures in 30 minutes
 *
 * A URL that has been failing for half an hour is not coming back inside this
 * job's lifetime, and continuing to retry costs us and floods them when it
 * does. What matters more than switching it off is being able to say **why**:
 * `disabledReason` is written in the words the console shows, so a subscriber
 * finds out from their own screen instead of from a support ticket.
 */

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

/*
  Re-exported, not redefined. The policy lives in webhook-policy.ts because this
  module constructs a Queue at load time — importing it just to read a constant
  opens a Redis connection and produces a process that never exits.
*/
export {
  WEBHOOK_RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  DEACTIVATE_AFTER_FAILURES,
  DEACTIVATE_WINDOW_MINUTES,
  newDeliveryId,
  newEventId,
} from '../modules/webhooks/webhook-policy';

export const webhookQueue = new Queue('webhook-delivery', {
  connection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 200 },
});

export type WebhookJob = {
  organizationId: string;
  endpointId: string;
  envelope: WebhookEnvelope;
  attempt: number;
};

export async function enqueueWebhookDelivery(job: WebhookJob, delayMs = 0) {
  await webhookQueue.add('deliver', job, {
    delay: delayMs,
    // Deterministic, so the same attempt of the same delivery cannot be queued
    // twice by two processes racing.
    jobId: `${job.organizationId}--wh-${job.envelope.id}-a${job.attempt}`,
  });
}

/**
 * Should this endpoint be switched off?
 *
 * Counts *failures*, not consecutive failures. An endpoint alternating between
 * success and failure thirty times in half an hour is broken in a way that
 * matters just as much as one failing straight through, and a consecutive
 * counter would never fire on it.
 */
async function considerDeactivation(endpointId: string) {
  const since = new Date(Date.now() - DEACTIVATE_WINDOW_MINUTES * 60_000);
  const failures = await prisma.webhookDeliveryLog.count({
    where: { webhookId: endpointId, ok: false, createdAt: { gte: since } },
  });
  if (failures < DEACTIVATE_AFTER_FAILURES) return;

  await prisma.webhookEndpoint.updateMany({
    where: { id: endpointId, isActive: true },
    data: {
      isActive: false,
      disabledAt: new Date(),
      disabledReason: `Turned off automatically after ${failures} failed deliveries in ${DEACTIVATE_WINDOW_MINUTES} minutes. Fix the endpoint, then re-enable it here.`,
    },
  });
  logger.warn('Webhook endpoint auto-deactivated', { endpointId, failures });
}

export async function deliverOnce(job: WebhookJob): Promise<{ ok: boolean; retryable: boolean }> {
  const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: job.endpointId } });
  // Deleted or switched off since this was queued. Not a failure — dropping it
  // silently is correct, and logging it as a failure would push a healthy
  // endpoint towards deactivation on its way out.
  if (!endpoint || !endpoint.isActive) return { ok: false, retryable: false };

  const body = JSON.stringify(job.envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;

  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SIGNATURE_HEADER]: signPayload(endpoint.secret, body, timestamp),
        [EVENT_HEADER]: job.envelope.event.type,
        [DELIVERY_HEADER]: job.envelope.id,
        'User-Agent': 'RabiTech-Webhooks/1',
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    statusCode = response.status;
    // Read a bounded amount. A receiver returning a 50 MB error page must not
    // become our memory problem, and nobody debugs from more than this.
    responseBody = (await response.text().catch(() => ''))?.slice(0, 2000) || null;
  } catch (error) {
    errorMessage = String((error as Error)?.message || error).slice(0, 500);
  }

  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;

  await recordDelivery({
    direction: 'OUTBOUND',
    webhookId: endpoint.id,
    eventType: job.envelope.event.type,
    // The full URL goes in; recordDelivery keeps only the host, because a URL
    // can carry a token in its query string and that is exactly where it would
    // sit in plaintext forever.
    targetUrl: endpoint.url,
    statusCode,
    ok,
    errorMessage,
    requestPayload: body,
    responseBody,
    durationMs: Date.now() - startedAt,
    attempt: job.attempt,
  });

  await prisma.webhookEndpoint.updateMany({
    where: { id: endpoint.id },
    data: {
      lastDeliveryAt: new Date(),
      ...(ok ? { lastSuccessAt: new Date() } : { lastFailureAt: new Date() }),
    },
  });

  if (ok) return { ok: true, retryable: false };

  await considerDeactivation(endpoint.id);

  /*
    A 4xx is the receiver saying the request itself is wrong, and repeating it
    changes nothing — except on 408 and 429, which are explicitly "try again".
    Retrying a 400 four times turns one misconfiguration into four log lines and
    four minutes of delay before the subscriber sees the real answer.
  */
  const retryable =
    statusCode === null || statusCode >= 500 || statusCode === 408 || statusCode === 429;
  return { ok: false, retryable };
}

export function startWebhookDeliveryWorker() {
  const worker = new Worker<WebhookJob>(
    'webhook-delivery',
    async (job) => {
      const data = job.data;
      await runAsOrganization(data.organizationId, async () => {
        const result = await deliverOnce(data);
        if (result.ok || !result.retryable) return;

        const next = data.attempt + 1;
        if (next > MAX_ATTEMPTS) {
          logger.warn('Webhook delivery exhausted its retries', {
            endpointId: data.endpointId,
            eventId: data.envelope.event.id,
          });
          return;
        }
        await enqueueWebhookDelivery(
          { ...data, attempt: next },
          WEBHOOK_RETRY_DELAYS_MS[data.attempt - 1],
        );
      });
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    logger.error('Webhook delivery job failed', { jobId: job?.id, error: err?.message });
  });

  logger.info('Webhook delivery worker started');
  return worker;
}

/** Housekeeping for the console: how many endpoints exist across all tenants. */
export async function countActiveEndpoints(): Promise<number> {
  return runAsPlatform('webhook-endpoint-count', () =>
    prisma.webhookEndpoint.count({ where: { isActive: true } }),
  );
}
