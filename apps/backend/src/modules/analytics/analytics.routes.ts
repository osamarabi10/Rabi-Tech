import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import logger from '../../lib/logger';
import { requirePermission } from '../../middleware/rbac.middleware';

const router = Router();
router.use(verifyToken);

/**
 * GET /api/analytics/tickets
 * Metrics: total, by status, by priority, SLA tracking
 */
router.get('/agents', requirePermission('analytics:read'), async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const dateGte = startDate ? new Date(startDate as string) : undefined;
    const dateLte = endDate ? new Date(endDate as string) : undefined;
    const tsFilter = dateGte || dateLte ? {
      timestamp: {
        ...(dateGte ? { gte: dateGte } : {}),
        ...(dateLte ? { lte: dateLte } : {}),
      },
    } : {};
    const convDateFilter = dateGte || dateLte ? {
      createdAt: {
        ...(dateGte ? { gte: dateGte } : {}),
        ...(dateLte ? { lte: dateLte } : {}),
      },
    } : {};

    const agents = await prisma.user.findMany({
      where: { isActive: true, role: { not: 'VIEWER' } },
      select: {
        id: true,
        name: true,
        primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
        sentMessages: {
          where: { direction: 'OUTBOUND', isInternal: false, ...tsFilter },
          select: { id: true, conversationId: true },
        },
        assignedConversations: {
          where: convDateFilter,
          select: { id: true, status: true },
        },
      },
    });

    const agentIds = agents.map(a => a.id);
    const convIds = [...new Set(agents.flatMap(a => a.assignedConversations.map(c => c.id)))];

    const [firstInbound, firstOutbound, csatData] = await Promise.all([
      convIds.length > 0
        ? prisma.message.findMany({
            where: { conversationId: { in: convIds }, direction: 'INBOUND' },
            select: { conversationId: true, timestamp: true },
            orderBy: { timestamp: 'asc' },
            distinct: ['conversationId'],
          })
        : Promise.resolve([]),
      convIds.length > 0
        ? prisma.message.findMany({
            where: { conversationId: { in: convIds }, direction: 'OUTBOUND', isAuto: false, isInternal: false },
            select: { conversationId: true, timestamp: true },
            orderBy: { timestamp: 'asc' },
            distinct: ['conversationId'],
          })
        : Promise.resolve([]),
      agentIds.length > 0
        ? prisma.csatSurveyResponse.findMany({
            where: { assignedToId: { in: agentIds }, rating: { not: null } },
            select: { assignedToId: true, rating: true },
          })
        : Promise.resolve([]),
    ]);

    const firstInboundMap = new Map(firstInbound.map(m => [m.conversationId, m.timestamp]));
    const firstOutboundMap = new Map(firstOutbound.map(m => [m.conversationId, m.timestamp]));

    const csatMap = new Map<string, number[]>();
    for (const c of csatData) {
      if (!c.assignedToId) continue;
      if (!csatMap.has(c.assignedToId)) csatMap.set(c.assignedToId, []);
      csatMap.get(c.assignedToId)!.push(c.rating!);
    }

    const agentStats = agents.map(agent => {
      const resolvedCount = agent.assignedConversations.filter(c => c.status === 'RESOLVED').length;
      const responseTimes = agent.assignedConversations
        .map(c => {
          const inT = firstInboundMap.get(c.id);
          const outT = firstOutboundMap.get(c.id);
          if (!inT || !outT || outT < inT) return null;
          return (outT.getTime() - inT.getTime()) / 1000 / 60;
        })
        .filter((v): v is number => v !== null);

      const csatScores = csatMap.get(agent.id) || [];

      return {
        name: agent.name,
        team: agent.primaryTeam,
        messagesSent: agent.sentMessages.length,
        conversationsHandled: agent.assignedConversations.length,
        resolvedCount,
        avgFirstResponseMinutes: responseTimes.length > 0
          ? Math.round(responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length)
          : null,
        csatAvg: csatScores.length > 0
          ? Math.round((csatScores.reduce((s, v) => s + v, 0) / csatScores.length) * 10) / 10
          : null,
        csatCount: csatScores.length,
      };
    });

    res.json(agentStats);
  } catch (err) {
    logger.error('analytics agents failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب بيانات الموظفين', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/summary
 * Dashboard: key metrics snapshot
 */
router.get('/summary', requirePermission('analytics:read'), async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      openConversations,
      resolvedThisWeek,
      totalContacts,
      activeSessions,
    ] = await Promise.all([
      prisma.conversation.count({ where: { status: 'OPEN' } }),
      prisma.conversation.count({ where: { status: 'RESOLVED', updatedAt: { gte: sevenDaysAgo } } }),
      prisma.contact.count(),
      prisma.whatsappSession.count({ where: { isActive: true } }),
    ]);

    res.json({
      openConversations,
      resolvedThisWeek,
      totalContacts,
      activeSessions,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    logger.error('analytics summary failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب الملخص', requestId: (req as any).id });
  }
});

export default router;
