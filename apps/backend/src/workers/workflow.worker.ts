import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { prisma } from '../prisma';
import { getTenantId, runAsOrganization } from '../lib/tenant-context';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import { collectTriggeredRuns, type TriggerEvent } from '../modules/workflows/workflow-dispatcher';
import { runWorkflowActions } from '../modules/workflows/workflow-executor';
import type { WorkflowConfig } from '../modules/workflows/workflow-schema';

/**
 * Workflow execution queue.
 *
 * One job per execution. A WAIT_DELAY re-enqueues the same execution with a
 * BullMQ delay and a `fromStep`, so a paused run costs nothing while it waits.
 */

export type WorkflowJob = {
  organizationId: string;
  workflowId: string;
  executionId: string;
  fromStep: number;
  depth: number;
  payload: Record<string, unknown>;
};

export const workflowQueue = new Queue('workflow-queue', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
});

let worker: Worker | null = null;

/** Enqueue every workflow this event triggers. Call inside the tenant scope. */
export async function dispatchWorkflowEvent(event: TriggerEvent): Promise<number> {
  if (process.env.DISABLE_WORKFLOW_WORKER === '1') return 0;
  const organizationId = getTenantId();
  try {
    const runs = await collectTriggeredRuns(event);
    for (const run of runs) {
      await workflowQueue.add(
        'run',
        {
          organizationId,
          workflowId: run.workflowId,
          executionId: run.executionId,
          fromStep: 0,
          depth: run.depth,
          payload: run.payload,
        } satisfies WorkflowJob,
        // `--` never `:` — BullMQ's own key separator, and colons here have
        // silently broken inbound processing and campaign sends before.
        { jobId: `wf--${run.executionId}--0` },
      );
    }
    return runs.length;
  } catch (error) {
    // A workflow failing to dispatch must never break the thing that triggered
    // it — an inbound customer message has to be processed either way.
    logger.error('Workflow dispatch failed', {
      triggerType: event.triggerType,
      error: String(error),
    });
    return 0;
  }
}

export function startWorkflowWorker(): Worker | null {
  if (process.env.DISABLE_WORKFLOW_WORKER === '1') return null;
  if (worker) return worker;

  worker = new Worker(
    'workflow-queue',
    async (job) => {
      const data = job.data as WorkflowJob;
      if (!data?.organizationId) {
        // Fail-closed: a job with no tenant cannot be run safely, and the
        // Prisma extension would throw anyway.
        throw new Error('Workflow job is missing organizationId');
      }

      return runAsOrganization(data.organizationId, async () => {
        const execution = await prisma.workflowExecution.findUnique({
          where: { id: data.executionId },
          select: { id: true, status: true, contactId: true, conversationId: true, depth: true },
        });
        if (!execution) return { skipped: 'execution missing' };
        if (execution.status === 'COMPLETED' || execution.status === 'FAILED') {
          return { skipped: `already ${execution.status}` };
        }

        const workflow = await prisma.workflow.findUnique({
          where: { id: data.workflowId },
          select: { isActive: true, configJson: true },
        });
        // Re-checked on resume, not only at dispatch: a workflow can be
        // deactivated or edited while an execution sits in a WAIT_DELAY, and
        // finishing a workflow the tenant has since switched off would be
        // acting against their most recent instruction.
        if (!workflow || !workflow.isActive) {
          await prisma.workflowExecution.update({
            where: { id: data.executionId },
            data: { status: 'SKIPPED', error: 'workflow inactive or deleted' },
          });
          return { skipped: 'workflow inactive' };
        }

        const config = (workflow.configJson || {}) as unknown as WorkflowConfig;
        const emitted: Array<{ type: 'TAG_ADDED' | 'TAG_REMOVED'; tag: string }> = [];
        const result = await runWorkflowActions(
          config,
          {
            organizationId: data.organizationId,
            workflowId: data.workflowId,
            executionId: data.executionId,
            contactId: execution.contactId,
            conversationId: execution.conversationId,
            depth: execution.depth,
            payload: data.payload || {},
            emitted,
          },
          data.fromStep,
        );

        // A workflow's own tag writes feed the tag triggers, one level deeper.
        // This is the case the depth cap exists for: ADD_TAG firing a TAG_ADDED
        // workflow that adds another tag, and so on.
        for (const event of emitted) {
          await dispatchWorkflowEvent({
            triggerType: event.type,
            contactId: execution.contactId,
            conversationId: execution.conversationId,
            payload: { tag: event.tag },
            depth: execution.depth + 1,
          });
        }

        if (result.status === 'WAITING' && result.resumeAtStep !== undefined) {
          await workflowQueue.add(
            'run',
            { ...data, fromStep: result.resumeAtStep } satisfies WorkflowJob,
            {
              jobId: `wf--${data.executionId}--${result.resumeAtStep}`,
              delay: result.delayMs,
            },
          );
        }

        return result;
      });
    },
    { connection: gatewayQueueConnection, concurrency: Number(process.env.WORKFLOW_CONCURRENCY || 4) },
  );

  worker.on('failed', (job, error) => {
    logger.error('Workflow job failed', {
      jobId: job?.id,
      workflowId: job?.data?.workflowId,
      error: error.message,
    });
  });

  logger.info('Workflow worker started');
  return worker;
}
