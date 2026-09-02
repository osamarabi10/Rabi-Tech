import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import logger from '../../lib/logger';
import { requirePermission } from '../../middleware/rbac.middleware';
import {
  campaignPerformance,
  campaignRepliedContactWhere,
  closureReport,
  lifecycleFunnel,
  firstResponseStats,
  gatewayReport,
  hourOfDayHeatmap,
  overview,
  resolutionStats,
  teamPerformance,
  type Period,
  type ReportFilters,
} from './reporting.service';
import { webhookReport } from './webhook-report.service';
import { WEBHOOK_LOG_RETENTION_DAYS } from '../webhooks/webhook-log.service';
import { workspaceOffsetMinutes } from '../../utils/workspace-offset';

const router = Router();
router.use(verifyToken);

/** Longest range a single report may span. */
const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

/**
 * Resolve `?from=&to=` into a period.
 *
 * Rejects rather than clamps a bad range: a report that silently answers a
 * different question than the one asked is worse than an error, because the
 * number still looks authoritative on screen.
 */
function parsePeriod(query: Record<string, unknown>): Period | { error: string } {
  const now = new Date();
  const rawFrom = typeof query.from === 'string' ? query.from : undefined;
  const rawTo = typeof query.to === 'string' ? query.to : undefined;

  const to = rawTo ? new Date(rawTo) : now;
  const from = rawFrom
    ? new Date(rawFrom)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 3600_000);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { error: 'invalid_date' };
  }
  if (from >= to) return { error: 'from_after_to' };
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 3600_000) {
    return { error: 'range_too_long' };
  }
  return { from, to };
}

function isPeriodError(p: Period | { error: string }): p is { error: string } {
  return (p as { error: string }).error !== undefined;
}

/**
 * The team and channel slice, read from the same query string on every report.
 *
 * Ids are passed through as opaque strings and never interpolated — they reach
 * Prisma as bound values, and a filter naming another tenant simply matches
 * nothing because the extension scopes the query it lands in.
 */
function parseFilters(query: Record<string, unknown>): ReportFilters {
  const teamId = typeof query.teamId === 'string' && query.teamId ? query.teamId : undefined;
  const sessionId =
    typeof query.sessionId === 'string' && query.sessionId ? query.sessionId : undefined;
  return { teamId, sessionId };
}

/*
  The client's `utcOffsetMinutes` is now ignored.

  It is still accepted on the query string, because a deployed frontend keeps
  sending it and rejecting the parameter would 400 every report during a
  rollout. It simply no longer decides anything: the offset comes from the
  workspace's own timezone, so two managers in different countries see the same
  numbers for the same week.

  The parameter should be dropped from the client and then from here. Until
  both, ignoring it is the behaviour, and this comment is why the reader will
  not find where it is used.
*/

/**
 * Reporting API (M7).
 *
 * Five surfaces, one question each, plus a drill-down — because a manager who
 * cannot click a number to see what it is made of will not believe it.
 *
 * Every handler runs behind `analytics:read` and inside the caller's
 * organization scope, so the aggregation never names a tenant itself.
 */

/** Headline tiles with period-over-period deltas, and the daily volume series. */
router.get('/overview', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const report = await overview(period, filters, req.user!.organizationId);
    res.json({ period, ...report });
  } catch (err) {
    logger.error('analytics overview failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/** Response and resolution distributions, plus the hour-of-day heatmap. */
router.get('/conversations', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const [firstResponse, resolution, heatmap] = await Promise.all([
      firstResponseStats(period, filters),
      resolutionStats(period, filters),
      hourOfDayHeatmap(
        period,
        // The workspace's clock, resolved at the period's end so a report run
        // during DST reads the offset that was in force for most of it.
        await workspaceOffsetMinutes(period.to),
        filters,
        req.user!.organizationId,
      ),
    ]);
    res.json({ period, firstResponse, resolution, heatmap });
  } catch (err) {
    logger.error('analytics conversations failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/**
 * Closure outcomes: category, source, and summary coverage.
 *
 * Every breakdown sums to `total` - including the uncategorised bucket, which
 * is reported rather than hidden so the parts always reconcile with the whole.
 */
router.get('/closures', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const report = await closureReport(period);
    res.json({ period, ...report });
  } catch (err) {
    logger.error('analytics closures failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/**
 * Lifecycle funnel for the contacts gained in the period.
 *
 * Scoped by contact creation date, so it reads as a cohort — "of what we
 * gained, where did it get to" — rather than a snapshot that would ignore the
 * period control entirely. See lifecycleFunnel for the reconciliation contract.
 */
router.get('/lifecycle', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const funnel = await lifecycleFunnel(period);
    res.json({ period, ...funnel });
  } catch (err) {
    logger.error('analytics lifecycle failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/** Per-agent workload and leaderboard, filterable by team and name. */
router.get('/team', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  const search = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : undefined;

  try {
    const filters = parseFilters(req.query as Record<string, unknown>);
    const agents = await teamPerformance(
      period,
      { ...filters, search },
      req.user!.organizationId,
    );
    res.json({ period, agents });
  } catch (err) {
    logger.error('analytics team failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/** Per-broadcast delivery, read and reply performance. */
router.get('/campaigns', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const campaigns = await campaignPerformance(
      period,
      req.user!.organizationId,
      parseFilters(req.query as Record<string, unknown>),
    );
    res.json({ period, campaigns });
  } catch (err) {
    logger.error('analytics campaigns failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/** Session state, failed-send rate and automation share. */
router.get('/gateway', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    res.json({ period, ...(await gatewayReport(period)) });
  } catch (err) {
    logger.error('analytics gateway failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/** Inbound gateway health and outbound webhook telemetry, split by direction. */
router.get('/webhooks', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const report = await webhookReport(period, WEBHOOK_LOG_RETENTION_DAYS);
    res.json({ period, ...report });
  } catch (err) {
    logger.error('analytics webhooks failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب التقرير', requestId: (req as any).id });
  }
});

/**
 * The conversations behind a number.
 *
 * Each metric name maps to a fixed `where`, never to a filter assembled from
 * the query string — the allow-list is what keeps a drill-down from becoming an
 * arbitrary query endpoint.
 */
const DRILLDOWNS = {
  started: (p: Period) => ({ createdAt: { gte: p.from, lt: p.to } }),
  resolved: (p: Period) => ({ resolvedAt: { gte: p.from, lt: p.to } }),
  answered: (p: Period) => ({ firstResponseAt: { gte: p.from, lt: p.to } }),
  unanswered: (p: Period) => ({
    createdAt: { gte: p.from, lt: p.to },
    firstResponseAt: null,
  }),
  open: (p: Period) => ({ createdAt: { gte: p.from, lt: p.to }, status: 'OPEN' as const }),
} as const;

type DrilldownMetric = keyof typeof DRILLDOWNS;

router.get('/drilldown', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  const metric = String(req.query.metric || '') as DrilldownMetric;
  if (!(metric in DRILLDOWNS)) {
    return res.status(400).json({ error: 'unknown_metric', allowed: Object.keys(DRILLDOWNS) });
  }

  const agentId = typeof req.query.agentId === 'string' && req.query.agentId ? req.query.agentId : undefined;
  const teamId = typeof req.query.teamId === 'string' && req.query.teamId ? req.query.teamId : undefined;
  const take = Math.min(Number(req.query.limit) || 50, 200);

  try {
    const where = {
      ...DRILLDOWNS[metric](period),
      ...(agentId ? { assignedToId: agentId } : {}),
      ...(teamId ? { teamId } : {}),
    };

    const [total, conversations] = await Promise.all([
      prisma.conversation.count({ where }),
      prisma.conversation.findMany({
        where,
        select: {
          id: true,
          displayId: true,
          status: true,
          createdAt: true,
          firstResponseAt: true,
          resolvedAt: true,
          contact: { select: { name: true, phone: true } },
          assignee: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    res.json({ metric, period, total, returned: conversations.length, conversations });
  } catch (err) {
    logger.error('analytics drilldown failed', {
      error: String(err),
      metric,
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب التفاصيل', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/campaigns/:id/replies — what the broadcast came back as.
 *
 * The campaign report has always shown a reply count and a percentage, and
 * stopped there. "Three of your five VIPs answered" is the least useful half
 * of that sentence: the reason anyone broadcasts is to hear what people say
 * back, and the threads were reachable only by remembering names and
 * searching the inbox one at a time.
 *
 * Returns the conversation plus the customer's first message since the send,
 * because that first line is almost always the requirement — the reason they
 * answered at all.
 */
router.get('/campaigns/:id/replies', requirePermission('analytics:read'), async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      select: { id: true, title: true, sentAt: true },
    });
    if (!campaign) return res.status(404).json({ error: 'الحملة غير موجودة' });

    // A campaign that never went out has no replies, and saying so is
    // different from returning an empty list as if it had.
    if (!campaign.sentAt) {
      return res.json({ campaign, sent: false, total: 0, replies: [] });
    }

    const organizationId = req.user!.organizationId;
    const take = Math.min(Number(req.query.limit) || 50, 200);

    const where = campaignRepliedContactWhere(campaign.id, organizationId, campaign.sentAt);

    const [total, contacts] = await Promise.all([
      prisma.contact.count({ where }),
      prisma.contact.findMany({
        where,
        take,
        select: {
          id: true,
          name: true,
          phone: true,
          conversations: {
            where: {
              messages: {
                some: { direction: 'INBOUND', timestamp: { gte: campaign.sentAt } },
              },
            },
            orderBy: { lastMessageAt: 'desc' },
            take: 1,
            select: {
              id: true,
              displayId: true,
              status: true,
              assignee: { select: { name: true } },
              messages: {
                where: { direction: 'INBOUND', timestamp: { gte: campaign.sentAt } },
                // Ascending: the *first* thing they said after the broadcast,
                // not the latest. The opening line is the answer; what follows
                // is the conversation that answer started.
                orderBy: { timestamp: 'asc' },
                take: 1,
                select: { body: true, timestamp: true },
              },
            },
          },
        },
      }),
    ]);

    const replies = contacts
      .map((contact) => {
        const conversation = contact.conversations[0];
        if (!conversation) return null;
        const message = conversation.messages[0];
        return {
          contactId: contact.id,
          name: contact.name,
          phone: contact.phone,
          conversationId: conversation.id,
          displayId: conversation.displayId,
          status: conversation.status,
          assigneeName: conversation.assignee?.name ?? null,
          body: message?.body ?? null,
          at: message?.timestamp ?? null,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // Newest answer first: on a large broadcast the ones still arriving are
      // the ones nobody has read.
      .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

    res.json({ campaign, sent: true, total, returned: replies.length, replies });
  } catch (err) {
    logger.error('campaign replies failed', {
      campaignId: req.params.id,
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب الردود', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/agents — kept for the existing dashboard caller.
 *
 * Now a thin projection of `teamPerformance`, so there is one implementation of
 * "how did this agent do" rather than two that can drift. The old shape is
 * preserved because the overview page still reads it.
 */
router.get('/agents', requirePermission('analytics:read'), async (req, res) => {
  const { startDate, endDate } = req.query as Record<string, string | undefined>;
  const period = parsePeriod({ from: startDate, to: endDate });
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const agents = await teamPerformance(period);
    res.json(
      agents.map((a) => ({
        name: a.name,
        team: a.team,
        messagesSent: a.messagesSent,
        conversationsHandled: a.conversationsHandled,
        resolvedCount: a.resolved,
        avgFirstResponseMinutes: a.medianFirstResponseMinutes,
        csatAvg: a.csatAvg,
        csatCount: a.csatCount,
      })),
    );
  } catch (err) {
    logger.error('analytics agents failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب بيانات الموظفين', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/summary — dashboard snapshot.
 *
 * `resolvedThisWeek` now counts `resolvedAt` rather than `updatedAt`, so
 * relabelling an old thread no longer makes it look freshly resolved.
 */
router.get('/summary', requirePermission('analytics:read'), async (req, res) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [openConversations, resolvedThisWeek, totalContacts, activeSessions] = await Promise.all([
      prisma.conversation.count({ where: { status: 'OPEN' } }),
      prisma.conversation.count({ where: { resolvedAt: { gte: sevenDaysAgo } } }),
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
