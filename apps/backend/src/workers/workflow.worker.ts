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
  /** Only on an `answer-timeout` job: what the ASK_QUESTION step asked for. */
  onTimeout?: 'STOP' | 'CONTINUE';
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
          select: { id: true, status: true, contactId: true, conversationId: true, depth: true, awaitingUntil: true },
        });
        if (!execution) return { skipped: 'execution missing' };
        if (execution.status === 'COMPLETED' || execution.status === 'FAILED') {
          return { skipped: `already ${execution.status}` };
        }

        /*
          A question's deadline reached the front of the queue.

          It is a no-op unless the run is *still* waiting: the ordinary outcome
          is that the contact answered hours ago, the run moved on, and this job
          is a leftover. Checking `awaitingUntil` as well as status matters
          because a workflow with two questions passes through AWAITING_REPLY
          twice — without the timestamp this job would abandon the *second*
          question using the first one's deadline.
        */
        if (job.name === 'answer-timeout') {
          if (execution.status !== 'AWAITING_REPLY') {
            return { skipped: 'answered before the deadline' };
          }
          if (execution.awaitingUntil && execution.awaitingUntil.getTime() > Date.now() + 1_000) {
            return { skipped: 'a later question is waiting; this deadline is stale' };
          }
          if (data.onTimeout !== 'CONTINUE') {
            await prisma.workflowExecution.update({
              where: { id: data.executionId },
              data: { status: 'TIMED_OUT', awaitingUntil: null, error: 'the contact did not answer in time' },
            });
            logger.info('Workflow question timed out', {
              executionId: data.executionId,
              workflowId: data.workflowId,
            });
            return { skipped: 'no answer, run stopped' };
          }
          // CONTINUE: fall through and run the remaining steps with the field
          // left unset, which the author opted into and can branch on.
          await prisma.workflowExecution.update({
            where: { id: data.executionId },
            data: { status: 'RUNNING', awaitingUntil: null },
          });
        } else if (execution.status === 'AWAITING_REPLY') {
          // An ordinary run job for a waiting execution is a duplicate — the
          // resume path sets RUNNING before enqueuing. Continuing here would
          // skip the question and carry on as though it had been answered.
          return { skipped: 'awaiting a reply' };
        }

        const workflow = await prisma.workflow.findUnique({
          where: { id: data.workflowId },
          select: { isActive: true, configJson: true, triggerType: true },
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
            triggerType: workflow.triggerType,
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

        /*
          A question's deadline, scheduled the same way a delay is.

          It is not a resume. When it fires, the contact has not answered, and
          the job's whole purpose is to stop waiting. Reusing the delayed-job
          mechanism means an unanswered question costs nothing while it waits —
          no sweep, no polling — which is the same property WAIT_DELAY has.

          The job id carries `timeout` so it cannot collide with the resume job
          the inbound path enqueues for the same step. Two jobs sharing an id
          means BullMQ keeps one, and which one it keeps decides whether the
          customer's answer is processed or discarded.
        */
        if (result.status === 'AWAITING_REPLY' && result.resumeAtStep !== undefined) {
          await workflowQueue.add(
            'answer-timeout',
            { ...data, fromStep: result.resumeAtStep, onTimeout: result.onTimeout } satisfies WorkflowJob,
            {
              jobId: `wf--${data.executionId}--timeout--${result.resumeAtStep}`,
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
