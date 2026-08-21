import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';

/**
 * Webhook delivery logging.
 *
 * One table records both directions, because they are separate faults with
 * separate causes and an operator needs to tell them apart:
 *
 * - **OUTBOUND** — a workflow `HTTP_WEBHOOK` step calling a subscriber's
 *   endpoint. Fails when *their* server is down or rejecting.
 * - **INBOUND** — the gateway delivering a WhatsApp message to
 *   `/webhooks/openwa/:token`. Goes quiet when *we* stop receiving traffic,
 *   which is the outage that reaches customers first.
 *
 * ## What is deliberately not stored
 *
 * The full target URL never lands here. A webhook URL routinely carries a token
 * in its query string or credentials in userinfo, and a delivery log is exactly
 * the place those would sit in plaintext indefinitely — readable by anyone with
 * report access, long after the endpoint was rotated. Only the host is kept,
 * which is all the health view needs.
 *
 * Bodies are truncated here rather than at the database, so a misbehaving
 * endpoint returning a multi-megabyte error page cannot be stored verbatim once
 * per delivery.
 */

/** Bodies are for diagnosing a failure, not for replaying it. */
const MAX_BODY_CHARS = 2000;

/** Rows older than this are pruned by the analytics rollup worker. */
export const WEBHOOK_LOG_RETENTION_DAYS = Number(process.env.WEBHOOK_LOG_RETENTION_DAYS) || 14;

export type WebhookDirection = 'INBOUND' | 'OUTBOUND';

export type DeliveryRecord = {
  direction: WebhookDirection;
  webhookId: string;
  eventType: string;
  workflowId?: string | null;
  executionId?: string | null;
  targetUrl?: string | null;
  statusCode?: number | null;
  ok: boolean;
  errorMessage?: string | null;
  requestPayload?: unknown;
  responseBody?: string | null;
  durationMs: number;
};

/**
 * Stable identity for a configured endpoint.
 *
 * There is no webhook table to key against — a webhook is an action step inside
 * a workflow — so identity is the workflow plus the step's position. That is
 * what makes "this endpoint has failed 40 times" a question the health view can
 * answer, rather than 40 unrelated rows.
 *
 * `--` rather than `:` matches the convention the queues use, and keeps the
 * value safe to embed in a key elsewhere later.
 */
export function webhookIdentity(workflowId: string, stepIndex: number): string {
  return `wf--${workflowId}--step--${stepIndex}`;
}

/** Host only, and never a throw: logging must not break the delivery it logs. */
export function safeHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function truncate(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}…[truncated]` : value;
}

function serialisePayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  try {
    return truncate(typeof payload === 'string' ? payload : JSON.stringify(payload));
  } catch {
    // A circular or otherwise unserialisable payload is not worth failing over.
    return '[unserialisable]';
  }
}

/**
 * Record one delivery.
 *
 * Never throws and never rejects. This runs on the inbound message path and
 * inside workflow execution; a logging failure must not become a delivery
 * failure, and an operator noticing gaps in the log is a far smaller problem
 * than messages being dropped because the log table was unavailable.
 *
 * Must be called inside an organization scope. `organizationId` comes from
 * `getTenantId()` rather than being cast past the generated type: the tenancy
 * extension would inject it anyway, but spelling it out keeps the create input
 * honestly typed instead of silencing it.
 */
export async function recordDelivery(record: DeliveryRecord): Promise<void> {
  try {
    await prisma.webhookDeliveryLog.create({
      data: {
        organizationId: getTenantId(),
        direction: record.direction,
        webhookId: record.webhookId,
        eventType: record.eventType,
        workflowId: record.workflowId ?? null,
        executionId: record.executionId ?? null,
        targetHost: safeHost(record.targetUrl),
        statusCode: record.statusCode ?? null,
        ok: record.ok,
        errorMessage: truncate(record.errorMessage),
        requestPayload: serialisePayload(record.requestPayload),
        responseBody: truncate(record.responseBody),
        durationMs: Math.max(0, Math.round(record.durationMs)),
      },
    });
  } catch (err) {
    logger.warn('failed to record webhook delivery', {
      direction: record.direction,
      webhookId: record.webhookId,
      error: String(err),
    });
  }
}

/**
 * Delete rows past the retention window, across every tenant.
 *
 * Runs in platform scope: retention is a platform obligation, not a per-tenant
 * one, and sweeping per organization would issue one delete per tenant against
 * the largest table in the schema.
 *
 * Batched, because a single unbounded `DELETE` on a table this size takes a
 * long lock. Anything left over is removed on the next pass.
 */
export async function pruneWebhookLogs(
  retentionDays = WEBHOOK_LOG_RETENTION_DAYS,
  maxBatches = 20,
  batchSize = 5000,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600_000);
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const stale = await prisma.webhookDeliveryLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (stale.length === 0) break;

    const result = await prisma.webhookDeliveryLog.deleteMany({
      where: { id: { in: stale.map((row) => row.id) } },
    });
    deleted += result.count;
    if (stale.length < batchSize) break;
  }

  return deleted;
}
