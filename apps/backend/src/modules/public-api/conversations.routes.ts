import { currentWorkspaceId } from '../../lib/current-workspace';
import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { requireScope } from '../api-tokens/api-token.middleware';
import { serializeContact, CONTACT_INCLUDE } from './serialize';
import {
  closeConversation,
  ConversationLifecycleError,
  reopenConversation,
} from '../conversations/conversation-lifecycle.service';

/**
 * `/api/v1/conversations` — reading threads and their messages.
 *
 * Reading threads and their messages, and moving a thread through its
 * lifecycle. Sending lives in `messaging.routes.ts`, because it hangs off both
 * a conversation and a contact.
 *
 * ## What a conversation looks like from outside
 *
 * `displayId` is the number an agent reads on screen and quotes to a customer;
 * `id` is what the API takes. Both are published, because an integration that
 * raises a support ticket needs to name the thread in a way a human can find.
 *
 * The internal scheduling columns — `autoCloseAt`, `autoCloseEligible`,
 * `pendingMenuChoice`, `sessionId` — are not published. They describe how this
 * product runs its own queues, they change whenever that changes, and nothing
 * outside can act on them.
 */

const router = Router();

const MAX_LIMIT = 100;
/**
 * Messages cap lower than everything else, matching theirs.
 *
 * A page of messages carries full bodies and media metadata, so 100 of them is
 * an order of magnitude more payload than 100 contacts. Their split is 100
 * generally and 50 for messages, and it is the right one.
 */
const MAX_MESSAGE_LIMIT = 50;
const DEFAULT_LIMIT = 25;

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const;

function limitOf(value: unknown, max = MAX_LIMIT): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return Math.min(DEFAULT_LIMIT, max);
  return Math.min(Math.floor(parsed), max);
}

function fail(res: any, req: any, err: unknown, where: string) {
  logger.error(`public-api ${where} failed`, { error: (err as Error)?.message, requestId: req.id });
  return res.status(500).json({ error: 'server_error' });
}

const CONVERSATION_INCLUDE = {
  contact: { include: CONTACT_INCLUDE },
  assignee: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
} as const;

function serializeConversation(conversation: any, mask: boolean) {
  return {
    id: conversation.id,
    // The number on screen. An integration filing a ticket has to name the
    // thread in a way the agent reading it can find.
    displayId: conversation.displayId,
    status: conversation.status,
    contact: conversation.contact ? serializeContact(conversation.contact, mask) : null,
    assignee: conversation.assignee ? { id: conversation.assignee.id, name: conversation.assignee.name } : null,
    team: conversation.team ? { id: conversation.team.id, name: conversation.team.name } : null,
    labels: conversation.labels || [],
    archived: conversation.isArchived,
    // Derived rather than published raw: `snoozedUntil` in the past means "not
    // snoozed", and a caller comparing clocks would get that wrong half the time.
    snoozed: !!conversation.snoozedUntil && conversation.snoozedUntil.getTime() > Date.now(),
    snoozedUntil: conversation.snoozedUntil,
    openedAt: conversation.openedAt,
    lastMessageAt: conversation.lastMessageAt,
    firstResponseAt: conversation.firstResponseAt,
    resolvedAt: conversation.resolvedAt,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

function serializeMessage(message: any) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    status: message.status,
    body: message.body,
    mediaUrl: message.mediaUrl,
    mediaType: message.mediaType,
    mediaFileName: message.mediaFileName,
    // Published because it changes what the message *means*: an internal note
    // was never sent to the customer, and an integration that reads a thread as
    // a transcript must not quote one back to them.
    internal: message.isInternal,
    automated: message.isAuto,
    sentBy: message.sentBy ? { id: message.sentBy.id, name: message.sentBy.name } : null,
    failureReason: message.failureReason,
    timestamp: message.timestamp,
  };
}

/* ── conversations ────────────────────────────────────────────────────────── */

router.get('/', requireScope('conversations:read'), async (req, res) => {
  try {
    const limit = limitOf(req.query.limit);
    const cursorId = req.query.cursorId ? String(req.query.cursorId) : undefined;

    const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `status must be one of ${STATUSES.join(', ')}.`,
      });
    }

    const where: any = {
      ...(status ? { status: status as any } : {}),
      ...(req.query.contactId ? { contactId: String(req.query.contactId) } : {}),
      ...(req.query.assigneeId ? { assignedToId: String(req.query.assigneeId) } : {}),
      ...(req.query.includeArchived === 'true' ? {} : { isArchived: false }),
    };

    const rows = await prisma.conversation.findMany({
      where,
      include: CONVERSATION_INCLUDE,
      /*
        Ordered by activity, and tie-broken by id.

        `lastMessageAt` is null on a thread that has never had a message, and
        nulls sort last here — which is correct: a caller paging "most recent
        first" wants silence at the end. The id tie-break is what keeps cursor
        pagination from skipping or repeating rows when two threads share a
        timestamp, which happens constantly during an import.
      */
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: limit + 1,
    });

    const items = rows.slice(0, limit);
    const mask = req.apiToken!.maskContactDetails;
    return res.json({
      conversations: items.map((row) => serializeConversation(row, mask)),
      pagination: {
        cursorId: rows.length > limit ? items[items.length - 1]?.id ?? null : null,
        hasMore: rows.length > limit,
      },
    });
  } catch (err) { return fail(res, req, err, 'GET /conversations'); }
});

router.get('/:id', requireScope('conversations:read'), async (req, res) => {
  try {
    /*
      findFirst rather than findUnique, though both are safe.

      The extension scopes findUnique too — it merges `organizationId` into the
      where, and every model here carries a composite unique on
      `(id, organizationId)` for exactly that. So this is a style choice, not a
      security one, and an earlier comment here claimed otherwise: it said a
      unique lookup "would be a cross-tenant read if the extension were ever
      bypassed", which is equally true of findFirst and therefore argues nothing.

      findFirst is still preferred because it returns null for a row in another
      tenant rather than throwing on a missing compound key, which is the 404
      this handler wants.
    */
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      include: CONVERSATION_INCLUDE,
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }
    return res.json(serializeConversation(conversation, req.apiToken!.maskContactDetails));
  } catch (err) { return fail(res, req, err, 'GET /conversations/:id'); }
});

/**
 * The thread's messages, newest first.
 *
 * Requires **both** `conversations:read` and `messages:read`. The thread and its
 * contents are separate grants because they are separately sensitive: a
 * reporting integration that counts open threads per team has no business
 * reading what customers wrote in them.
 */
router.get('/:id/messages', requireScope('conversations:read'), requireScope('messages:read'), async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }

    const limit = limitOf(req.query.limit, MAX_MESSAGE_LIMIT);
    const cursorId = req.query.cursorId ? String(req.query.cursorId) : undefined;

    const where: any = { conversationId: conversation.id };
    // Internal notes are agent-to-agent and are excluded unless asked for. A
    // caller building a customer-facing transcript gets the transcript by
    // default rather than by remembering to filter.
    if (req.query.includeInternal !== 'true') where.isInternal = false;

    const rows = await prisma.message.findMany({
      where,
      include: { sentBy: { select: { id: true, name: true } } },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take: limit + 1,
    });

    const items = rows.slice(0, limit);
    return res.json({
      messages: items.map(serializeMessage),
      pagination: {
        cursorId: rows.length > limit ? items[items.length - 1]?.id ?? null : null,
        hasMore: rows.length > limit,
      },
    });
  } catch (err) { return fail(res, req, err, 'GET /conversations/:id/messages'); }
});

/**
 * `PATCH /conversations/:id` — status, assignee, labels.
 *
 * ## Closing goes through the lifecycle service, not a status column
 *
 * `closeConversation` writes an immutable `ConversationClosure` row, applies the
 * organization's closing-notes policy, cancels the auto-close job and optionally
 * sends the closing reply. Setting `status = 'RESOLVED'` directly would do none
 * of that, and the thread would be closed in the list while every report that
 * reads closures believed it was still open.
 *
 * The closing source is `API`, which the schema's enum already anticipated, so
 * closure reporting can separate threads an integration closed from ones an
 * agent did — a distinction a supervisor asks about the first time the numbers
 * look wrong.
 *
 * ## Reopening is not "set it back to OPEN"
 *
 * `reopenConversation` advances `openedAt`, which starts a new episode while
 * preserving the earlier closure rows. A bare status write would leave the
 * thread reporting a resolution that no longer describes it.
 */
router.patch('/:id', requireScope('conversations:write'), async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true, status: true },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }

    const status = req.body?.status !== undefined ? String(req.body.status).toUpperCase() : undefined;
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `status must be one of ${STATUSES.join(', ')}.`,
      });
    }

    // Assignee is validated rather than trusted. The composite foreign key would
    // refuse a user from another organization anyway, but a 400 naming the problem
    // beats a 500 carrying a constraint name to somebody's log.
    if (req.body?.assigneeId !== undefined && req.body.assigneeId !== null) {
      const assignee = await prisma.user.findFirst({
        where: { id: String(req.body.assigneeId) },
        select: { id: true },
      });
      if (!assignee) {
        return res.status(400).json({ error: 'invalid_request', message: 'No user in this workspace has that id.' });
      }
    }

    try {
      if (status === 'RESOLVED' && conversation.status !== 'RESOLVED') {
        await closeConversation({
          conversationId: conversation.id,
          source: 'API',
          categoryId: req.body?.closingCategoryId ?? null,
          summary: req.body?.closingSummary ?? null,
          // The organization's closing-notes policy applies to an integration the
          // same as to an agent. A caller that skips a required category is
          // told so, rather than quietly producing a closure the reports
          // cannot categorise.
          enforceManualPolicy: true,
        });
      } else if (status && status !== 'RESOLVED' && conversation.status === 'RESOLVED') {
        await reopenConversation(conversation.id);
      }
    } catch (err) {
      if (err instanceof ConversationLifecycleError) {
        return res.status(err.status).json({ error: err.code.toLowerCase(), message: err.message });
      }
      throw err;
    }

    const data: any = {};
    // A status that is neither of the two transitions above is a plain move
    // between OPEN and PENDING, which carries no lifecycle consequences.
    if (status && status !== 'RESOLVED' && conversation.status !== 'RESOLVED') data.status = status;
    if (req.body?.assigneeId !== undefined) data.assignedToId = req.body.assigneeId || null;
    if (Array.isArray(req.body?.labels)) {
      data.labels = [...new Set(req.body.labels.map((l: unknown) => String(l).trim()).filter(Boolean))].slice(0, 10);
    }
    if (Object.keys(data).length) {
      await prisma.conversation.update({ where: { id: conversation.id }, data });
    }

    const updated = await prisma.conversation.findFirst({
      where: { id: conversation.id },
      include: CONVERSATION_INCLUDE,
    });
    return res.json(serializeConversation(updated, req.apiToken!.maskContactDetails));
  } catch (err) { return fail(res, req, err, 'PATCH /conversations/:id'); }
});

/* ── comments ─────────────────────────────────────────────────────────────── */

/**
 * Internal comments on a thread.
 *
 * ## Why these exist when API-sent *notes* are refused
 *
 * `messaging.routes.ts` refuses `isInternal` outright, on the grounds that a
 * note is addressed to colleagues and a token has no name to sign it with — a
 * note from "nobody" is worse than no note. That objection is about
 * attribution, not about the capability, so this endpoint answers it directly:
 * **`authorId` is required.** The integration names which organization user the
 * comment is from, and it is validated as a real, active member.
 *
 * The result is a comment that reads in the inbox exactly like one a person
 * typed, because a person is on it. An integration that cannot name an author
 * has no business writing in the team's private margin.
 */
router.post('/:id/comments', requireScope('conversations:write'), async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }

    const text = String(req.body?.text ?? '').trim().slice(0, 4000);
    if (!text) {
      return res.status(400).json({ error: 'invalid_request', message: 'A comment needs text.' });
    }

    const authorId = String(req.body?.authorId ?? '').trim();
    if (!authorId) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'authorId is required — a comment is addressed to colleagues and needs a person on it. GET /users lists them.',
      });
    }
    const author = await prisma.user.findFirst({
      where: { id: authorId, isActive: true },
      select: { id: true },
    });
    if (!author) {
      return res.status(400).json({
        error: 'invalid_request',
        message: 'No active user in this workspace has that id.',
      });
    }

    /*
      A comment is a Message with `isInternal`, which is how the console models
      one too. Writing it directly rather than through sendOutboundMessage is
      correct: that function's whole job is the gateway, the send clock and the
      auto-close reschedule, and a comment touches none of them — it is never
      transmitted and must never restart a response timer.
    */
    const comment = await prisma.message.create({
      data: {
        workspaceId: await currentWorkspaceId(),
        organizationId: getTenantId(),
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        body: text,
        isInternal: true,
        status: 'SENT',
        sentById: author.id,
      },
      include: { sentBy: { select: { id: true, name: true } } },
    });

    // The agent watching the thread sees it appear, exactly as they would a
    // colleague's note. A comment nobody is shown is a comment nobody reads.
    try {
      getIO()
        .to(socketRoom.conversation(getTenantId(), conversation.id))
        .emit(SocketEvents.NEW_MESSAGE, { conversationId: conversation.id, message: comment });
    } catch { /* no socket server in a worker or a script */ }

    return res.status(201).json(serializeMessage(comment));
  } catch (err) { return fail(res, req, err, 'POST /conversations/:id/comments'); }
});

/** The thread's comments alone, without the customer-facing messages. */
router.get('/:id/comments', requireScope('conversations:read'), requireScope('messages:read'), async (req, res) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }

    const limit = limitOf(req.query.limit, MAX_MESSAGE_LIMIT);
    const comments = await prisma.message.findMany({
      where: { conversationId: conversation.id, isInternal: true },
      include: { sentBy: { select: { id: true, name: true } } },
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return res.json({ comments: comments.map(serializeMessage) });
  } catch (err) { return fail(res, req, err, 'GET /conversations/:id/comments'); }
});

export default router;
