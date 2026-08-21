import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import logger from '../../lib/logger';
import { requirePermission } from '../../middleware/rbac.middleware';
import {
  campaignPerformance,
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

/** Minutes east of UTC, as `Date.getTimezoneOffset()` inverted. Bounded to real zones. */
function parseUtcOffset(query: Record<string, unknown>): number {
  const raw = Number(query.utcOffsetMinutes);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(raw)));
}

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
        parseUtcOffset(req.query as Record<string, unknown>),
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
