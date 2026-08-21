import { prisma } from '../../prisma';

/**
 * Report aggregation (M7).
 *
 * Two rules shape every query here.
 *
 * **Aggregate in Postgres.** The endpoint this replaces loaded every sent
 * message and every assigned conversation for every agent into memory and
 * counted them in JS. That is fine on a demo tenant and quietly fatal on a real
 * one. Everything below is `count`, `aggregate`, `groupBy`, or a read of the
 * hourly rollup — with one deliberate exception, noted where it appears.
 *
 * **Never build a tenant filter by hand.** Every call runs inside an
 * organization scope and the Prisma extension injects `organizationId` at the
 * top level of `where`. It does *not* descend into nested relation filters, so
 * where a relation is traversed the scalar is written out explicitly.
 */

export type Period = { from: Date; to: Date };

/**
 * The slice every report is read through.
 *
 * Applied at the source rather than by trimming results, so a filtered
 * median is the median *of that slice* rather than the whole-period median
 * with some rows hidden.
 */
export type ReportFilters = {
  teamId?: string;
  /** A WhatsApp session id — how a tenant separates support from marketing. */
  sessionId?: string;
};

export function hasFilters(filters: ReportFilters): boolean {
  return Boolean(filters.teamId || filters.sessionId);
}

/** Conversation-level filter. Both columns live on Conversation. */
function conversationFilter(filters: ReportFilters) {
  return {
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
  };
}

/**
 * Message-level filter, reached through the conversation.
 *
 * `organizationId` is written out on the nested side: the tenancy extension
 * injects only at the top level of `where` and does not descend into relation
 * filters. It is redundant while the join key is a tenant-local composite FK,
 * and it stays correct if one ever is not.
 *
 * Returns nothing at all when unfiltered, so the common path does not pay for
 * a join it does not need.
 */
function messageFilter(filters: ReportFilters, organizationId: string) {
  if (!hasFilters(filters)) return {};
  return { conversation: { organizationId, ...conversationFilter(filters) } };
}

/** The period of the same length immediately before this one, for deltas. */
export function previousPeriod(period: Period): Period {
  const span = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - span), to: new Date(period.from.getTime()) };
}

/** Half-open [from, to) — a closed range double-counts on the boundary. */
function within(period: Period) {
  return { gte: period.from, lt: period.to };
}

function percentChange(current: number, previous: number): number | null {
  // A jump from nothing to something is not "infinity percent"; it has no
  // meaningful rate, and the UI should say so rather than print one.
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type Headline = {
  key: string;
  value: number;
  previous: number;
  changePct: number | null;
};

async function headlineValues(
  period: Period,
  filters: ReportFilters,
  organizationId: string,
) {
  const conv = conversationFilter(filters);
  const msg = messageFilter(filters, organizationId);

  const [conversationsStarted, conversationsResolved, inbound, outbound] = await Promise.all([
    prisma.conversation.count({ where: { createdAt: within(period), ...conv } }),
    prisma.conversation.count({ where: { resolvedAt: within(period), ...conv } }),
    prisma.message.count({ where: { timestamp: within(period), direction: 'INBOUND', ...msg } }),
    prisma.message.count({
      where: { timestamp: within(period), direction: 'OUTBOUND', isInternal: false, ...msg },
    }),
  ]);

  // Contacts belong to no team and no channel, so a "new contacts" number
  // cannot honour these filters. Rather than show an unfiltered figure beside
  // filtered ones — which reads as though it were also scoped — it is omitted
  // entirely whenever a filter is active.
  const contactsAdded = hasFilters(filters)
    ? null
    : await prisma.contact.count({ where: { createdAt: within(period) } });

  return {
    conversationsStarted,
    conversationsResolved,
    inbound,
    outbound,
    messageVolume: inbound + outbound,
    contactsAdded,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export type DurationStats = {
  count: number;
  medianMinutes: number | null;
  meanMinutes: number | null;
  p90Minutes: number | null;
  /** Fixed buckets, so the shape of the distribution shows, not just its centre. */
  buckets: { label: string; max: number | null; count: number }[];
  /** True when the sample was capped — the summary describes a slice, not the period. */
  truncated: boolean;
};

const DURATION_BUCKETS: { label: string; max: number | null }[] = [
  { label: 'under_5m', max: 5 },
  { label: 'under_15m', max: 15 },
  { label: 'under_1h', max: 60 },
  { label: 'under_4h', max: 240 },
  { label: 'under_24h', max: 1440 },
  { label: 'over_24h', max: null },
];

/**
 * Ceiling on rows read for a percentile.
 *
 * Percentiles need the individual durations, which no Prisma aggregate can
 * produce — this is the one place that reads rows rather than counts. The read
 * is bounded by the *conversation* count in the period and selects two
 * timestamps, so it is far smaller than the message scan it replaces, but it is
 * still unbounded in principle. The cap makes the worst case finite and the
 * response says when it bit, rather than quietly describing a sample as if it
 * were the whole period.
 */
const MAX_DURATION_SAMPLE = 20000;

/** Same reasoning, for the filtered series and heatmap paths. */
const MAX_SERIES_SAMPLE = 50000;

function summarise(durationsMinutes: number[], truncated: boolean): DurationStats {
  const sorted = [...durationsMinutes].sort((a, b) => a - b);
  const buckets = DURATION_BUCKETS.map((b) => ({ ...b, count: 0 }));
  for (const d of sorted) {
    const bucket = buckets.find((b) => b.max !== null && d < b.max) ?? buckets[buckets.length - 1];
    bucket.count += 1;
  }
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    count: sorted.length,
    medianMinutes: round(percentile(sorted, 0.5)),
    // Reported next to the median on purpose: one thread left open over a
    // weekend drags the mean from minutes into hours, and the gap between the
    // two numbers is what tells a manager that happened.
    meanMinutes: round(sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : null),
    p90Minutes: round(percentile(sorted, 0.9)),
    buckets,
    truncated,
  };
}

/** Conversations answered in the period, and how long the customer waited. */
export async function firstResponseStats(
  period: Period,
  filters: ReportFilters = {},
): Promise<DurationStats> {
  const rows = await prisma.conversation.findMany({
    where: { firstResponseAt: within(period), ...conversationFilter(filters) },
    select: { createdAt: true, firstResponseAt: true },
    take: MAX_DURATION_SAMPLE + 1,
  });
  const durations = rows
    .slice(0, MAX_DURATION_SAMPLE)
    .map((r) => (r.firstResponseAt!.getTime() - r.createdAt.getTime()) / 60000)
    // A reopened thread keeps its original stamp, so its response can predate
    // the current createdAt. Negatives are dropped rather than clamped to zero,
    // which would invent a population of instant replies.
    .filter((d) => d >= 0);
  return summarise(durations, rows.length > MAX_DURATION_SAMPLE);
}

/** Conversations resolved in the period, and how long they stayed open. */
export async function resolutionStats(
  period: Period,
  filters: ReportFilters = {},
): Promise<DurationStats> {
  const rows = await prisma.conversation.findMany({
    where: { resolvedAt: within(period), ...conversationFilter(filters) },
    select: { createdAt: true, resolvedAt: true },
    take: MAX_DURATION_SAMPLE + 1,
  });
  const durations = rows
    .slice(0, MAX_DURATION_SAMPLE)
    .map((r) => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 60000)
    .filter((d) => d >= 0);
  return summarise(durations, rows.length > MAX_DURATION_SAMPLE);
}

export type OverviewReport = {
  headlines: Headline[];
  firstResponseMedianMinutes: number | null;
  firstResponsePreviousMinutes: number | null;
  resolutionMedianMinutes: number | null;
  resolutionPreviousMinutes: number | null;
  series: { date: string; inbound: number; outbound: number; resolved: number }[];
};

export async function overview(
  period: Period,
  filters: ReportFilters,
  organizationId: string,
): Promise<OverviewReport> {
  const [current, previous, series, frt, resolution] = await Promise.all([
    headlineValues(period, filters, organizationId),
    headlineValues(previousPeriod(period), filters, organizationId),
    dailySeries(period, filters, organizationId),
    firstResponseStats(period, filters),
    resolutionStats(period, filters),
    ]);

  const [frtPrev, resolutionPrev] = await Promise.all([
    firstResponseStats(previousPeriod(period), filters),
    resolutionStats(previousPeriod(period), filters),
  ]);

  const counts: (keyof typeof current)[] = [
    'messageVolume',
    'conversationsStarted',
    'conversationsResolved',
    'inbound',
    'outbound',
    'contactsAdded',
  ];

  const headlines: Headline[] = counts
    // `contactsAdded` is null under a team or channel filter, because contacts
    // carry neither. Dropping the tile is honest; showing an unfiltered number
    // beside filtered ones is not.
    .filter((key) => current[key] !== null)
    .map((key) => ({
      key,
      value: current[key] as number,
      previous: (previous[key] ?? 0) as number,
      changePct: percentChange(current[key] as number, (previous[key] ?? 0) as number),
    }));

  return {
    headlines,
    // The two headline durations travel beside the counts so the page can lead
    // with them without a second round trip.
    firstResponseMedianMinutes: frt.medianMinutes,
    firstResponsePreviousMinutes: frtPrev.medianMinutes,
    resolutionMedianMinutes: resolution.medianMinutes,
    resolutionPreviousMinutes: resolutionPrev.medianMinutes,
    series,
  };
}

/**
 * Daily volume, assembled from the hourly rollup.
 *
 * Days are summed from hour buckets rather than counted per day, so a 90-day
 * range costs one query returning at most ~2,160 small rows instead of 90
 * round-trips or a scan of the message table.
 */
export async function dailySeries(
  period: Period,
  filters: ReportFilters = {},
  organizationId = '',
): Promise<{ date: string; inbound: number; outbound: number; resolved: number }[]> {
  const byDay = new Map<string, { inbound: number; outbound: number; resolved: number }>();
  const bump = (date: string, key: keyof { inbound: 0; outbound: 0; resolved: 0 }) => {
    const day = byDay.get(date) ?? { inbound: 0, outbound: 0, resolved: 0 };
    day[key] += 1;
    byDay.set(date, day);
  };

  if (!hasFilters(filters)) {
    // Fast path: the rollup has no team or channel dimension, but it does not
    // need one here. A 90-day range is ~2,160 small rows instead of a scan.
    const rows = await prisma.analyticsHourly.findMany({
      where: { hourStart: within(period) },
      select: { hourStart: true, inbound: true, outbound: true, conversationsResolved: true },
      orderBy: { hourStart: 'asc' },
    });
    for (const row of rows) {
      const date = row.hourStart.toISOString().slice(0, 10);
      const day = byDay.get(date) ?? { inbound: 0, outbound: 0, resolved: 0 };
      day.inbound += row.inbound;
      day.outbound += row.outbound;
      day.resolved += row.conversationsResolved;
      byDay.set(date, day);
    }
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
  }

  // Filtered: the rollup cannot answer this, so the days are built from the
  // rows themselves. Bounded by the cap rather than the period, and only ever
  // reached when a team or channel is actually selected.
  const [messages, resolved] = await Promise.all([
    prisma.message.findMany({
      where: {
        timestamp: within(period),
        isInternal: false,
        ...messageFilter(filters, organizationId),
      },
      select: { timestamp: true, direction: true },
      take: MAX_SERIES_SAMPLE,
      orderBy: { timestamp: 'asc' },
    }),
    prisma.conversation.findMany({
      where: { resolvedAt: within(period), ...conversationFilter(filters) },
      select: { resolvedAt: true },
      take: MAX_SERIES_SAMPLE,
      orderBy: { resolvedAt: 'asc' },
    }),
  ]);

  for (const message of messages) {
    bump(
      message.timestamp.toISOString().slice(0, 10),
      message.direction === 'INBOUND' ? 'inbound' : 'outbound',
    );
  }
  for (const conversation of resolved) {
    bump(conversation.resolvedAt!.toISOString().slice(0, 10), 'resolved');
  }

  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }));
}

export type HeatmapCell = { dayOfWeek: number; hour: number; inbound: number; outbound: number };

/**
 * Volume by hour-of-day and day-of-week — the staffing chart.
 *
 * Bucketed against the viewer's UTC offset, because "we are busy at 9am" is a
 * claim about the business's clock, not UTC. Applying the offset to whole-hour
 * buckets is exact for whole-hour zones and off by the remainder for the
 * half-hour ones; storing local time in the rollup instead would break the
 * moment a tenant moves.
 */
export async function hourOfDayHeatmap(
  period: Period,
  utcOffsetMinutes = 0,
  filters: ReportFilters = {},
  organizationId = '',
): Promise<HeatmapCell[]> {
  const grid = new Map<string, HeatmapCell>();
  const cellFor = (at: Date): HeatmapCell => {
    const local = new Date(at.getTime() + utcOffsetMinutes * 60000);
    const dayOfWeek = local.getUTCDay();
    const hour = local.getUTCHours();
    const key = `${dayOfWeek}-${hour}`;
    const cell = grid.get(key) ?? { dayOfWeek, hour, inbound: 0, outbound: 0 };
    grid.set(key, cell);
    return cell;
  };

  if (!hasFilters(filters)) {
    const rows = await prisma.analyticsHourly.findMany({
      where: { hourStart: within(period) },
      select: { hourStart: true, inbound: true, outbound: true },
    });
    for (const row of rows) {
      const cell = cellFor(row.hourStart);
      cell.inbound += row.inbound;
      cell.outbound += row.outbound;
    }
  } else {
    const messages = await prisma.message.findMany({
      where: {
        timestamp: within(period),
        isInternal: false,
        ...messageFilter(filters, organizationId),
      },
      select: { timestamp: true, direction: true },
      take: MAX_SERIES_SAMPLE,
      orderBy: { timestamp: 'desc' },
    });
    for (const message of messages) {
      const cell = cellFor(message.timestamp);
      if (message.direction === 'INBOUND') cell.inbound += 1;
      else cell.outbound += 1;
    }
  }

  return [...grid.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.hour - b.hour);
}

export type AgentRow = {
  id: string;
  name: string;
  team: { id: string; name: string; color: string | null } | null;
  messagesSent: number;
  conversationsHandled: number;
  resolved: number;
  medianFirstResponseMinutes: number | null;
  csatAvg: number | null;
  csatCount: number;
};

/**
 * Per-agent workload and leaderboard.
 *
 * The shape matters more than it looks. The previous version asked Prisma for
 * every agent *with* their messages and conversations included, so the row
 * count grew with traffic. This asks for counts grouped by agent — five
 * aggregate queries whose result size is the number of agents, whatever the
 * volume behind them.
 */
export async function teamPerformance(
  period: Period,
  filter: ReportFilters & { search?: string } = {},
  organizationId = '',
): Promise<AgentRow[]> {
  const conv = conversationFilter(filter);
  const msg = messageFilter(filter, organizationId);

  const agents = await prisma.user.findMany({
    where: {
      isActive: true,
      role: { not: 'VIEWER' },
      ...(filter.teamId ? { primaryTeamId: filter.teamId } : {}),
      ...(filter.search ? { name: { contains: filter.search, mode: 'insensitive' } } : {}),
    },
    select: {
      id: true,
      name: true,
      primaryTeam: { select: { id: true, name: true, color: true } },
    },
    orderBy: { name: 'asc' },
  });

  if (agents.length === 0) return [];
  const agentIds = agents.map((a) => a.id);

  const [sent, handled, resolved, csat, responded] = await Promise.all([
    prisma.message.groupBy({
      by: ['sentById'],
      where: {
        sentById: { in: agentIds },
        direction: 'OUTBOUND',
        isInternal: false,
        timestamp: within(period),
        ...msg,
      },
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ['assignedToId'],
      where: { assignedToId: { in: agentIds }, createdAt: within(period), ...conv },
      _count: { _all: true },
    }),
    prisma.conversation.groupBy({
      by: ['assignedToId'],
      where: { assignedToId: { in: agentIds }, resolvedAt: within(period), ...conv },
      _count: { _all: true },
    }),
    prisma.csatSurveyResponse.groupBy({
      by: ['assignedToId'],
      where: {
        assignedToId: { in: agentIds },
        rating: { not: null },
        respondedAt: within(period),
      },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    // Durations again, so again rows rather than an aggregate — bounded by
    // conversations answered in the period.
    prisma.conversation.findMany({
      where: { assignedToId: { in: agentIds }, firstResponseAt: within(period), ...conv },
      select: { assignedToId: true, createdAt: true, firstResponseAt: true },
      take: MAX_DURATION_SAMPLE,
    }),
  ]);

  const countOf = (rows: { _count: { _all: number } }[], key: string, id: string) => {
    const row = rows.find((r) => (r as unknown as Record<string, string>)[key] === id);
    return row?._count._all ?? 0;
  };

  const responseByAgent = new Map<string, number[]>();
  for (const row of responded) {
    if (!row.assignedToId || !row.firstResponseAt) continue;
    const minutes = (row.firstResponseAt.getTime() - row.createdAt.getTime()) / 60000;
    if (minutes < 0) continue;
    const list = responseByAgent.get(row.assignedToId) ?? [];
    list.push(minutes);
    responseByAgent.set(row.assignedToId, list);
  }

  return agents.map((agent) => {
    const durations = (responseByAgent.get(agent.id) ?? []).sort((a, b) => a - b);
    const csatRow = csat.find((c) => c.assignedToId === agent.id);
    const median = percentile(durations, 0.5);
    return {
      id: agent.id,
      name: agent.name,
      team: agent.primaryTeam ?? null,
      messagesSent: countOf(sent, 'sentById', agent.id),
      conversationsHandled: countOf(handled, 'assignedToId', agent.id),
      resolved: countOf(resolved, 'assignedToId', agent.id),
      medianFirstResponseMinutes: median === null ? null : Math.round(median * 10) / 10,
      csatAvg: csatRow?._avg.rating ? Math.round(csatRow._avg.rating * 10) / 10 : null,
      csatCount: csatRow?._count._all ?? 0,
    };
  });
}

export type CampaignRow = {
  id: string;
  title: string;
  sentAt: Date | null;
  status: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied: number;
};

/**
 * Per-broadcast performance.
 *
 * Delivery and read come from `CampaignRecipient`, grouped in one query across
 * every campaign in view. Replies are the interesting one: "did this broadcast
 * make anyone talk to us" is a question about contacts, not messages, so it is
 * one `contact.count` per campaign that walks the relation in Postgres rather
 * than pulling recipient ids into Node and sending them back as an `in` list.
 *
 * That count traverses relations, and the tenancy extension does not descend
 * into nested filters — so `organizationId` is written out on both nested
 * sides. It is redundant while every join key is a tenant-local composite FK,
 * and it stays correct if one ever is not.
 */
export async function campaignPerformance(
  period: Period,
  organizationId: string,
  filters: ReportFilters = {},
): Promise<CampaignRow[]> {
  const campaigns = await prisma.campaign.findMany({
    where: {
      OR: [{ sentAt: within(period) }, { sentAt: null, createdAt: within(period) }],
      // A broadcast goes out on one session, so the channel filter applies
      // directly. A team filter does not: campaigns belong to no team, and
      // silently returning nothing under one would read as "this team sent no
      // broadcasts" rather than "that question does not apply here".
      ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    },
    select: { id: true, title: true, sentAt: true, status: true },
    orderBy: { createdAt: 'desc' },
    // A report page shows a page of campaigns; the rest belong to a narrower
    // date range rather than a longer response.
    take: 100,
  });

  if (campaigns.length === 0) return [];
  const campaignIds = campaigns.map((c) => c.id);

  const grouped = await prisma.campaignRecipient.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: { in: campaignIds } },
    _count: { _all: true },
  });

  const acks = await prisma.campaignRecipient.groupBy({
    by: ['campaignId'],
    where: { campaignId: { in: campaignIds } },
    _count: { deliveredAt: true, readAt: true, _all: true },
  });

  const replies = await Promise.all(
    campaigns.map(async (campaign) => {
      // Only meaningful once the broadcast actually went out.
      if (!campaign.sentAt) return 0;
      return prisma.contact.count({
        where: {
          campaignRecipients: {
            some: { campaignId: campaign.id, organizationId, sentAt: { not: null } },
          },
          conversations: {
            some: {
              organizationId,
              messages: {
                some: {
                  organizationId,
                  direction: 'INBOUND',
                  timestamp: { gte: campaign.sentAt },
                },
              },
            },
          },
        },
      });
    }),
  );

  return campaigns.map((campaign, i) => {
    const rows = grouped.filter((g) => g.campaignId === campaign.id);
    const ack = acks.find((a) => a.campaignId === campaign.id);
    const statusCount = (status: string) =>
      rows.filter((r) => r.status === status).reduce((s, r) => s + r._count._all, 0);

    return {
      id: campaign.id,
      title: campaign.title,
      sentAt: campaign.sentAt,
      status: campaign.status,
      recipients: ack?._count._all ?? 0,
      sent: statusCount('sent'),
      delivered: ack?._count.deliveredAt ?? 0,
      read: ack?._count.readAt ?? 0,
      failed: statusCount('failed'),
      replied: replies[i],
    };
  });
}

export type GatewayReport = {
  /**
   * What the database knows about each session. Live connectivity is not in
   * here on purpose: it belongs to the gateway, and the existing sessions
   * endpoint already asks it. A cached copy would be the more trustworthy
   * looking of the two and the wrong one.
   */
  sessions: {
    id: string;
    label: string;
    phoneNumber: string | null;
    isActive: boolean;
  }[];
  outbound: { total: number; failed: number; failureRatePct: number | null };
  automation: { total: number; automated: number; automatedRatePct: number | null };
};

/**
 * Gateway health, standing in for the "account health and cost" surface that
 * only exists on a metered API.
 *
 * The failed-send rate is the number that matters: the outage this platform
 * actually suffered was outbound returning errors while every session still
 * reported healthy, so session state alone is not evidence that sending works.
 */
export async function gatewayReport(period: Period): Promise<GatewayReport> {
  const [sessions, total, failed, automated] = await Promise.all([
    prisma.whatsappSession.findMany({
      select: { id: true, label: true, sessionName: true, phoneNumber: true, isActive: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.message.count({
      where: { timestamp: within(period), direction: 'OUTBOUND', isInternal: false },
    }),
    prisma.message.count({
      where: { timestamp: within(period), direction: 'OUTBOUND', isInternal: false, status: 'FAILED' },
    }),
    prisma.message.count({
      where: { timestamp: within(period), direction: 'OUTBOUND', isInternal: false, isAuto: true },
    }),
  ]);

  const rate = (part: number, whole: number) =>
    whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      label: s.label || s.sessionName,
      phoneNumber: s.phoneNumber,
      isActive: s.isActive,
    })),
    outbound: { total, failed, failureRatePct: rate(failed, total) },
    automation: { total, automated, automatedRatePct: rate(automated, total) },
  };
}
