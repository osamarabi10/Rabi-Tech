import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { sendToContact } from './workflow-executor';
import {
  DEFAULT_ANSWER_ATTEMPTS,
  parseAnswer,
  type AnswerKind,
  type WorkflowConfig,
} from './workflow-schema';
import { workflowQueue, type WorkflowJob } from '../../workers/workflow.worker';

/**
 * Resume a workflow that was waiting for this contact to answer.
 *
 * Called from the inbound worker on every customer message, so it has to be
 * cheap when there is nothing waiting — which is almost always. One indexed
 * lookup on `(organizationId, contactId, status)` answers that, and returns
 * immediately.
 *
 * ## Why this is not a trigger
 *
 * A `MESSAGE_RECEIVED` trigger starts a *new* run. This continues an existing
 * one from the step after the question, carrying its execution log and its
 * depth. Modelling it as a trigger would lose both, and would let a workflow
 * answer its own question.
 */

/** The step that asked, read back from the definition rather than duplicated. */
function questionAt(config: WorkflowConfig, resumeAtStep: number) {
  // `currentStepIndex` is where the run resumes, so the question is the step
  // before it. Reading the definition instead of copying the config onto the
  // execution means an edited workflow cannot leave a run validating against a
  // question the author has since changed.
  const action = (config.actions || [])[resumeAtStep - 1];
  return action && action.type === 'ASK_QUESTION' ? action : null;
}

/**
 * Re-ask through the executor's own send, never a second one.
 *
 * `sendToContact` carries consent, session resolution, interpolation and
 * metering. A local copy would have to re-derive all four, and the first thing
 * it would miss is consent — nothing about "repeat the question" suggests
 * consent is involved, and it is: an opted-out contact must not be messaged by
 * a workflow, including one that is only repeating itself. That was the bug in
 * the first version of this file.
 */
async function reAsk(input: {
  organizationId: string;
  workflowId: string;
  executionId: string;
  contactId: string;
  conversationId: string | null;
  depth: number;
  body: string;
}): Promise<void> {
  await sendToContact(
    {
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      executionId: input.executionId,
      triggerType: 'ANSWER_RETRY',
      contactId: input.contactId,
      conversationId: input.conversationId,
      depth: input.depth,
      payload: {},
      emitted: [],
    },
    input.body,
  );
}

/**
 * Returns true when the message was consumed as an answer to a pending question.
 *
 * The caller keeps processing either way — an answer is still a real message
 * that belongs in the thread. This only decides whether a workflow moved.
 */
export async function resumeAwaitingWorkflows(input: {
  organizationId: string;
  contactId: string;
  body: string;
}): Promise<boolean> {
  const waiting = await prisma.workflowExecution.findMany({
    where: { contactId: input.contactId, status: 'AWAITING_REPLY' },
    select: {
      id: true, workflowId: true, currentStepIndex: true, depth: true,
      conversationId: true, awaitingUntil: true, awaitingAttempts: true,
    },
    // Oldest first: if two runs are somehow both waiting, the one that has been
    // waiting longest gets the answer. Arbitrary, but deterministic — and the
    // alternative, giving it to both, would write one reply into two fields.
    orderBy: { createdAt: 'asc' },
  });
  if (waiting.length === 0) return false;

  const execution = waiting[0];

  // Expired but not yet swept by its deadline job. Leave it alone: the job is
  // the single owner of what an unanswered question becomes, and racing it here
  // would decide twice.
  if (execution.awaitingUntil && execution.awaitingUntil.getTime() < Date.now()) return false;

  const workflow = await prisma.workflow.findUnique({
    where: { id: execution.workflowId },
    select: { isActive: true, configJson: true },
  });
  if (!workflow?.isActive) return false;

  const config = (workflow.configJson || {}) as unknown as WorkflowConfig;
  const question = questionAt(config, execution.currentStepIndex);
  if (!question) {
    // The step is no longer a question — the workflow was edited while this run
    // waited. Nothing sensible to store, so stop rather than guess.
    await prisma.workflowExecution.update({
      where: { id: execution.id },
      data: { status: 'FAILED', awaitingUntil: null, error: 'the question step was edited away while waiting' },
    });
    return false;
  }

  const parsed = parseAnswer((question.expects || 'text') as AnswerKind, input.body);

  if (!parsed.ok) {
    const maxAttempts = question.maxAttempts === undefined
      ? DEFAULT_ANSWER_ATTEMPTS
      : Number(question.maxAttempts);
    const attempts = execution.awaitingAttempts + 1;

    if (attempts >= maxAttempts) {
      /*
        Stop asking.

        A bot that keeps repeating a question it will not accept is the worst
        outcome here: the customer is trying to talk to a business and being
        answered by a loop. The run stops, an agent still has the message in
        their inbox, and a human can take it from there.
      */
      await prisma.workflowExecution.update({
        where: { id: execution.id },
        data: {
          status: 'FAILED',
          awaitingUntil: null,
          awaitingAttempts: attempts,
          error: `no usable answer after ${attempts} attempt(s)`,
        },
      });
      logger.info('Workflow question abandoned after repeated unusable answers', {
        executionId: execution.id,
        attempts,
      });
      return false;
    }

    await prisma.workflowExecution.update({
      where: { id: execution.id },
      data: { awaitingAttempts: attempts },
    });
    // Re-ask with the author's own wording when they wrote one. The generic
    // fallback is deliberately not "invalid input" — the customer did not fill
    // in a form, they answered a question.
    const retry = typeof question.invalidPrompt === 'string' && question.invalidPrompt.trim()
      ? question.invalidPrompt
      : String(question.prompt);
    await reAsk({
      organizationId: input.organizationId,
      workflowId: execution.workflowId,
      executionId: execution.id,
      contactId: input.contactId,
      conversationId: execution.conversationId,
      depth: execution.depth,
      body: retry,
    });
    return true;
  }

  /*
    The answer goes to a custom field, resolved by slug — never to a column name
    taken from the workflow definition.

    The first version of this wrote `{ [question.field]: value }` straight onto
    Contact. That is an injection with the workflow builder as its entry point:
    an author could name `organizationId` and move a contact between tenants, or
    `blockedAt` and silently unblock someone, or `marketingConsent` and undo an
    opt-out. None of it would look wrong in the builder.

    `UPDATE_CONTACT_FIELD` already had the answer — go through
    CustomFieldDefinition, which can only name fields this organization has
    defined — so this uses the identical path rather than a parallel one. A
    question whose field has been deleted skips rather than guessing, exactly as
    that action does.
  */
  const definition = await prisma.customFieldDefinition.findUnique({
    where: {
      organizationId_slug: {
        organizationId: input.organizationId,
        slug: String(question.field),
      },
    },
    select: { id: true },
  });
  if (!definition) {
    await prisma.workflowExecution.update({
      where: { id: execution.id },
      data: {
        status: 'FAILED',
        awaitingUntil: null,
        error: `the field "${String(question.field)}" no longer exists`,
      },
    });
    logger.warn('Workflow answer discarded: field no longer defined', {
      executionId: execution.id,
      field: String(question.field),
    });
    return false;
  }

  await prisma.customFieldValue.upsert({
    where: {
      organizationId_contactId_fieldDefinitionId: {
        organizationId: input.organizationId,
        contactId: input.contactId,
        fieldDefinitionId: definition.id,
      },
    },
    create: {
      organizationId: input.organizationId,
      contactId: input.contactId,
      fieldDefinitionId: definition.id,
      value: parsed.value,
    },
    update: { value: parsed.value },
  });

  /*
    RUNNING before the job is enqueued, not after.

    The deadline job checks status to decide whether the question went
    unanswered. Enqueueing first and updating second leaves a window in which a
    deadline firing would see AWAITING_REPLY and abandon a run that has just
    been answered.
  */
  await prisma.workflowExecution.update({
    where: { id: execution.id },
    data: { status: 'RUNNING', awaitingUntil: null },
  });

  await workflowQueue.add(
    'run',
    {
      organizationId: input.organizationId,
      workflowId: execution.workflowId,
      executionId: execution.id,
      fromStep: execution.currentStepIndex,
      depth: execution.depth,
      payload: { answer: parsed.value },
    } satisfies WorkflowJob,
    { jobId: `wf--${execution.id}--${execution.currentStepIndex}` },
  );

  logger.info('Workflow resumed by contact answer', {
    executionId: execution.id,
    field: question.field,
    expects: question.expects,
  });
  return true;
}
