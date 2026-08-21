import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { OpenWAService } from '../whatsapp/openwa.service';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import {
  closeConversationWithReply,
  getOrCreateActiveConversation,
} from '../../utils/conversation-session';
import { normalizePhoneInput } from '../../utils/phone';
import { sendStartWelcome } from '../../utils/welcome';
import { getSessionForTeam } from '../../utils/whatsapp-sessions';
import { validateBody, createConversationSchema, resolveConversationSchema } from '../../lib/validation';
import logger from '../../lib/logger';
import { stampFirstResponse } from '../analytics/response-time';
import { auditConversation } from '../../lib/audit';
import { requirePermission, requireSupervisor } from '../../middleware/rbac.middleware';
import { sendCsatPrompt } from '../../utils/client-feedback';
import { notifyAssigned, notifyResolved } from '../../utils/notification-service';
import { isQuotaExceededError, quotaErrorResponse } from '../usage/entitlements';
import { requireTeamId } from '../../utils/teams';

const router = Router();
router.use(verifyToken);

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

    res.json(full);
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
        ...(hideResolved ? { status: { not: 'RESOLVED' } } : {}),
        ...(status ? { status: status as any } : {}),
        ...teamFilter,
        ...(search ? {
          AND: [
            { contact: { isArchived: false } },
            {
              OR: [
                { contact: { name: { contains: search as string, mode: 'insensitive' } } },
                { contact: { phone: { contains: search as string } } },
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

    res.json(convs);
  } catch (err) {
    logger.error('conversations list failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    res.status(500).json({ error: 'فشل جلب المحادثات', requestId: (req as any).id });
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

    // Mark inbound as read (only on first page — no `before` cursor)
    if (!before) {
      await prisma.message.updateMany({
        where: { conversationId: req.params.id, direction: 'INBOUND', isRead: false },
        data: { isRead: true },
      });
    }

    res.json({
      messages,
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
    const { body, mediaUrl, isInternal } = req.body;

    if (!body?.trim() && !mediaUrl) {
      return res.status(400).json({ error: 'الرسالة لا يمكن أن تكون فارغة' });
    }

    const conv = await prisma.conversation.findUnique({
      where: { id: req.params.id },
      include: { contact: true, session: true },
    });
    if (!conv) {
      logger.warn('conversation not found', { conversationId: req.params.id, requestId: (req as any).id });
      return res.status(404).json({ error: 'محادثة غير موجودة' });
    }

    // Persist FIRST, then send. Previously the OpenWA call ran before message.create,
    // so a transport error (timeout/reset) AFTER successful delivery returned 503 and
    // discarded the message: the customer received it, the agent saw nothing, and
    // re-sending duplicated it. Never lose a message to a provider error again.
    const msg = await prisma.message.create({
      data: {
        organizationId: req.user!.organizationId,
        conversationId: conv.id,
        direction: 'OUTBOUND',
        body: body?.trim(),
        mediaUrl: isInternal ? null : mediaUrl,
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

    let sendError: unknown = null;
    if (!isInternal) {
      try {
        if (mediaUrl) {
          await OpenWAService.sendMedia(conv.session.sessionName, conv.contact.phone, mediaUrl, body);
        } else {
          await OpenWAService.sendText(conv.session.sessionName, conv.contact.phone, body);
        }
        await prisma.message.update({ where: { id: msg.id }, data: { status: 'SENT' } });
        msg.status = 'SENT';
      } catch (openwaErr) {
        sendError = openwaErr;
        logger.error('OpenWA send failed', { error: String(openwaErr), messageId: msg.id, sessionName: conv.session.sessionName, requestId: (req as any).id });
        await prisma.message.update({ where: { id: msg.id }, data: { status: 'FAILED' } });
        msg.status = 'FAILED';
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
      return res.json({ ...msg, sendError: 'تعذّر الإرسال عبر واتساب — الرسالة محفوظة، فيك تعيد المحاولة' });
    }
    res.json(msg);
  } catch (err) {
    logger.error('reply send failed', { error: String(err), requestId: (req as any).id, userId: req.user?.id });
    res.status(500).json({ error: 'فشل إرسال الرسالة', requestId: (req as any).id });
  }
});

// PATCH /api/conversations/:id — status (resolve/pending/reopen) or assignee
// Agents can change status; only supervisors+ can reassign.
router.patch('/:id', requirePermission('conversation:resolve'), async (req, res) => {
  try {
    const { status, assignedToId } = req.body;
    const convId = req.params.id;
    const user = req.user!;

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

    if (status === 'RESOLVED') {
      await closeConversationWithReply(convId);
    }

    const conv = await prisma.conversation.update({
      where: { id: convId },
      data: {
        ...(status && { status }),
        ...(assignedToId !== undefined && { assignedToId: assignedToId || null }),
        // Stamped at the transition, and cleared on reopen so the column always
        // describes the resolution that currently stands. Reporting previously
        // had to infer this from `updatedAt`, which relabelling a thread moved.
        ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
        ...(status && status !== 'RESOLVED' ? { resolvedAt: null } : {}),
      },
    });

    const auditAction = status === 'RESOLVED' ? 'resolved' : status === 'PENDING' ? 'pending' : assignedToId !== undefined ? 'assigned' : 'updated';
    await auditConversation(user.id, convId, auditAction, req.ip, req.get('user-agent'));

    if (status === 'RESOLVED') {
      getIO().to(socketRoom.organization(req.user!.organizationId)).emit(SocketEvents.CONVERSATION_RESOLVED, { conversationId: conv.id });
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
