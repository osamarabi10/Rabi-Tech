import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { isWithinWorkingHours } from '../../utils/working-hours';
import { getSessionForTeam } from '../../utils/whatsapp-sessions';
import { OpenWAService } from '../whatsapp/openwa.service';
import { assertSafeWebhookUrl, BlockedUrlError } from './outbound-url';
import type { WorkflowAction, WorkflowCondition, WorkflowConfig } from './workflow-schema';

/**
 * The workflow executor.
 *
 * Runs inside the organization's tenant scope — every Prisma call here is
 * automatically org-scoped, and the composite FKs mean an execution can never
 * reference another tenant's row even if that were bypassed.
 *
 * Three rules that are not negotiable, each learned somewhere else in this
 * codebase:
 *
 * 1. **A workflow cannot outrun consent.** `SEND_MESSAGE` and `SEND_TEMPLATE`
 *    check `marketingConsent` and refuse an opted-out contact. Without this,
 *    "run a workflow" becomes the way to message people who said STOP — the
 *    exact liability M1 exists to prevent, wearing a different hat.
 * 2. **A workflow cannot outrun the plan.** Its sends go through the normal
 *    metered path, so they count against the tenant's quota and are refused at
 *    the ceiling. The `internal` bypass exists for platform probes, not for
 *    tenant automation.
 * 3. **A workflow cannot feed itself.** An `ADD_TAG` action can fire a
 *    `TAG_ADDED` trigger. Executions carry a depth, and the dispatcher refuses
 *    past `MAX_DEPTH`.
 */

export const MAX_DEPTH = 3;

/** Kept small on purpose: this is a debugging trail, not an event store. */
const MAX_LOG_ENTRIES = 50;

export type ExecutionContext = {
  organizationId: string;
  workflowId: string;
  executionId: string;
  contactId: string | null;
  conversationId: string | null;
  depth: number;
  /** Set by the trigger, available to actions for interpolation. */
  payload: Record<string, unknown>;
  /**
   * Events this run produced, for the caller to dispatch once it finishes.
   *
   * Collected rather than dispatched here so the executor stays free of the
   * queue — and so a workflow's own tag writes go back through the dispatcher
   * at depth + 1, where the loop guard can see them.
   */
  emitted: Array<{ type: 'TAG_ADDED' | 'TAG_REMOVED'; tag: string }>;
};

export type LogEntry = {
  step: number;
  action: string;
  outcome: 'ok' | 'skipped' | 'failed';
  detail?: string;
  at: string;
};

/** Signals the run should pause and resume later via a delayed job. */
export class WorkflowPaused extends Error {
  constructor(readonly resumeAtStep: number, readonly delayMs: number) {
    super('workflow paused');
    this.name = 'WorkflowPaused';
  }
}

function entry(step: number, action: string, outcome: LogEntry['outcome'], detail?: string): LogEntry {
  return { step, action, outcome, detail: detail?.slice(0, 300), at: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

async function evaluateCondition(
  condition: WorkflowCondition,
  context: ExecutionContext,
): Promise<boolean> {
  switch (condition.type) {
    case 'WITHIN_BUSINESS_HOURS': {
      const hours = await prisma.workingHours.findUnique({
        where: { organizationId: context.organizationId },
      });
      // No configured hours means always open — the same reading the
      // out-of-hours reply uses, so the two never disagree.
      if (!hours || !hours.enabled) return true;
      return isWithinWorkingHours(hours);
    }
    case 'CONTACT_HAS_TAG':
    case 'CONTACT_LACKS_TAG': {
      if (!context.contactId) return condition.type === 'CONTACT_LACKS_TAG';
      const tagged = await prisma.contactTag.findFirst({
        where: { contactId: context.contactId, tag: { name: condition.value } },
        select: { contactId: true },
      });
      return condition.type === 'CONTACT_HAS_TAG' ? Boolean(tagged) : !tagged;
    }
    case 'CONVERSATION_TEAM_IS': {
      if (!context.conversationId) return false;
      const conversation = await prisma.conversation.findUnique({
        where: { id: context.conversationId },
        select: { teamId: true },
      });
      return conversation?.teamId === condition.value;
    }
    case 'CONTACT_LIFECYCLE_IS': {
      if (!context.contactId) return false;
      const contact = await prisma.contact.findUnique({
        where: { id: context.contactId },
        select: { lifecycleStage: true },
      });
      return (contact?.lifecycleStage || '') === condition.value;
    }
    case 'CONTACT_FIELD_EQUALS': {
      if (!context.contactId || !condition.field) return false;
      const value = await prisma.customFieldValue.findFirst({
        where: { contactId: context.contactId, fieldDefinition: { slug: condition.field } },
        select: { value: true },
      });
      return (value?.value || '') === (condition.value || '');
    }
    default:
      return false;
  }
}

/** All conditions must hold. An empty list means "always". */
export async function conditionsHold(
  conditions: WorkflowCondition[] | undefined,
  context: ExecutionContext,
): Promise<boolean> {
  for (const condition of conditions || []) {
    if (!(await evaluateCondition(condition, context))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** `{{contactName}}`-style interpolation, same shape as message templates. */
function interpolate(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

async function sendToContact(context: ExecutionContext, body: string): Promise<string> {
  if (!context.contactId) return 'skipped: no contact';

  const contact = await prisma.contact.findUnique({
    where: { id: context.contactId },
    select: { phone: true, name: true, firstName: true, marketingConsent: true },
  });
  if (!contact) return 'skipped: contact not found';

  // Rule 1. A workflow is not an exemption from consent.
  if (contact.marketingConsent === 'OPTED_OUT') {
    return 'skipped: contact opted out';
  }

  const conversation = context.conversationId
    ? await prisma.conversation.findUnique({
        where: { id: context.conversationId },
        select: { teamId: true, sessionId: true },
      })
    : null;

  const session = conversation?.sessionId
    ? await prisma.whatsappSession.findUnique({ where: { id: conversation.sessionId } })
    : await getSessionForTeam(conversation?.teamId ?? null);
  if (!session) return 'skipped: no WhatsApp session';

  const text = interpolate(body, {
    contactName: contact.name || contact.firstName || '',
    firstName: contact.firstName || contact.name || '',
    phone: contact.phone,
    ...context.payload,
  });

  // Rule 2. No `internal` flag — this counts against the tenant's quota and is
  // refused at the ceiling, exactly like an agent's own message.
  await OpenWAService.sendText(session.sessionName, contact.phone, text);
  return 'sent';
}

async function runAction(
  action: WorkflowAction,
  context: ExecutionContext,
  stepIndex: number,
): Promise<LogEntry> {
  switch (action.type) {
    case 'WAIT_DELAY': {
      const minutes = Number(action.minutes);
      throw new WorkflowPaused(stepIndex + 1, minutes * 60_000);
    }

    case 'ASSIGN_TEAM': {
      if (!context.conversationId) return entry(stepIndex, action.type, 'skipped', 'no conversation');
      await prisma.conversation.update({
        where: { id: context.conversationId },
        data: { teamId: String(action.teamId) },
      });
      return entry(stepIndex, action.type, 'ok', String(action.teamId));
    }

    case 'ASSIGN_USER': {
      if (!context.conversationId) return entry(stepIndex, action.type, 'skipped', 'no conversation');
      await prisma.conversation.update({
        where: { id: context.conversationId },
        data: { assignedToId: String(action.userId) },
      });
      return entry(stepIndex, action.type, 'ok', String(action.userId));
    }

    case 'SEND_MESSAGE': {
      const outcome = await sendToContact(context, String(action.body));
      return entry(stepIndex, action.type, outcome === 'sent' ? 'ok' : 'skipped', outcome);
    }

    case 'SEND_TEMPLATE': {
      const template = await prisma.messageTemplate.findUnique({
        where: { id: String(action.templateId) },
        select: { body: true, isActive: true },
      });
      if (!template || !template.isActive) {
        return entry(stepIndex, action.type, 'skipped', 'template missing or inactive');
      }
      const outcome = await sendToContact(context, template.body);
      return entry(stepIndex, action.type, outcome === 'sent' ? 'ok' : 'skipped', outcome);
    }

    case 'ADD_TAG': {
      if (!context.contactId) return entry(stepIndex, action.type, 'skipped', 'no contact');
      const name = String(action.tag).trim();
      const tag = await prisma.tag.upsert({
        where: { organizationId_name: { organizationId: context.organizationId, name } },
        create: { organizationId: context.organizationId, name },
        update: {},
      });
      const { count } = await prisma.contactTag.createMany({
        data: [{ organizationId: context.organizationId, contactId: context.contactId, tagId: tag.id }],
        skipDuplicates: true,
      });
      // Only a real change emits. Re-tagging an already-tagged contact must not
      // wake every TAG_ADDED workflow in the organization.
      if (count > 0) context.emitted.push({ type: 'TAG_ADDED', tag: name });
      return entry(stepIndex, action.type, 'ok', name);
    }

    case 'REMOVE_TAG': {
      if (!context.contactId) return entry(stepIndex, action.type, 'skipped', 'no contact');
      const name = String(action.tag).trim();
      const { count } = await prisma.contactTag.deleteMany({
        where: { contactId: context.contactId, tag: { name } },
      });
      if (count > 0) context.emitted.push({ type: 'TAG_REMOVED', tag: name });
      return entry(stepIndex, action.type, 'ok', `${name} (${count})`);
    }

    case 'UPDATE_CONTACT_FIELD': {
      if (!context.contactId) return entry(stepIndex, action.type, 'skipped', 'no contact');
      const slug = String(action.field);
      const value = action.value === null || action.value === undefined ? null : String(action.value);
      const definition = await prisma.customFieldDefinition.findUnique({
        where: { organizationId_slug: { organizationId: context.organizationId, slug } },
        select: { id: true },
      });
      if (!definition) return entry(stepIndex, action.type, 'skipped', `unknown field ${slug}`);
      await prisma.customFieldValue.upsert({
        where: {
          organizationId_contactId_fieldDefinitionId: {
            organizationId: context.organizationId,
            contactId: context.contactId,
            fieldDefinitionId: definition.id,
          },
        },
        create: {
          organizationId: context.organizationId,
          contactId: context.contactId,
          fieldDefinitionId: definition.id,
          value,
        },
        update: { value },
      });
      return entry(stepIndex, action.type, 'ok', `${slug}=${value ?? ''}`);
    }

    case 'HTTP_WEBHOOK': {
      // Every guard lives in assertSafeWebhookUrl. See that file for why this is
      // the most dangerous action in the list.
      let target;
      try {
        target = await assertSafeWebhookUrl(String(action.url));
      } catch (error) {
        if (error instanceof BlockedUrlError) {
          return entry(stepIndex, action.type, 'failed', error.message);
        }
        throw error;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(target.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Host: target.hostHeader,
            'User-Agent': 'RabiTech-Workflow/1',
          },
          body: JSON.stringify({
            workflowId: context.workflowId,
            executionId: context.executionId,
            contactId: context.contactId,
            conversationId: context.conversationId,
            payload: context.payload,
          }),
          signal: controller.signal,
          // Never follow a redirect: a public URL that 302s to 127.0.0.1 would
          // walk straight past the check above.
          redirect: 'manual',
        });
        return entry(stepIndex, action.type, response.ok ? 'ok' : 'failed', `HTTP ${response.status}`);
      } catch (error) {
        return entry(stepIndex, action.type, 'failed', String((error as Error).message).slice(0, 200));
      } finally {
        clearTimeout(timeout);
      }
    }

    default:
      return entry(stepIndex, action.type, 'skipped', 'unsupported action');
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function appendLog(executionId: string, entries: LogEntry[]): Promise<void> {
  const existing = await prisma.workflowExecution.findUnique({
    where: { id: executionId },
    select: { executionLog: true },
  });
  const current = Array.isArray(existing?.executionLog) ? (existing!.executionLog as unknown as LogEntry[]) : [];
  const merged = [...current, ...entries].slice(-MAX_LOG_ENTRIES);
  await prisma.workflowExecution.update({
    where: { id: executionId },
    data: { executionLog: merged as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Run a workflow's actions from `fromStep`.
 *
 * Returns `'paused'` when a WAIT_DELAY was hit; the caller schedules the resume.
 */
export async function runWorkflowActions(
  config: WorkflowConfig,
  context: ExecutionContext,
  fromStep = 0,
): Promise<{ status: 'COMPLETED' | 'WAITING' | 'FAILED'; resumeAtStep?: number; delayMs?: number }> {
  const actions = config.actions || [];
  const entries: LogEntry[] = [];

  for (let index = fromStep; index < actions.length; index += 1) {
    try {
      const result = await runAction(actions[index], context, index);
      entries.push(result);
    } catch (error) {
      if (error instanceof WorkflowPaused) {
        entries.push(entry(index, 'WAIT_DELAY', 'ok', `${Math.round(error.delayMs / 60000)}m`));
        await appendLog(context.executionId, entries);
        await prisma.workflowExecution.update({
          where: { id: context.executionId },
          data: { status: 'WAITING', currentStepIndex: error.resumeAtStep },
        });
        return { status: 'WAITING', resumeAtStep: error.resumeAtStep, delayMs: error.delayMs };
      }

      // One failing action stops the run. Continuing would apply the second half
      // of an automation whose first half did not happen, which is worse than
      // stopping: a partly-applied workflow is very hard to reason about after
      // the fact.
      const message = String((error as Error).message || error).slice(0, 400);
      entries.push(entry(index, String(actions[index]?.type), 'failed', message));
      await appendLog(context.executionId, entries);
      await prisma.workflowExecution.update({
        where: { id: context.executionId },
        data: { status: 'FAILED', currentStepIndex: index, error: message },
      });
      logger.error('Workflow action failed', {
        workflowId: context.workflowId,
        executionId: context.executionId,
        step: index,
        error: message,
      });
      return { status: 'FAILED' };
    }
  }

  await appendLog(context.executionId, entries);
  await prisma.workflowExecution.update({
    where: { id: context.executionId },
    data: { status: 'COMPLETED', currentStepIndex: actions.length },
  });
  return { status: 'COMPLETED' };
}

/** Convenience for callers already inside a tenant scope. */
export function currentOrganizationId(): string {
  return getTenantId();
}
