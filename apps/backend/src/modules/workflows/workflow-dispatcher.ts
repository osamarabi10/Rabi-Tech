import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { MAX_DEPTH } from './workflow-executor';
import type { TriggerType, WorkflowConfig } from './workflow-schema';

/**
 * Turns an event into queued workflow runs.
 *
 * Called from inside the tenant scope of whatever produced the event (the
 * inbound worker, a tag write, an out-of-hours check), so every read here is
 * already organization-scoped.
 */

export type TriggerEvent = {
  triggerType: TriggerType;
  contactId?: string | null;
  conversationId?: string | null;
  /** Trigger-specific: `{ text }` for keywords, `{ tag }` for tag events. */
  payload?: Record<string, unknown>;
  /** Inherited when one workflow's action fires another workflow's trigger. */
  depth?: number;
};

/**
 * How recently the same workflow may re-run for the same contact.
 *
 * The depth counter stops a chain; this stops a *cycle* between two workflows
 * that each fire the other's trigger, where every individual run looks like
 * depth 1. Without both, two workflows can ping-pong forever.
 */
const REENTRY_WINDOW_MS = 60_000;

function matchesTrigger(
  event: TriggerEvent,
  triggerType: string,
  config: WorkflowConfig,
): boolean {
  if (triggerType !== event.triggerType) return false;

  if (triggerType === 'KEYWORD_MATCHED') {
    const keyword = String(config.trigger?.keyword || '').trim().toLowerCase();
    const text = String(event.payload?.text || '').toLowerCase();
    if (!keyword) return false;
    // Substring, not whole-message: a keyword trigger is meant to fire on
    // "I want to cancel my order", unlike the opt-out matcher which is
    // deliberately whole-message so "stop" inside a sentence is not a STOP.
    return text.includes(keyword);
  }

  if (triggerType === 'TAG_ADDED' || triggerType === 'TAG_REMOVED') {
    const tag = String(config.trigger?.tag || '').trim().toLowerCase();
    return Boolean(tag) && String(event.payload?.tag || '').toLowerCase() === tag;
  }

  return true;
}

/**
 * Find the workflows that should run, create their executions, and hand back
 * the jobs to enqueue.
 *
 * Deliberately does not enqueue: the caller owns the queue, which keeps this
 * module free of BullMQ and testable on its own.
 */
export async function collectTriggeredRuns(event: TriggerEvent): Promise<
  Array<{ workflowId: string; executionId: string; depth: number; payload: Record<string, unknown> }>
> {
  const organizationId = getTenantId();
  const depth = event.depth ?? 0;

  if (depth >= MAX_DEPTH) {
    logger.warn('Workflow chain stopped at maximum depth', {
      organizationId,
      triggerType: event.triggerType,
      depth,
    });
    return [];
  }

  const workflows = await prisma.workflow.findMany({
    where: { triggerType: event.triggerType, isActive: true },
    select: { id: true, triggerType: true, configJson: true },
  });
  if (!workflows.length) return [];

  const runs: Array<{ workflowId: string; executionId: string; depth: number; payload: Record<string, unknown> }> = [];
  const since = new Date(Date.now() - REENTRY_WINDOW_MS);

  for (const workflow of workflows) {
    const config = (workflow.configJson || {}) as unknown as WorkflowConfig;
    if (!matchesTrigger(event, workflow.triggerType, config)) continue;

    if (event.contactId) {
      const recent = await prisma.workflowExecution.findFirst({
        where: { workflowId: workflow.id, contactId: event.contactId, createdAt: { gte: since } },
        select: { id: true },
      });
      if (recent) {
        logger.warn('Workflow re-entry suppressed', {
          organizationId,
          workflowId: workflow.id,
          contactId: event.contactId,
        });
        continue;
      }
    }

    const execution = await prisma.workflowExecution.create({
      data: {
        organizationId,
        workflowId: workflow.id,
        contactId: event.contactId ?? null,
        conversationId: event.conversationId ?? null,
        status: 'RUNNING',
        depth,
      },
      select: { id: true },
    });

    runs.push({
      workflowId: workflow.id,
      executionId: execution.id,
      depth,
      payload: event.payload || {},
    });
  }

  return runs;
}
