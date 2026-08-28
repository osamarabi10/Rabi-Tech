import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { OpenWAService } from '../whatsapp/openwa.service';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { getOrCreateActiveConversation } from '../../utils/conversation-session';
import { normalizePhoneInput } from '../../utils/phone';
import { sendStartWelcome } from '../../utils/welcome';
import { getSessionForTeam } from '../../utils/whatsapp-sessions';
import { validateBody, createConversationSchema, resolveConversationSchema } from '../../lib/validation';
import logger from '../../lib/logger';
import { stampFirstResponse } from '../analytics/response-time';
import { auditConversation } from '../../lib/audit';
import { requirePermission, requireSupervisor } from '../../middleware/rbac.middleware';
import { sendCsatPrompt } from '../../utils/client-feedback';
import { notifyAssigned, notifyMentioned, notifyResolved } from '../../utils/notification-service';
import { isQuotaExceededError, quotaErrorResponse } from '../usage/entitlements';
import { describeSendFailure } from '../../utils/send-failure';
import { signMediaUrl } from '../../utils/media-url';
import { requireTeamId } from '../../utils/teams';
import { conversationAccessWhere, maskConversationContacts } from '../../lib/user-access';
import { renderDynamicVariables } from '../../utils/template';
import { gatewayReachableAssetUrl } from '../snippets/snippet-storage';
import {
  closeConversation,
  ConversationLifecycleError,
  isConversationStatus,
  markSuccessfulHumanOutbound,
  reopenConversation,
  rescheduleConversationAutoClose,
} from './conversation-lifecycle.service';

const router = Router();
router.use(verifyToken);

// Apply the same visibility gate to every read and mutation carrying a
// conversation id. Inaccessible records answer 404 so their existence is not
// disclosed through direct API calls.
router.param('id', async (req, res, next, id) => {
  try {
    const conversation = await prisma.conversation.findFirst({
      where: { id, ...conversationAccessWhere(req.user!) },
      select: { id: true },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    next();
  } catch {
    return res.status(404).json({ error: 'Conversation not found' });
  }
});

// POST /api/conversations/start — open chat by phone number
router.post('/start', requirePermission('conversation:create'), validateBody(createConversationSchema), async (req, res) => {
  try {
    const { phone: rawPhone, name, message, teamId } = (req as any).validated;

    const phone = rawPhone ? normalizePhoneInput(rawPhone) : null;
    if (!phone) {
      logger.warn('Invalid phone normalized', { rawPhone, requestId: (req as any).id });
      return res.status(400).json({ error: 'رقم غير صالح — استخدم 0501234567 أو 972501234567' });
    }

    const user = req.user!;
    const targetTeamId =
      user.role === 'ADMIN'
        ? await requireTeamId({ teamId })
        : user.primaryTeamId || await requireTeamId({ teamId: user.teamIds?.[0] });

    const session = await getSessionForTeam(targetTeamId);
    if (!session?.isActive) {
      return res.status(400).json({ error: 'جلسة واتساب غير متصلة لهذا القسم' });
    }

    const organizationId = req.user!.organizationId;
    const contact = await prisma.contact.upsert({
      where: {
        organizationId_phone: {
          organizationId,
          phone,
        },
      },
      create: {
        organizationId,
        phone,
        ...(name?.trim() ? { name: name.trim() } : {}),
      },
      update: { ...(name?.trim() ? { name: name.trim() } : {}) },
    });

    const { conversation, isNewSession } = await getOrCreateActiveConversation(
      contact.id,
      session.id,
      session.teamId
    );

    const trimmedMsg = message?.trim();
    if (trimmedMsg) {
      // Persist first, then send — a provider error must never discard the record.
      const created = await prisma.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          body: trimmedMsg,
          sentById: user.id,
          status: 'PENDING',
        },
      });
      try {
        await OpenWAService.sendText(session.sessionName, phone, trimmedMsg);
        await prisma.message.update({ where: { id: created.id }, data: { status: 'SENT' } });
        await markSuccessfulHumanOutbound(conversation.id, created.timestamp);
      } catch (openwaErr) {
        logger.error('OpenWA send failed (new conversation)', { error: String(openwaErr), messageId: created.id, requestId: (req as any).id });
        await prisma.message.update({ where: { id: created.id }, data: { status: 'FAILED' } });
      }
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    } else {
      const priorOutbound = await prisma.message.count({
        where: { conversationId: conversation.id, direction: 'OUTBOUND' },
      });
      if (isNewSession || priorOutbound === 0) {
        await sendStartWelcome({
          sessionName: session.sessionName,
          phone,
          conversationId: conversation.id,
          sentById: user.id,
        });
      }
    }

    const full = await prisma.conversation.findUnique({
      where: { id: conversation.id },
      include: {
        contact: true,
        session: true,
        messages: { orderBy: { timestamp: 'desc' }, take: 1 },
        _count: { select: { messages: { where: { direction: 'INBOUND', isRead: false } } } },
      },
    });

    const teamRoom = socketRoom.team(req.user!.organizationId, conversation.teamId || targetTeamId);
    getIO().to(teamRoom).emit(
      isNewSession ? SocketEvents.NEW_CONVERSATION : SocketEvents.UNREAD_UPDATE,
      { conversationId: conversation.id }
    );

    // Audit log
    if (isNewSession) {
      await auditConversation(req.user!.id, conversation.id, 'opened', req.ip, req.get('user-agent'));
    }

    res.json(user.maskPhoneAndEmail ? maskConversationContacts(full) : full);
  } catch (err) {
    logger.error('start conversation failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    if (isQuotaExceededError(err)) return res.status(err.status).json(quotaErrorResponse(err));
    res.status(500).json({ error: 'فشل فتح المحادثة — تحقق من اتصال واتساب', requestId: (req as any).id });
  }
});

// GET /api/conversations
router.get('/', async (req, res) => {
  try {
    const { teamId, status, search, activeOnly } = req.query;
    const user = req.user!;

    const hideResolved = activeOnly !== 'false' && !status;

    const teamFilter =
      user.role === 'ADMIN'
        ? (teamId ? { teamId: teamId as string } : {})
        : (user.teamIds?.length ? { teamId: { in: user.teamIds } } : {});

    const convs = await prisma.conversation.findMany({
      where: {
        isArchived: false,
        ...conversationAccessWhere(user),
        ...(hideResolved ? { status: { not: 'RESOLVED' } } : {}),
        ...(status ? { status: status as any } : {}),
        ...teamFilter,
        ...(search ? {
          AND: [
            { contact: { isArchived: false } },
            {
              OR: [
                { contact: { name: { contains: search as string, mode: 'insensitive' } } },
                ...(!user.maskPhoneAndEmail ? [{ contact: { phone: { contains: search as string } } }] : []),
                { messages: { some: { body: { contains: search as string, mode: 'insensitive' } } } },
              ],
            },
          ],
        } : {
          contact: {
            isArchived: false,
          },
        }),
      },
      include: {
        contact: true,
        session: true,
        team: { select: { id: true, name: true, slug: true, color: true } },
        assignee: { select: { id: true, name: true } },
        messages: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
        _count: {
          select: {
            messages: { where: { direction: 'INBOUND', isRead: false } },
          },
        },
      },
      orderBy: { lastMessageAt: 'desc' },
    });

    res.json(user.maskPhoneAndEmail ? maskConversationContacts(convs) : convs);
  } catch (err) {
    logger.error('conversations list failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    res.status(500).json({ error: 'فشل جلب المحادثات', requestId: (req as any).id });
  }
});


/**
 * GET /api/conversations/:id/activity
 *
 * What happened to this conversation, other than the messages themselves.
 *
 * `AuditLog` rows have been written since the conversation module was built,
 * and nothing has ever read them — the Activity tab is the first consumer. The
 * rows are the record of who did what: opened, assigned, resolved, reopened.
 *
 * Automated events are merged in from the messages themselves. An agent asking
 * "what happened here" means the whole story, and half of it is the auto-replies
 * and workflow sends that no human triggered. Splitting those into a separate
 * surface would make the tab answer a narrower question than the one being
 * asked.
 */
router.get('/:id/activity', async (req, res) => {
  try {
    // Existence check first: without it a caller learns nothing from an empty
    // list, and cannot tell a quiet conversation from one in another tenant.
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      select: { id: true, createdAt: true },
    });
    if (!conversation) return res.status(404).json({ error: 'محادثة غير موجودة' });

    const [audits, automated, closures] = await Promise.all([
      prisma.auditLog.findMany({
        where: { resource: 'conversation', resourceId: req.params.id },
        select: {
          id: true,
          action: true,
          description: true,
          timestamp: true,
          user: { select: { id: true, name: true } },
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
      }),
      prisma.message.findMany({
        where: { conversationId: req.params.id, isAuto: true },
        select: { id: true, autoType: true, timestamp: true, body: true },
        orderBy: { timestamp: 'desc' },
        take: 50,
      }),
      prisma.conversationClosure.findMany({
        where: { conversationId: req.params.id },
        orderBy: { closedAt: 'desc' },
        take: 100,
      }),
    ]);

    const events = [
      ...audits
        .filter((row) => !row.action.startsWith('conversation.closed.'))
        .map((row) => ({
          id: row.id,
          kind: 'audit' as const,
          action: row.action.replace(/^conversation\./, ''),
          actorName: row.user?.name ?? null,
          detail: row.description ?? null,
          at: row.timestamp,
        })),
      ...closures.map((row) => ({
        id: row.id,
        kind: 'closure' as const,
        action: 'closed',
        actorName: row.closedByName,
        detail: [row.source, row.categoryName, row.summary].filter(Boolean).join(' · ') || null,
        at: row.closedAt,
      })),
      ...automated.map((row) => ({
        id: row.id,
        kind: 'automated' as const,
        action: row.autoType || 'auto_reply',
        // Null actor is the point: nobody did this, the system did.
        actorName: null,
        detail: row.body ? row.body.slice(0, 140) : null,
        at: row.timestamp,
      })),
      {
        id: `created-${conversation.id}`,
        kind: 'audit' as const,
        action: 'created',
        actorName: null,
        detail: null,
        at: conversation.createdAt,
      },
    ].sort((a, b) => b.at.getTime() - a.at.getTime());

    res.json({ events });
  } catch (err) {
    logger.error('conversation activity failed', {
      error: String(err),
      conversationId: req.params.id,
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب النشاط', requestId: (req as any).id });
  }
});
// GET /api/conversations/:id/messages?before=<msgId>&limit=<n>
// Returns up to `limit` messages (default 60, max 100), newest-first when using cursor,
// then reversed to ASC for the client. Supports cursor-based pagination via `before` msgId.
router.get('/:id/messages', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 60, 100);
    const before = req.query.before as string | undefined;
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await prisma.message.findMany({
      where: {
        conversationId: req.params.id,
        ...(before ? { timestamp: { lt: (await prisma.message.findUnique({ where: { id: before }, select: { timestamp: true } }))?.timestamp ?? new Date() } } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: limit,
      include: { sentBy: { select: { id: true, name: true } } },
    });

    // Reverse to chronological order for the client
    messages.reverse();

    // Signed here rather than stored: the signature expires, and one kept in
    // the database would be permanently valid to anyone who copied it.
    const signed = messages.map((message) => ({
      ...message,
      mediaUrl: signMediaUrl(message.mediaUrl, req.user!.organizationId),
    }));

    // Mark inbound as read (only on first page — no `before` cursor)
    if (!before) {
      await prisma.message.updateMany({
        where: { conversationId: req.params.id, direction: 'INBOUND', isRead: false },
        data: { isRead: true },
      });
    }

    res.json({
      messages: signed,
      hasMore: messages.length === limit,
      oldestId: messages[0]?.id ?? null,
    });
  } catch (err) {
    logger.error('messages fetch failed', { error: String(err), requestId: (req as any).id, conversationId: req.params.id });
    res.status(500).json({ error: 'فشل جلب الرسائل', requestId: (req as any).id });
  }
});

// POST /api/conversations/:id/reply (agents can send)
router.post('/:id/reply', requirePermission('conversation:create'), async (req, res) => {
  try {
    const { body, mediaUrl, mediaType, mediaFileName, isInternal } = req.body;
    // Ids, not parsed names: two agents can share a display name, and "@ahmad"
    // written in prose addresses nobody. The composer sends who it resolved.
    const mentionedUserIds: string[] = Array.isArray(req.body?.mentionedUserIds)
      ? req.body.mentionedUserIds.filter((id: unknown) => typeof id === 'string').slice(0, 20)
      : [];

    if (!body?.trim() && !mediaUrl) {
      return res.status(400).json({ error: 'الرسالة لا يمكن أن تكون فارغة' });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      include: {
        contact: {
          include: {
            customFieldValues: {
              include: { fieldDefinition: { select: { slug: true } } },
            },
          },
        },
        session: true,
        assignee: { select: { id: true, name: true } },
      },
    });
    if (!conv) {
      logger.warn('conversation not found', { conversationId: req.params.id, requestId: (req as any).id });
      return res.status(404).json({ error: 'محادثة غير موجودة' });
    }

    // Persist FIRST, then send. Previously the OpenWA call ran before message.create,
    // so a transport error (timeout/reset) AFTER successful delivery returned 503 and
    // discarded the message: the customer received it, the agent saw nothing, and
    // re-sending duplicated it. Never lose a message to a provider error again.
    const timezone = body?.includes('$system.')
      ? (await prisma.organizationConfig.findUnique({ where: { organizationId: req.user!.organizationId }, select: { timezone: true } }))?.timezone
      : undefined;
    const renderedBody = renderDynamicVariables(String(body || '').trim(), {
      contact: {
        ...conv.contact,
        customFields: Object.fromEntries(conv.contact.customFieldValues.map((entry) => [entry.fieldDefinition.slug, entry.value])),
      },
      assignee: conv.assignee,
      timezone,
    });

    const msg = await prisma.message.create({
      data: {
        organizationId: req.user!.organizationId,
        conversationId: conv.id,
        direction: 'OUTBOUND',
        body: renderedBody || null,
        mediaUrl: isInternal ? null : mediaUrl,
        mediaType: isInternal ? null : mediaType,
        mediaFileName: isInternal ? null : mediaFileName,
        sentById: req.user!.id,
        status: isInternal ? 'SENT' : 'PENDING',
        isInternal: !!isInternal,
      },
    });

    // An internal note is not a response to the customer, so it must not stop
    // the response clock. Fire-and-forget: reporting metadata never delays a send.
    if (!isInternal) {
      stampFirstResponse(conv.id, msg.timestamp).catch(() => {});
    }

    // Mentions only exist on internal notes. A customer-facing reply carrying
    // ids would be someone poking the API, and notifying on it would let a
    // WhatsApp message ping agents who were never named to the customer.
    if (isInternal && mentionedUserIds.length > 0) {
      notifyMentioned(conv.id, mentionedUserIds, req.user!.id, req.user!.name).catch(() => {});
    }

    let sendError: unknown = null;
    if (!isInternal) {
      try {
        if (mediaUrl) {
          await OpenWAService.sendMedia(
            conv.session.sessionName,
            conv.contact.phone,
            gatewayReachableAssetUrl(mediaUrl),
            renderedBody || undefined,
            { mediaType, fileName: mediaFileName },
          );
        } else {
          await OpenWAService.sendText(conv.session.sessionName, conv.contact.phone, renderedBody);
        }
        await prisma.message.update({ where: { id: msg.id }, data: { status: 'SENT' } });
        msg.status = 'SENT';
        await markSuccessfulHumanOutbound(conv.id, msg.timestamp);
      } catch (openwaErr) {
        sendError = openwaErr;
        const failure = describeSendFailure(openwaErr);
        logger.error('OpenWA send failed', { error: String(openwaErr), code: failure.code, messageId: msg.id, sessionName: conv.session.sessionName, requestId: (req as any).id });
        await prisma.message.update({
          where: { id: msg.id },
          data: { status: 'FAILED', failureReason: failure.reason },
        });
        msg.status = 'FAILED';
        msg.failureReason = failure.reason;
      }
    }

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() },
    });

    // Audit log
    await auditConversation(req.user!.id, conv.id, 'opened', req.ip, req.get('user-agent'));

    getIO().to(socketRoom.conversation(req.user!.organizationId, conv.id)).emit(SocketEvents.NEW_MESSAGE, { conversationId: conv.id, message: msg });

    // Always return the persisted message so the thread renders it. A failed send is
    // surfaced via status === 'FAILED' + sendError, never by discarding the record.
    if (sendError) {
      if (isQuotaExceededError(sendError)) {
        return res.status((sendError as any).status).json({ ...quotaErrorResponse(sendError as any), message: msg });
      }
      return res.json({ ...msg, sendError: describeSendFailure(sendError).reason });
    }
    res.json(msg);
  } catch (err) {
    logger.error('reply send failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    res.status(500).json({ error: 'فشل إرسال الرسالة', requestId: (req as any).id });
  }
});

/**
 * POST /api/conversations/:id/messages/:messageId/retry
 *
 * Re-attempt one failed outbound send. The message row already exists — the
 * reply route persists before it sends, precisely so a transport error never
 * loses what the agent wrote — so a retry updates that row rather than
 * creating a second one. Retrying is not re-sending: a duplicate would reach
 * the customer twice on any failure that happened after delivery.
 */
router.post('/:id/messages/:messageId/retry', requirePermission('conversation:create'), async (req, res) => {
  try {
    const message = await prisma.message.findUnique({
      where: { id: req.params.messageId },
      include: { conversation: { include: { contact: true, session: true } } },
    });

    // The conversation is checked as well as the id: a message id from
    // another thread would otherwise be retried through this thread's route.
    if (!message || message.conversationId !== req.params.id) {
      return res.status(404).json({ error: 'الرسالة غير موجودة' });
    }
    if (message.direction !== 'OUTBOUND' || message.isInternal) {
      return res.status(400).json({ error: 'هذه الرسالة ما بتنبعت عبر واتساب' });
    }
    if (message.status !== 'FAILED') {
      // Not an error the agent caused: someone else's retry, or a late ack,
      // may have already resolved it. Report the state rather than resend.
      return res.status(409).json({ error: 'الرسالة مش بحالة فشل', status: message.status });
    }

    const { conversation } = message;
    try {
      if (message.mediaUrl) {
        await OpenWAService.sendMedia(
          conversation.session.sessionName,
          conversation.contact.phone,
          gatewayReachableAssetUrl(message.mediaUrl),
          message.body ?? undefined,
          { mediaType: message.mediaType, fileName: message.mediaFileName },
        );
      } else {
        await OpenWAService.sendText(conversation.session.sessionName, conversation.contact.phone, message.body ?? '');
      }
    } catch (retryErr) {
      const failure = describeSendFailure(retryErr);
      logger.error('OpenWA retry failed', { error: String(retryErr), code: failure.code, messageId: message.id, requestId: (req as any).id });
      await prisma.message.update({
        where: { id: message.id },
        data: { failureReason: failure.reason },
      });
      if (isQuotaExceededError(retryErr)) {
        return res.status((retryErr as any).status).json(quotaErrorResponse(retryErr as any));
      }
      return res.status(502).json({ error: failure.reason, code: failure.code, retryable: failure.retryable });
    }

    const sent = await prisma.message.update({
      where: { id: message.id },
      data: { status: 'SENT', failureReason: null },
    });
    await markSuccessfulHumanOutbound(conversation.id, new Date());

    await auditConversation(req.user!.id, conversation.id, 'message-retried', req.ip, req.get('user-agent'));
    getIO()
      .to(socketRoom.conversation(req.user!.organizationId, conversation.id))
      .emit(SocketEvents.MESSAGE_ACK, { conversationId: conversation.id, messageId: sent.id, status: sent.status });

    res.json(sent);
  } catch (err) {
    logger.error('message retry failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    res.status(500).json({ error: 'فشل إعادة إرسال الرسالة', requestId: (req as any).id });
  }
});

/**
 * PATCH /api/conversations/:id/snooze — hide a thread until a moment.
 *
 * The alternative an agent had was to leave it open, where it sits in the
 * queue looking like work nobody has started, or resolve it — which tells the
 * customer it is finished and sends them a rating request. Neither is "deal
 * with this on Tuesday".
 *
 * `until: null` wakes it immediately. A time in the past is refused rather
 * than silently treated as one or the other: it is always a mistake, and
 * guessing which mistake helps nobody.
 */
router.patch('/:id/snooze', requirePermission('conversation:resolve'), async (req, res) => {
  try {
    const raw = req.body?.until;
    const until = raw ? new Date(raw) : null;

    if (raw && Number.isNaN(until!.getTime())) {
      return res.status(400).json({ error: 'وقت غير صالح' });
    }
    if (until && until.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'وقت التأجيل لازم يكون بالمستقبل' });
    }

    const before = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'محادثة غير موجودة' });

    const conversation = await prisma.conversation.update({
      where: { id: req.params.id },
      data: {
        snoozedUntil: until,
        snoozedByName: until ? req.user!.name : null,
      },
    });
    await rescheduleConversationAutoClose(conversation.id, until);

    await auditConversation(
      req.user!.id,
      conversation.id,
      until ? 'snoozed' : 'unsnoozed',
      req.ip,
      req.get('user-agent'),
    );

    getIO()
      .to(socketRoom.conversation(req.user!.organizationId, conversation.id))
      .emit(SocketEvents.CONVERSATION_UPDATED, { conversationId: conversation.id });

    res.json(conversation);
  } catch (err) {
    logger.error('Snooze failed', { conversationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'فشل تأجيل المحادثة', requestId: (req as any).id });
  }
});

// PATCH /api/conversations/:id — status (resolve/pending/reopen) or assignee
// Agents can change status; only supervisors+ can reassign.
router.patch('/:id', requirePermission('conversation:resolve'), async (req, res) => {
  try {
    const { status, assignedToId, categoryId, summary } = req.body;
    const convId = req.params.id;
    const user = req.user!;

    if (status !== undefined && !isConversationStatus(status)) {
      return res.status(400).json({ error: 'Invalid conversation status' });
    }

    // Assigning TO someone requires supervisor role; unassigning (null) is allowed for anyone
    if (assignedToId !== undefined && assignedToId !== null) {
      const role = user.role as string;
      if (!['ADMIN', 'SUPERVISOR'].includes(role)) {
        return res.status(403).json({ error: 'تعيين الوكيل يتطلب صلاحية المشرف' });
      }
      const assignee = await prisma.user.findUnique({ where: { id: assignedToId } });
      if (!assignee) {
        logger.warn('Assignee not found', { assignedToId, requestId: (req as any).id });
        return res.status(400).json({ error: 'مستخدم غير موجود' });
      }
    }

    const before = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!before) {
      return res.status(404).json({ error: 'محادثة غير موجودة', requestId: (req as any).id });
    }

    let conv;
    let stateChanged = true;
    if (status === 'RESOLVED') {
      const result = await closeConversation({
        conversationId: convId,
        source: 'MANUAL',
        categoryId,
        summary,
        actor: {
          id: user.id,
          name: user.name,
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        },
        enforceManualPolicy: true,
        sendClosingReply: true,
      });
      conv = result.conversation;
      stateChanged = result.changed;
    } else if (status && status !== 'RESOLVED' && before.status === 'RESOLVED') {
      const result = await reopenConversation(convId, {
        id: user.id,
        name: user.name,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
      conv = status === 'OPEN'
        ? result.conversation
        : await prisma.conversation.update({
            where: { id: convId },
            data: { status },
          });
      stateChanged = result.changed;
    } else {
      conv = await prisma.conversation.update({
        where: { id: convId },
        data: {
          ...(status && { status }),
          ...(assignedToId !== undefined && { assignedToId: assignedToId || null }),
        },
      });
      const auditAction = status === 'PENDING'
        ? 'pending'
        : assignedToId !== undefined
          ? 'assigned'
          : 'updated';
      await auditConversation(user.id, convId, auditAction, req.ip, req.get('user-agent'));
    }

    if (status === 'RESOLVED' && stateChanged) {
      // Send CSAT prompt to customer and notify the agent
      sendCsatPrompt(convId).catch(() => {});
      notifyResolved(convId, user.name).catch(() => {});
    }
    if (status === 'PENDING' || status === 'OPEN') {
      getIO().to(socketRoom.conversation(req.user!.organizationId, conv.id)).emit(SocketEvents.UNREAD_UPDATE, { conversationId: conv.id });
    }
    if (assignedToId && assignedToId !== before.assignedToId) {
      notifyAssigned(convId, assignedToId, user.name).catch(() => {});
    }

    res.json(conv);
  } catch (err) {
    logger.error('conversation update failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    if (err instanceof ConversationLifecycleError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: 'فشل تحديث المحادثة', requestId: (req as any).id });
  }
});

// PATCH /api/conversations/:id/labels — replace the labels array
router.patch('/:id/labels', requirePermission('conversation:create'), async (req, res) => {
  try {
    const { labels } = req.body;
    if (!Array.isArray(labels)) {
      return res.status(400).json({ error: 'labels يجب أن يكون مصفوفة' });
    }
    const sanitized = labels
      .map((l: any) => String(l).trim())
      .filter(Boolean)
      .slice(0, 10);

    const conv = await prisma.conversation.update({
      where: { id: req.params.id },
      data: { labels: sanitized },
    });

    getIO().to(socketRoom.conversation(req.user!.organizationId, conv.id)).emit(SocketEvents.UNREAD_UPDATE, { conversationId: conv.id });
    res.json(conv);
  } catch (err) {
    logger.error('labels update failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل تحديث التصنيفات', requestId: (req as any).id });
  }
});

export default router;
