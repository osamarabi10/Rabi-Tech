import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { requireScope } from '../api-tokens/api-token.middleware';
import { serializeContact, CONTACT_INCLUDE } from './serialize';

/**
 * `/api/v1/conversations` — reading threads and their messages.
 *
 * ## Read-only, for now, and that is a boundary rather than an omission
 *
 * Sending a message is not "a write to this resource". It goes through a
 * gateway, costs the subscriber money, counts against a quota, must respect
 * marketing consent, has to persist *before* it sends so a transport error
 * cannot lose what was written, and has to reach the agent's inbox live over a
 * socket. The console's reply route does all of that, and the correct way to
 * expose it is to lift that path into a service both callers share — not to
 * write a second one here that drifts from it. That is P1c's send half, and it
 * is deliberately a separate change.
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
const DEFAULT_LIMIT = 25;

const STATUSES = ['OPEN', 'PENDING', 'RESOLVED'] as const;

function limitOf(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
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
    // findFirst, not findUnique: the tenancy extension adds `organizationId` to
    // the filter, and a unique lookup by primary key alone would be a
    // cross-tenant read if the extension were ever bypassed.
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

    const limit = limitOf(req.query.limit);
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

export default router;
