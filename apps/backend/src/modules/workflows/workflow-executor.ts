import { Prisma } from '@prisma/client';
import { ChannelService } from '../channels/channel.service';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { isWithinWorkingHours } from '../../utils/working-hours';
import { getSessionForTeam } from '../../utils/whatsapp-sessions';
import { closeConversation } from '../conversations/conversation-lifecycle.service';
import { OpenWAService } from '../whatsapp/openwa.service';
import { assertSafeWebhookUrl, BlockedUrlError } from './outbound-url';
import { recordDelivery, webhookIdentity } from '../webhooks/webhook-log.service';
import { DEFAULT_ANSWER_TIMEOUT_MINUTES } from './workflow-schema';
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
  /**
   * What set this run going. Carried so a webhook delivery can be logged
   * against the event that caused it — "which trigger is hammering this
   * endpoint" is the first question asked of a failing webhook.
   */
  triggerType: string;
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

/**
 * Signals the run is waiting for the contact to answer a question.
 *
 * Distinct from `WorkflowPaused` because the two are woken by different things.
 * A delay is woken only by its own delayed job. This one is woken by an inbound
 * message, and its delayed job is a *deadline* rather than a resume — it fires
 * to give up, and no-ops if the answer already arrived.
 *
 * Sharing one signal would mean the timeout job could not tell which it was,
 * and would resume a still-unanswered question as though the customer had
 * replied — writing nothing to the field and continuing as if it had.
 */
export class WorkflowAwaitingReply extends Error {
  constructor(
    readonly resumeAtStep: number,
    readonly timeoutMs: number,
    readonly onTimeout: 'STOP' | 'CONTINUE',
  ) {
    super('workflow awaiting reply');
    this.name = 'WorkflowAwaitingReply';
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
/**
 * `{{name}}` and `{{name.field.sub}}`.
 *
 * Dotted paths exist for the HTTP node: capturing a response into a variable
 * is only useful if a later step can reach inside it. Without them a captured
 * object interpolates as "[object Object]", which looks like it worked.
 *
 * An unresolved placeholder is left as written rather than replaced with an
 * empty string — a message reading "your order  is ready" hides the mistake,
 * while one reading "your order {{order.id}} is ready" reports it.
 */
function interpolate(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => {
      if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
      return (acc as Record<string, unknown>)[key];
    }, vars);

    if (value === undefined || value === null) return match;
    if (typeof value === 'object') {
      // A whole object in a message body is almost never intended, but in a
      // JSON request body it is exactly right.
      try {
        return JSON.stringify(value);
      } catch {
        return match;
      }
    }
    return String(value);
  });
}

/**
 * Exported so the answer-resume path re-asks through the same send.
 *
 * A second implementation would have to re-derive consent, session resolution,
 * interpolation and metering — and the first thing it would miss is Rule 1,
 * because nothing about "re-ask the question" suggests consent is involved.
 * It is: an opted-out contact must not be messaged by a workflow, including by
 * one that is only repeating itself.
 */
export async function sendToContact(context: ExecutionContext, body: string): Promise<string> {
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
  await ChannelService.sendText(session.sessionName, contact.phone, text);
  return 'sent';
}

/**
 * One retry policy for outbound HTTP, and only for the failures worth retrying.
 *
 * A 4xx is the endpoint saying the request itself is wrong — repeating it
 * changes nothing and, on a non-idempotent POST, risks doing the same thing
 * twice. Only transport errors and 5xx/429 are retried.
 *
 * Two retries at 500ms and 1500ms. The whole run holds a queue worker, so the
 * ceiling is deliberately low: an endpoint that needs longer than a couple of
 * seconds to recover is down, and the run should say so.
 */
const RETRY_DELAYS_MS = [500, 1500];

async function fetchWithBackoff(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) return response;
    } catch (error) {
      lastError = error;
      // An abort is the caller giving up, not a flaky endpoint.
      if ((error as Error)?.name === 'AbortError') throw error;
      if (attempt === RETRY_DELAYS_MS.length) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
  }

  // Unreachable: the loop returns or throws on its final pass.
  throw lastError ?? new Error('request failed');
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

    case 'ASK_QUESTION': {
      /*
        Send the question, then stop and wait for the person to answer.

        The send is checked before pausing. A question the contact never
        received would otherwise leave the run waiting for an answer to
        something nobody was asked — silent for a day, then a timeout that
        reads like the customer ignored us. Failing to send is skipped instead,
        and the run carries on to whatever follows.
      */
      const outcome = await sendToContact(context, String(action.prompt));
      if (outcome !== 'sent') {
        return entry(stepIndex, action.type, 'skipped', `question not sent: ${outcome}`);
      }
      const timeoutMinutes = action.timeoutMinutes === undefined
        ? DEFAULT_ANSWER_TIMEOUT_MINUTES
        : Number(action.timeoutMinutes);
      throw new WorkflowAwaitingReply(
        stepIndex + 1,
        timeoutMinutes * 60_000,
        action.onTimeout === 'CONTINUE' ? 'CONTINUE' : 'STOP',
      );
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
        data: [{ organizationId: context.organizationId, contactId: context.contactId, tagId: tag.id, source: 'WORKFLOW' }],
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

    case 'CLOSE_CONVERSATION': {
      if (!context.conversationId) return entry(stepIndex, action.type, 'skipped', 'no conversation');

      // The same closing reply an agent’s resolve sends — the subscriber’s own
      // CONVERSATION_CLOSED template, not text invented here.
      await closeConversation({
        conversationId: context.conversationId,
        source: 'WORKFLOW',
        categoryId: typeof action.categoryId === 'string' ? action.categoryId : null,
        summary: typeof action.summary === 'string' ? action.summary : null,
        sendClosingReply: true,
      });

      // The inbox is watching. Without this the thread sits open on every
      // agent’s screen until they reload.
      // Deliberately no CSAT prompt, unlike a manual resolve. That survey asks
      // how an agent handled you; a thread closed by a rule had no handling to
      // rate, and surveying those fills the score with answers about nothing.
      return entry(stepIndex, action.type, 'ok', 'resolved');
    }

    case 'IF_ELSE': {
      const held = await conditionsHold(action.conditions, context);
      const branch = held ? action.then : action.else;
      const label = held ? 'then' : 'else';

      if (!Array.isArray(branch) || branch.length === 0) {
        // An empty side is a legitimate "do nothing in that case", not a fault.
        return entry(stepIndex, action.type, 'ok', `${label}: no actions`);
      }

      // Branch actions run inside the parent step. A WAIT_DELAY in here would
      // have to resume into a nested position the top-level `fromStep` cursor
      // cannot address, so it is refused at save rather than half-supported.
      const results: LogEntry[] = [];
      for (let i = 0; i < branch.length; i += 1) {
        results.push(await runAction(branch[i], context, stepIndex));
      }
      const failed = results.filter((r) => r.outcome === 'failed').length;
      return entry(
        stepIndex,
        action.type,
        failed ? 'failed' : 'ok',
        `${label}: ${results.length} action(s)${failed ? `, ${failed} failed` : ''}`,
      );
    }

    case 'HTTP_WEBHOOK': {
      // Every guard lives in assertSafeWebhookUrl. See that file for why this is
      // the most dangerous action in the list.
      const identity = webhookIdentity(context.workflowId, stepIndex);
      const startedAt = Date.now();
      let target;
      try {
        target = await assertSafeWebhookUrl(String(action.url));
      } catch (error) {
        if (error instanceof BlockedUrlError) {
          // A blocked URL is a delivery attempt that failed, and the most
          // important kind to have in the log: it means someone configured a
          // webhook pointing somewhere it must never reach.
          await recordDelivery({
            direction: 'OUTBOUND',
            webhookId: identity,
            eventType: context.triggerType,
            workflowId: context.workflowId,
            executionId: context.executionId,
            targetUrl: String(action.url),
            ok: false,
            errorMessage: error.message,
            durationMs: Date.now() - startedAt,
          });
          return entry(stepIndex, action.type, 'failed', error.message);
        }
        throw error;
      }

      const method = String(action.method || 'POST').toUpperCase();

      // Lifted out of the fetch call so the log records exactly what was sent,
      // rather than a second, separately-built approximation of it.
      //
      // A custom body is interpolated the same way message text is, so
      // `{{payload.text}}` and anything captured by an earlier step can be sent
      // on. Without one, the default envelope is used.
      const body = action.body
        ? interpolate(String(action.body), context.payload)
        : JSON.stringify({
            workflowId: context.workflowId,
            executionId: context.executionId,
            contactId: context.contactId,
            conversationId: context.conversationId,
            payload: context.payload,
          });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Host: target.hostHeader,
        'User-Agent': 'RabiTech-Workflow/1',
      };

      // Credentials go in the header and never into the log — `recordDelivery`
      // stores the host, the request body and the response, none of which
      // carry this.
      const auth = action.auth as { type?: string; token?: string; username?: string; password?: string } | undefined;
      if (auth?.type === 'bearer' && auth.token) {
        headers.Authorization = `Bearer ${auth.token}`;
      } else if (auth?.type === 'basic' && auth.username) {
        const encoded = Buffer.from(`${auth.username}:${auth.password ?? ''}`).toString('base64');
        headers.Authorization = `Basic ${encoded}`;
      }

      // GET and DELETE carry no body: some servers reject the request outright
      // when one arrives, which would look like an endpoint fault rather than a
      // request we built wrong.
      const sendsBody = method !== 'GET' && method !== 'DELETE';

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchWithBackoff(
          target.url,
          {
            method,
            headers,
            ...(sendsBody ? { body } : {}),
            signal: controller.signal,
            // Never follow a redirect: a public URL that 302s to 127.0.0.1 would
            // walk straight past the check above.
            redirect: 'manual' as const,
          },
        );

        // Read the body before deciding the outcome. It is capped by the log
        // service, and it is usually the only clue why an endpoint rejected a
        // delivery — a bare status code explains nothing.
        const responseBody = await response.text().catch(() => '');

        await recordDelivery({
          direction: 'OUTBOUND',
          webhookId: identity,
          eventType: context.triggerType,
          workflowId: context.workflowId,
          executionId: context.executionId,
          targetUrl: String(action.url),
          statusCode: response.status,
          ok: response.ok,
          requestPayload: body,
          responseBody,
          durationMs: Date.now() - startedAt,
        });

        // Response → variable. Later steps address it as `{{name.field}}`,
        // which is what turns a webhook from a notification into a lookup.
        if (response.ok && typeof action.captureAs === 'string' && action.captureAs) {
          try {
            context.payload[action.captureAs] = JSON.parse(responseBody);
          } catch {
            // Not JSON: keep the text rather than dropping the capture, so a
            // plain-text endpoint is still usable.
            context.payload[action.captureAs] = responseBody;
          }
        }

        return entry(stepIndex, action.type, response.ok ? 'ok' : 'failed', `HTTP ${response.status}`);
      } catch (error) {
        // A transport error carries no status code at all, and is still a failure.
        await recordDelivery({
          direction: 'OUTBOUND',
          webhookId: identity,
          eventType: context.triggerType,
          workflowId: context.workflowId,
          executionId: context.executionId,
          targetUrl: String(action.url),
          ok: false,
          errorMessage: String((error as Error).message),
          requestPayload: body,
          durationMs: Date.now() - startedAt,
        });
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
 * Returns `WAITING` when a `WAIT_DELAY` was hit — the caller schedules the
 * resume — and `AWAITING_REPLY` when an `ASK_QUESTION` is waiting on the
 * contact. Both hand back a `delayMs`, but they mean opposite things: for
 * `WAITING` it is when to continue, for `AWAITING_REPLY` it is when to give up.
 */
export async function runWorkflowActions(
  config: WorkflowConfig,
  context: ExecutionContext,
  fromStep = 0,
): Promise<{
  status: 'COMPLETED' | 'WAITING' | 'AWAITING_REPLY' | 'FAILED';
  resumeAtStep?: number;
  delayMs?: number;
  onTimeout?: 'STOP' | 'CONTINUE';
}> {
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

      if (error instanceof WorkflowAwaitingReply) {
        const until = new Date(Date.now() + error.timeoutMs);
        entries.push(entry(index, 'ASK_QUESTION', 'ok', `awaiting reply until ${until.toISOString()}`));
        await appendLog(context.executionId, entries);
        await prisma.workflowExecution.update({
          where: { id: context.executionId },
          data: {
            status: 'AWAITING_REPLY',
            currentStepIndex: error.resumeAtStep,
            awaitingUntil: until,
            // Reset per question, not per run: two questions in one workflow
            // each get their own allowance, and a contact who fumbled the first
            // does not arrive at the second with none left.
            awaitingAttempts: 0,
          },
        });
        return {
          status: 'AWAITING_REPLY',
          resumeAtStep: error.resumeAtStep,
          delayMs: error.timeoutMs,
          onTimeout: error.onTimeout,
        };
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
