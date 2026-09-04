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
import { organizationOffsetMinutes } from '../../utils/organization-offset';

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
        // The organization's clock, resolved at the period's end so a report run
        // during DST reads the offset that was in force for most of it.
        await organizationOffsetMinutes(period.to),
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
 * Where contacts came from, in the period.
 *
 * **Attributed and unattributed side by side, always.** Prefill attribution is
 * best-effort by construction — the marker travels inside a message the customer
 * can see and edit — so a report showing only what it captured would be read as
 * a complete picture of acquisition when it structurally cannot be one. DIRECT
 * and UNKNOWN are returned as first-class rows, not filtered out and not merged.
 *
 * **Clicks sit behind contacts, and are not a denominator.** The redirect that
 * records them is unauthenticated, so anyone can inflate the number; a contact
 * cannot be forged the same way, because it costs the sender a real WhatsApp
 * message from a real number. That is why no conversion rate is computed here:
 * its numerator would be trustworthy and its denominator would not, and the
 * ratio would look meaningful while meaning nothing.
 */
router.get('/sources', requirePermission('analytics:read'), async (req, res) => {
  const period = parsePeriod(req.query as Record<string, unknown>);
  if (isPeriodError(period)) return res.status(400).json({ error: period.error });

  try {
    const where = { createdAt: { gte: period.from, lte: period.to } };

    const [bySource, widgets, clickTotal, claimedTotal] = await Promise.all([
      prisma.contact.groupBy({ by: ['acquisitionSource'], where, _count: { _all: true } }),
      prisma.growthWidget.findMany({
        select: {
          id: true, name: true, isArchived: true,
          _count: { select: { contacts: true, clicks: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.widgetClick.count({ where }),
      prisma.widgetClick.count({ where: { ...where, claimedByContactId: { not: null } } }),
    ]);

    const counts = Object.fromEntries(bySource.map((r) => [r.acquisitionSource, r._count._all]));
    const total = bySource.reduce((sum, r) => sum + r._count._all, 0);
    const attributed = counts.GROWTH_WIDGET || 0;

    res.json({
      period,
      // Every member, present even at zero. A source that disappears from the
      // response when it has no rows reads as a source that does not exist.
      sources: ['GROWTH_WIDGET', 'DIRECT', 'IMPORT', 'API', 'UNKNOWN'].map((key) => ({
        source: key,
        contacts: counts[key] || 0,
      })),
      totals: {
        contacts: total,
        attributed,
        unattributed: total - attributed,
      },
      widgets: widgets.map((w) => ({
        id: w.id, name: w.name, archived: w.isArchived,
        contacts: w._count.contacts, clicks: w._count.clicks,
      })),
      // Deliberately labelled. See the header: this is context, not performance.
      clicks: { total: clickTotal, claimed: claimedTotal, unverified: true },
    });
  } catch (err) {
    logger.error('analytics sources failed', {
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

/*
 * ── Dashboard widgets ────────────────────────────────────────────────────────
 *
 * Three endpoints rather than one, and that is deliberate. The dashboard renders
 * six cards that fail independently, each with its own retry. One combined
 * response would collapse that: a single slow or failing query would blank four
 * cards at once and the operator would lose the ability to tell which datum is
 * missing. Independent resources are what make independent failure possible.
 *
 * ## Blocked contacts are excluded, and this is the whole point
 *
 * Respond.io's dashboard counts assigned contacts differently from its inbox:
 * the dashboard includes blocked contacts and the inbox does not, so the two
 * screens disagree about the same number and neither says why.
 *
 * Both endpoints below filter `contact: { blockedAt: null }`. A blocked number
 * is one an operator has decided not to deal with; counting it as somebody's
 * workload overstates every queue on the screen and makes "assigned to me"
 * unactionable.
 *
 * Worth recording honestly: our own conversation list does NOT filter on
 * blockedAt today, and blocking a contact does not archive their threads. So
 * this endpoint is stricter than GET /api/conversations, and until that list is
 * brought into line the two can differ for an organization that has blocked
 * someone with an open thread. That is a smaller and more visible gap than the
 * one being avoided, and it is written here rather than discovered later.
 */

/** Start of the organization's local day, N days back. */
function localDayStart(offsetMinutes: number, daysBack = 0): Date {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - daysBack);
  return new Date(shifted.getTime() - offsetMinutes * 60_000);
}

/**
 * GET /api/analytics/dashboard/conversation-buckets
 *
 * Opened and closed for today, yesterday, the last 14 days and the last 30.
 * Buckets are computed against the organization's own day boundary, not UTC —
 * "today" on a screen in Jerusalem must mean today there.
 */
router.get('/dashboard/conversation-buckets', requirePermission('analytics:read'), async (req, res) => {
  try {
    const offset = await organizationOffsetMinutes();
    const todayStart = localDayStart(offset, 0);
    const yesterdayStart = localDayStart(offset, 1);
    const fourteenStart = localDayStart(offset, 13);
    const thirtyStart = localDayStart(offset, 29);

    const opened = (gte: Date, lt?: Date) =>
      prisma.conversation.count({ where: { createdAt: lt ? { gte, lt } : { gte } } });
    const closed = (gte: Date, lt?: Date) =>
      prisma.conversation.count({ where: { resolvedAt: lt ? { gte, lt } : { gte } } });

    const [
      openedToday, closedToday,
      openedYesterday, closedYesterday,
      opened14, closed14,
      opened30, closed30,
    ] = await Promise.all([
      opened(todayStart), closed(todayStart),
      opened(yesterdayStart, todayStart), closed(yesterdayStart, todayStart),
      opened(fourteenStart), closed(fourteenStart),
      opened(thirtyStart), closed(thirtyStart),
    ]);

    res.json({
      today: { opened: openedToday, closed: closedToday },
      yesterday: { opened: openedYesterday, closed: closedYesterday },
      last14Days: { opened: opened14, closed: closed14 },
      last30Days: { opened: opened30, closed: closed30 },
    });
  } catch (err) {
    logger.error('dashboard conversation buckets failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب عدادات المحادثات', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/dashboard/waiting-contacts
 *
 * Contacts with an open conversation, longest-waiting first — the order that
 * makes the widget actionable, because the top row is the person who has been
 * waiting the longest rather than whoever wrote most recently.
 *
 * `waitingSinceMinutes` measures from the last inbound message, falling back to
 * conversation creation for a thread that has none.
 */
router.get('/dashboard/waiting-contacts', requirePermission('analytics:read'), async (req, res) => {
  try {
    const rows = await prisma.conversation.findMany({
      where: {
        status: { not: 'RESOLVED' },
        isArchived: false,
        contact: { blockedAt: null },
      },
      select: {
        id: true,
        lastMessageAt: true,
        createdAt: true,
        contact: { select: { id: true, name: true, phone: true, profilePic: true } },
        assignee: { select: { id: true, name: true } },
        messages: {
          where: { direction: 'INBOUND' },
          orderBy: { timestamp: 'desc' },
          take: 1,
          select: { body: true, timestamp: true },
        },
      },
      take: 200,
    });

    const now = Date.now();
    const list = rows.map((row) => {
      const last = row.messages[0];
      const since = last?.timestamp ?? row.lastMessageAt ?? row.createdAt;
      return {
        conversationId: row.id,
        contactId: row.contact.id,
        name: row.contact.name || row.contact.phone,
        profilePic: row.contact.profilePic,
        lastMessage: last?.body ?? null,
        waitingSinceMinutes: Math.max(0, Math.round((now - new Date(since).getTime()) / 60_000)),
        assigneeName: row.assignee?.name ?? null,
      };
    });

    list.sort((a, b) => b.waitingSinceMinutes - a.waitingSinceMinutes);
    res.json({ contacts: list.slice(0, 8), total: list.length });
  } catch (err) {
    logger.error('dashboard waiting contacts failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب المحادثات المنتظرة', requestId: (req as any).id });
  }
});

/**
 * GET /api/analytics/dashboard/team
 *
 * Every user with their team, presence and the number of live conversations
 * assigned to them. The count excludes blocked contacts for the reason given at
 * the top of this block, and excludes resolved and archived threads so it reads
 * as current workload rather than lifetime volume.
 */
router.get('/dashboard/team', requirePermission('analytics:read'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        role: true,
        isAway: true,
        primaryTeam: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });

    const counts = await prisma.conversation.groupBy({
      by: ['assignedToId'],
      where: {
        status: { not: 'RESOLVED' },
        isArchived: false,
        assignedToId: { not: null },
        contact: { blockedAt: null },
      },
      _count: { _all: true },
    });
    const byUser = new Map(counts.map((c) => [c.assignedToId as string, c._count._all]));

    res.json({
      members: users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role,
        teamId: u.primaryTeam?.id ?? null,
        teamName: u.primaryTeam?.name ?? null,
        status: u.isAway ? 'away' : 'available',
        assignedCount: byUser.get(u.id) ?? 0,
      })),
    });
  } catch (err) {
    logger.error('dashboard team failed', { error: String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'فشل جلب بيانات الفريق', requestId: (req as any).id });
  }
});

export default router;
