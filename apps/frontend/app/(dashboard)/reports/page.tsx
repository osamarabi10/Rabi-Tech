'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarOff, Wifi, WifiOff } from 'lucide-react';
import { CampaignRepliesPanel } from '@/components/reports/campaign-replies-panel';
import {
  fetchCampaignsReport,
  fetchClosureReport,
  fetchLifecycleFunnel,
  fetchConversationsReport,
  fetchGatewayReport,
  fetchOverviewReport,
  fetchSessions,
  fetchTeamReport,
  fetchTeams,
  fetchWebhookReport,
  type CampaignReportRow,
  type ClosureReport,
  type FunnelStageRow,
  type LifecycleFunnel,
  type ConversationsReport,
  type DrilldownMetric,
  type GatewayReport,
  type OverviewReport,
  type ReportRange,
  type Session,
  type Team,
  type TeamReportRow,
  type WebhookReport,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DistributionBars,
  EmptyNote,
  ChartCard,
  MetricTile,
  ReportCard,
  formatDuration,
  formatPct,
} from '@/components/reports/primitives';
import { LineChart, type Series } from '@/components/reports/line-chart';
import { VolumeHeatmap } from '@/components/reports/heatmap';
import { DrilldownPanel } from '@/components/reports/drilldown-panel';
import {
  ReportFilterBar,
  resolveReportPreset,
  type ReportFilters,
  type ReportPreset,
} from '@/components/reports/filter-bar';
import { ErrorState } from '@/components/ui/operational-state';

/**
 * Reports.
 *
 * The page reads top to bottom the way the question is actually asked: pick the
 * slice, see where it stands, see how it moved, then look at the rows behind it.
 *
 *   filter bar  →  summary cards  →  time series  →  tables
 *
 * That order matters more than it sounds. An earlier version led with tables and
 * hid the period control in the page header, so the first thing on screen was
 * detail nobody had asked a question of yet, and changing the period meant
 * hunting for the control that owned it.
 *
 * Each tab fetches only when opened — five independent queries on mount would
 * make the slowest one the cost of the page.
 */

type TabKey = 'overview' | 'conversations' | 'team' | 'campaigns' | 'lifecycle' | 'closures' | 'gateway' | 'webhooks';

const BUCKET_LABEL: Record<string, string> = {
  under_5m: 'أقل من ٥ دقائق',
  under_15m: 'أقل من ١٥ دقيقة',
  under_1h: 'أقل من ساعة',
  under_4h: 'أقل من ٤ ساعات',
  under_24h: 'أقل من ٢٤ ساعة',
  over_24h: 'أكثر من ٢٤ ساعة',
};

const HEADLINE_LABEL: Record<string, string> = {
  messageVolume: 'حجم الرسائل',
  conversationsStarted: 'محادثات بدأت',
  conversationsResolved: 'محادثات حُلّت',
  inbound: 'رسائل واردة',
  outbound: 'رسائل صادرة',
  contactsAdded: 'جهات اتصال جديدة',
};

const HEADLINE_DRILLDOWN: Record<string, DrilldownMetric | undefined> = {
  conversationsStarted: 'started',
  conversationsResolved: 'resolved',
};

/** Change between two durations, where *down* is the improvement. */
function durationChangePct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  // Negated so the arrow points the way the operator feels it: a response time
  // that fell is an improvement, and an up-arrow on a rising wait would be a lie
  // told by a component that only knows the number went up.
  return -Math.round(((current - previous) / previous) * 1000) / 10;
}

export default function ReportsPage() {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>('overview');
  const [filters, setFilters] = useState<ReportFilters>({ preset: 'last_30_days', teamId: '', sessionId: '' });
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [volumeGroupBy, setVolumeGroupBy] = useState('');
  const [drilldown, setDrilldown] = useState<{ metric: DrilldownMetric; agentId?: string } | null>(
    null,
  );
  /** The campaign whose replies are open, if any. */
  const [repliesFor, setRepliesFor] = useState<string | null>(null);

  const resolvedRange = useMemo(() => resolveReportPreset(filters.preset), [filters.preset]);
  const range = useMemo<ReportRange>(
    () => ({ from: resolvedRange.from, to: resolvedRange.to }),
    [resolvedRange.from, resolvedRange.to],
  );

  const query = useMemo(
    () => ({
      ...range,
      teamId: filters.teamId || undefined,
      sessionId: filters.sessionId || undefined,
    }),
    [range, filters.teamId, filters.sessionId],
  );

  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [conversations, setConversations] = useState<ConversationsReport | null>(null);
  const [team, setTeam] = useState<TeamReportRow[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignReportRow[] | null>(null);
  const [gateway, setGateway] = useState<GatewayReport | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookReport | null>(null);
  const [closures, setClosures] = useState<ClosureReport | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleFunnel | null>(null);
  const [liveSessions, setLiveSessions] = useState<Session[]>([]);

  const [teams, setTeams] = useState<Team[]>([]);
  const [channels, setChannels] = useState<GatewayReport['sessions']>([]);
  const [teamSearch, setTeamSearch] = useState('');

  useEffect(() => {
    // The filter bar's own vocabulary. Fetched once, and from the report rather
    // than the gateway: these are the sessions conversations are stored against,
    // which is what the filter actually matches on.
    fetchTeams().then(setTeams).catch(() => {});
    fetchGatewayReport(range)
      .then((report) => setChannels(report.sessions))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      if (tab === 'overview') setOverview(await fetchOverviewReport(query));
      if (tab === 'conversations') setConversations(await fetchConversationsReport(query));
      if (tab === 'team') {
        const res = await fetchTeamReport(query, { q: teamSearch.trim() || undefined });
        setTeam(res.agents);
      }
      if (tab === 'campaigns') setCampaigns((await fetchCampaignsReport(query)).campaigns);
      if (tab === 'gateway') {
        // Stored session state and live connectivity come from different places
        // on purpose — a cached copy of "connected" is the more convincing of
        // the two and the wrong one.
        const [report, live] = await Promise.all([fetchGatewayReport(query), fetchSessions()]);
        setGateway(report);
        setLiveSessions(live);
      }
      if (tab === 'lifecycle') setLifecycle(await fetchLifecycleFunnel(query));
      if (tab === 'closures') setClosures(await fetchClosureReport(query));
      if (tab === 'webhooks') setWebhooks(await fetchWebhookReport(query));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tab, query, teamSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'نظرة عامة' },
    { key: 'conversations', label: 'المحادثات' },
    { key: 'team', label: 'الفريق' },
    { key: 'campaigns', label: 'الحملات' },
    { key: 'lifecycle', label: 'دورة حياة العميل' },
    { key: 'closures', label: 'الإغلاقات' },
    { key: 'gateway', label: 'حالة القناة' },
    { key: 'webhooks', label: 'الويب هوك' },
  ];

  const widerPreset: Partial<Record<ReportPreset, ReportPreset>> = {
    today: 'last_7_days',
    yesterday: 'last_7_days',
    last_7_days: 'last_30_days',
    last_30_days: 'last_90_days',
  };

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <h1 className="mb-3 text-h1 font-extrabold">{t('التقارير')}</h1>

      <ReportFilterBar
        filters={filters}
        onChange={setFilters}
        teams={teams}
        sessions={channels}
        loading={loading}
        onRefresh={load}
      />

      <nav className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              'border-b-2 px-3 py-2 text-h3 font-medium transition-colors motion-micro',
              tab === item.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t(item.label)}
          </button>
        ))}
      </nav>

      {failed ? (
        <ErrorState
          title={t('تعذّر جلب التقرير')}
          description={t('تعذّر جلب التقرير')}
          retryLabel={t('حاول مرة أخرى')}
          onRetry={load}
        />
      ) : (
        <div className="space-y-4">
          {tab === 'overview' && (
            <OverviewTab
              report={overview}
              loading={loading}
              onDrilldown={(metric) => setDrilldown({ metric })}
              days={resolvedRange.days}
              groupBy={volumeGroupBy}
              onGroupByChange={setVolumeGroupBy}
              // Next range up, or null at the widest. Derived from the same
              // list the filter bar offers so the two cannot drift apart.
              onWiden={widerPreset[filters.preset]
                ? () => setFilters((prev) => ({ ...prev, preset: widerPreset[prev.preset]! }))
                : null}
            />
          )}
          {tab === 'conversations' && <ConversationsTab report={conversations} loading={loading} />}
          {tab === 'team' && (
            <TeamTab
              rows={team}
              loading={loading}
              search={teamSearch}
              onSearch={setTeamSearch}
              onDrilldown={(agentId) => setDrilldown({ metric: 'resolved', agentId })}
            />
          )}
          {tab === 'campaigns' && (
            <CampaignsTab rows={campaigns} loading={loading} onOpenReplies={setRepliesFor} />
          )}
          {tab === 'gateway' && (
            <GatewayTab report={gateway} sessions={liveSessions} loading={loading} />
          )}
          {tab === 'lifecycle' && <LifecycleTab report={lifecycle} loading={loading} />}
          {tab === 'closures' && <ClosuresTab report={closures} loading={loading} />}
          {tab === 'webhooks' && <WebhooksTab report={webhooks} loading={loading} />}
        </div>
      )}

      {repliesFor && (
        <CampaignRepliesPanel campaignId={repliesFor} onClose={() => setRepliesFor(null)} />
      )}

      {drilldown && (
        <DrilldownPanel
          range={range}
          metric={drilldown.metric}
          agentId={drilldown.agentId}
          onClose={() => setDrilldown(null)}
        />
      )}
    </div>
  );
}

function Loading() {
  const { t } = useT();
  return <p className="py-10 text-center text-body text-muted-foreground">{t('جاري التحميل...')}</p>;
}

function OverviewTab({
  report,
  loading,
  onDrilldown,
  days,
  groupBy,
  onGroupByChange,
  onWiden,
}: {
  report: OverviewReport | null;
  loading: boolean;
  onDrilldown: (metric: DrilldownMetric) => void;
  /** The window currently selected, so an empty one can name itself. */
  days: number;
  groupBy: string;
  onGroupByChange: (value: string) => void;
  /** Widen to the next range up. Absent once already at the widest. */
  onWiden: (() => void) | null;
}) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  const volume = report.headlines.find((h) => h.key === 'messageVolume');
  const rest = report.headlines.filter((h) => h.key !== 'messageVolume');

  const series: Series[] = [
    {
      key: 'inbound',
      label: t('رسائل واردة'),
      color: 'hsl(var(--primary))',
      points: report.series.map((p) => ({ date: p.date, value: p.inbound })),
    },
    {
      key: 'outbound',
      label: t('رسائل صادرة'),
      color: 'hsl(var(--success))',
      points: report.series.map((p) => ({ date: p.date, value: p.outbound })),
    },
    {
      key: 'resolved',
      label: t('محادثات حُلّت'),
      color: 'hsl(var(--warning))',
      points: report.series.map((p) => ({ date: p.date, value: p.resolved })),
    },
  ];
  const visibleSeries = groupBy ? series.filter((item) => item.key === groupBy) : series;
  const values = { inbound: 'inbound', outbound: 'outbound', resolved: 'resolved' } as const;
  const chartData = report.series.map((point) => {
    const row: Record<string, string | number> = { date: point.date };
    for (const item of visibleSeries) {
      const key = values[item.key as keyof typeof values];
      if (key) row[key] = point[key];
    }
    return row;
  });

  /*
   * Nothing happened in this window.
   *
   * The page rendered em-dashes and zeros and left the reader to work out
   * whether the product was broken, the filter was wrong, or the business was
   * quiet. Those are three different problems and only one of them is theirs
   * to fix.
   *
   * Judged on the series rather than the headline medians: a median is
   * legitimately null when nothing was answered, but a series of all-zero
   * buckets means no traffic at all.
   */
  const emptyPeriod =
    report.series.length === 0 ||
    report.series.every((point) => point.inbound === 0 && point.outbound === 0 && point.resolved === 0);

  return (
    <>
      {emptyPeriod && (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-caption text-muted-foreground">
          <CalendarOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t('ما في نشاط بآخر')} {days} {t('يوم')}
          </span>
          {/* The likeliest fix, offered rather than described. */}
          {onWiden && (
            <button
              type="button"
              onClick={onWiden}
              className="font-medium text-primary underline underline-offset-2 hover:no-underline"
            >
              {t('وسّع المدة')}
            </button>
          )}
        </div>
      )}

      {/* The three the page leads with: how fast we answer, how fast we finish,
          and how much came through. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricTile
          label={t('زمن أول رد')}
          value={formatDuration(report.firstResponseMedianMinutes, t)}
          changePct={durationChangePct(
            report.firstResponseMedianMinutes,
            report.firstResponsePreviousMinutes,
          )}
          hint={t('الوسيط')}
          onClick={() => onDrilldown('answered')}
        />
        <MetricTile
          label={t('سرعة الحل')}
          value={formatDuration(report.resolutionMedianMinutes, t)}
          changePct={durationChangePct(
            report.resolutionMedianMinutes,
            report.resolutionPreviousMinutes,
          )}
          hint={t('الوسيط')}
          onClick={() => onDrilldown('resolved')}
        />
        <MetricTile
          label={t('حجم الرسائل')}
          value={(volume?.value ?? 0).toLocaleString('en-US')}
          changePct={volume?.changePct}
        />
      </div>

      <ChartCard
        title={t('الحجم عبر الزمن')}
        filename="rabitech-message-volume"
        data={chartData}
        groupBy={groupBy}
        onGroupByChange={onGroupByChange}
        groupByOptions={series.map((item) => ({ value: item.key, label: item.label }))}
      >
        <LineChart series={visibleSeries} exportName="rabitech-conversations" />
      </ChartCard>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {rest.map((headline) => {
          const metric = HEADLINE_DRILLDOWN[headline.key];
          return (
            <MetricTile
              key={headline.key}
              label={t(HEADLINE_LABEL[headline.key] ?? headline.key)}
              value={headline.value.toLocaleString('en-US')}
              changePct={headline.changePct}
              onClick={metric ? () => onDrilldown(metric) : undefined}
            />
          );
        })}
      </div>
    </>
  );
}

function DurationSummary({ stats }: { stats: ConversationsReport['firstResponse'] }) {
  const { t } = useT();
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div>
          <p className="text-caption text-muted-foreground">{t('الوسيط')}</p>
          <p className="numeric text-h1 font-bold">{formatDuration(stats.medianMinutes, t)}</p>
        </div>
        <div>
          <p className="text-caption text-muted-foreground">{t('المتوسط')}</p>
          <p className="numeric text-h1 font-bold">{formatDuration(stats.meanMinutes, t)}</p>
        </div>
        <div>
          <p className="text-caption text-muted-foreground">{t('الشريحة ٩٠')}</p>
          <p className="numeric text-h1 font-bold">{formatDuration(stats.p90Minutes, t)}</p>
        </div>
      </div>
      <DistributionBars buckets={stats.buckets} labelFor={(l) => t(BUCKET_LABEL[l] ?? l)} />
      {stats.truncated && (
        <p className="mt-3 text-caption text-warning">{t('عيّنة جزئية — الفترة أوسع من الحد')}</p>
      )}
    </>
  );
}

function ConversationsTab({
  report,
  loading,
}: {
  report: ConversationsReport | null;
  loading: boolean;
}) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReportCard title={t('زمن أول رد')}>
          <DurationSummary stats={report.firstResponse} />
        </ReportCard>
        <ReportCard title={t('زمن الحل')}>
          <DurationSummary stats={report.resolution} />
        </ReportCard>
      </div>
      <ReportCard title={t('الحجم حسب ساعات اليوم')}>
        <VolumeHeatmap cells={report.heatmap} />
      </ReportCard>
    </>
  );
}

function TeamTab({
  rows,
  loading,
  search,
  onSearch,
  onDrilldown,
}: {
  rows: TeamReportRow[] | null;
  loading: boolean;
  search: string;
  onSearch: (v: string) => void;
  onDrilldown: (agentId: string) => void;
}) {
  const { t } = useT();

  return (
    <ReportCard
      title={t('أداء الوكلاء')}
      action={
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('بحث بالاسم')}
          className="h-7 w-32 rounded-md border border-border bg-background px-2 text-caption outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      }
    >
      {!rows ? (
        loading ? (
          <Loading />
        ) : (
          <EmptyNote />
        )
      ) : rows.length === 0 ? (
        <EmptyNote />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-h3">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="px-3 py-2 text-start font-medium">{t('الوكيل')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('رسائل')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('محادثات')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('محلولة')}</th>
                <th className="px-3 py-2 text-center font-medium">{t('وسيط أول رد')}</th>
                <th className="px-3 py-2 text-center font-medium">CSAT</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border/40">
                  <td className="px-3 py-2">
                    <span className="font-medium">{row.name}</span>
                    {row.team && (
                      <span className="ms-2 text-caption text-muted-foreground">{row.team.name}</span>
                    )}
                  </td>
                  <td className="numeric px-3 py-2 text-center">{row.messagesSent}</td>
                  <td className="numeric px-3 py-2 text-center">{row.conversationsHandled}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => onDrilldown(row.id)}
                      className="numeric font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {row.resolved}
                    </button>
                  </td>
                  <td className="numeric px-3 py-2 text-center">
                    {formatDuration(row.medianFirstResponseMinutes, t)}
                  </td>
                  <td className="numeric px-3 py-2 text-center">
                    {row.csatAvg ?? '—'}
                    {row.csatCount > 0 && (
                      <span className="ms-1 text-micro text-muted-foreground">({row.csatCount})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ReportCard>
  );
}

function CampaignsTab({
  rows,
  loading,
  onOpenReplies,
}: {
  rows: CampaignReportRow[] | null;
  loading: boolean;
  /** Open the threads behind a reply count. */
  onOpenReplies: (campaignId: string) => void;
}) {
  const { t } = useT();
  if (!rows) return loading ? <Loading /> : <EmptyNote />;
  if (rows.length === 0) return <EmptyNote />;

  const pct = (part: number, whole: number) =>
    whole === 0 ? null : Math.round((part / whole) * 1000) / 10;

  return (
    <ReportCard title={t('أداء الحملات')}>
      <div className="overflow-x-auto">
        <table className="w-full text-h3">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th className="px-3 py-2 text-start font-medium">{t('الحملة')}</th>
              <th className="px-3 py-2 text-center font-medium">{t('المستلمون')}</th>
              <th className="px-3 py-2 text-center font-medium">{t('وصلت')}</th>
              <th className="px-3 py-2 text-center font-medium">{t('قُرئت')}</th>
              <th className="px-3 py-2 text-center font-medium">{t('فشلت')}</th>
              <th className="px-3 py-2 text-center font-medium">{t('ردّوا')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/40">
                <td className="px-3 py-2">
                  <span className="font-medium">{row.title}</span>
                  {row.sentAt && (
                    <span className="numeric ms-2 text-caption text-muted-foreground" dir="ltr">
                      {row.sentAt.slice(0, 10)}
                    </span>
                  )}
                </td>
                <td className="numeric px-3 py-2 text-center">{row.recipients}</td>
                <td className="numeric px-3 py-2 text-center">
                  {row.delivered}
                  <span className="ms-1 text-micro text-muted-foreground">
                    {formatPct(pct(row.delivered, row.recipients))}
                  </span>
                </td>
                <td className="numeric px-3 py-2 text-center">
                  {row.read}
                  <span className="ms-1 text-micro text-muted-foreground">
                    {formatPct(pct(row.read, row.recipients))}
                  </span>
                </td>
                <td className="numeric px-3 py-2 text-center text-destructive">{row.failed}</td>
                <td className="numeric px-3 py-2 text-center">
                  {/*
                    The count is the way into the answers. Reading them is why
                    the broadcast was sent, and they were reachable only by
                    remembering names and searching the inbox one at a time.
                  */}
                  {row.replied > 0 ? (
                    <button
                      type="button"
                      onClick={() => onOpenReplies(row.id)}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {row.replied}
                      <span className="ms-1 text-micro opacity-70">
                        {formatPct(pct(row.replied, row.recipients))}
                      </span>
                    </button>
                  ) : (
                    <>
                      {row.replied}
                      <span className="ms-1 text-micro text-muted-foreground">
                        {formatPct(pct(row.replied, row.recipients))}
                      </span>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-caption text-muted-foreground">
        {t('«ردّوا» = جهات اتصال أرسلت رسالة بعد إرسال الحملة')}
      </p>
    </ReportCard>
  );
}

function GatewayTab({
  report,
  sessions,
  loading,
}: {
  report: GatewayReport | null;
  sessions: Session[];
  loading: boolean;
}) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  const liveOf = (label: string) =>
    sessions.find((s) => (s.label || s.sessionName) === label)?.connected;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricTile label={t('رسائل صادرة')} value={report.outbound.total.toLocaleString('en-US')} />
        <MetricTile
          label={t('نسبة الفشل')}
          value={formatPct(report.outbound.failureRatePct)}
          hint={t('الجلسة السليمة لا تثبت أن الإرسال يعمل')}
        />
        <MetricTile label={t('رسائل فاشلة')} value={report.outbound.failed.toLocaleString('en-US')} />
        <MetricTile
          label={t('نسبة الردود الآلية')}
          value={formatPct(report.automation.automatedRatePct)}
        />
      </div>

      <ReportCard title={t('جلسات واتساب')}>
        {report.sessions.length === 0 ? (
          <EmptyNote />
        ) : (
          <div className="space-y-2">
            {report.sessions.map((session) => {
              const connected = liveOf(session.label);
              return (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-h3"
                >
                  <span>
                    {session.label}
                    {session.phoneNumber && (
                      <span className="numeric ms-2 text-caption text-muted-foreground" dir="ltr">
                        {session.phoneNumber}
                      </span>
                    )}
                  </span>
                  {connected === undefined ? (
                    <span className="text-caption text-muted-foreground">{t('غير معروف')}</span>
                  ) : connected ? (
                    <Wifi className="h-4 w-4 text-success" />
                  ) : (
                    <WifiOff className="h-4 w-4 text-destructive" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ReportCard>
    </>
  );
}

const DIRECTION_LABEL: Record<string, string> = {
  INBOUND: 'وارد (من البوابة)',
  OUTBOUND: 'صادر (إلى نقاط النهاية)',
};

/**
 * How conversations ended, and by what.
 *
 * The server's contract is that every breakdown reconciles to `total` — its own
 * note says a report whose parts disagree with its whole is worse than no
 * report, because it gets quoted. Two things here exist to keep that true:
 *
 * The uncategorised bucket is **rendered, never dropped**. Closures made
 * without a category are real closures; filtering them would leave a tidier
 * list that no longer adds up to the number printed above it.
 *
 * And the reconciliation is *shown* rather than assumed. If a breakdown ever
 * stops summing to the total, the operator reading the report is the one who
 * needs to know first — a silent discrepancy is how a wrong number gets quoted
 * to a customer.
 */
/**
 * Where the contacts gained in this period now stand.
 *
 * Deliberately **not** drawn as a conversion funnel. A contact holds one stage
 * and no history is kept, so a step-to-step rate would be fabricated: someone
 * now at Customer is absent from Lead, and the gap between them would read as
 * drop-off that never occurred. What the data supports is a distribution, so a
 * distribution is what this draws.
 *
 * The single honest conversion number is the won stage over the period's
 * intake — both sides of that ratio are real — and it is the only one shown.
 *
 * Pipeline order is preserved rather than sorted by count, because the order
 * *is* the pipeline; and stages nobody has reached are kept at zero, since an
 * empty step is precisely where the reader should be looking.
 */
function LifecycleTab({ report, loading }: { report: LifecycleFunnel | null; loading: boolean }) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  const stageSum = report.stages.reduce((s, r) => s + r.count, 0);
  const lostSum = report.lost.reduce((s, r) => s + r.count, 0);
  const reconciles = stageSum + lostSum + report.unassigned === report.total;

  const won = report.stages.find((s) => s.isWon);
  const pct = (n: number) => (report.total === 0 ? 0 : Math.round((n / report.total) * 100));

  const label = (row: FunnelStageRow) => (row.emoji ? `${row.emoji} ${row.name}` : row.name);

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricTile label={t('جهات اتصال جديدة')} value={report.total.toLocaleString()} />
        <MetricTile
          label={t('وصلوا للمرحلة النهائية')}
          value={won ? won.count.toLocaleString() : '—'}
          hint={won ? `${pct(won.count)}%` : undefined}
        />
        <MetricTile
          label={t('بدون مرحلة')}
          value={report.unassigned.toLocaleString()}
          hint={`${pct(report.unassigned)}%`}
        />
      </div>

      {!reconciles && (
        <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
          {t('تفاصيل هذا التقرير لا تطابق الإجمالي. لا تعتمد عليه حتى تتم مراجعته.')}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ReportCard title={t('التوزيع على المراحل')}>
          {/* Order is the pipeline. The unassigned bucket rides along so the
              bars account for every contact counted above them. */}
          <DistributionBars
            buckets={[
              ...report.stages.map((row) => ({ label: label(row), count: row.count })),
              ...(report.unassigned > 0
                ? [{ label: t('بدون مرحلة'), count: report.unassigned }]
                : []),
            ]}
            labelFor={(l) => l}
          />
        </ReportCard>
        <ReportCard title={t('أسباب الخروج')}>
          <DistributionBars
            buckets={report.lost.map((row) => ({ label: label(row), count: row.count }))}
            labelFor={(l) => l}
          />
        </ReportCard>
      </div>
    </>
  );
}

function ClosuresTab({ report, loading }: { report: ClosureReport | null; loading: boolean }) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  const sourceLabel: Record<string, string> = {
    MANUAL: 'يدوي',
    AUTO_CLOSE: 'إغلاق تلقائي',
    WORKFLOW: 'مسار عمل',
    API: 'واجهة برمجية',
    MERGE: 'دمج',
  };

  const categoryBuckets = report.byCategory.map((row) => ({
    // The null key is the uncategorised bucket, labelled here rather than
    // hidden. Resolved at this point instead of through a sentinel string in
    // labelFor: a sentinel is a value a real category name could one day
    // collide with, and null is the only thing that actually means it.
    label: row.key ?? t('بدون تصنيف'),
    count: row.count,
  }));
  const sourceBuckets = report.bySource.map((row) => ({ label: row.key, count: row.count }));

  const sums = (rows: { count: number }[]) => rows.reduce((s, r) => s + r.count, 0);
  const categorySum = sums(report.byCategory);
  const sourceSum = sums(report.bySource);
  const summarySum = report.summaries.withSummary + report.summaries.withoutSummary;
  const reconciles =
    categorySum === report.total && sourceSum === report.total && summarySum === report.total;

  const summaryPct = report.total === 0
    ? 0
    : Math.round((report.summaries.withSummary / report.total) * 100);

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricTile label={t('محادثات مغلقة')} value={report.total.toLocaleString()} />
        <MetricTile
          label={t('مع ملخص')}
          value={report.summaries.withSummary.toLocaleString()}
          hint={`${summaryPct}%`}
        />
        <MetricTile
          label={t('بدون ملخص')}
          value={report.summaries.withoutSummary.toLocaleString()}
        />
      </div>

      {!reconciles && (
        <p className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning">
          {t('تفاصيل هذا التقرير لا تطابق الإجمالي. لا تعتمد عليه حتى تتم مراجعته.')}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <ReportCard title={t('حسب التصنيف')}>
          <DistributionBars
            buckets={categoryBuckets}
            labelFor={(label) => label}
          />
        </ReportCard>
        <ReportCard title={t('حسب طريقة الإغلاق')}>
          <DistributionBars
            buckets={sourceBuckets}
            labelFor={(label) => t(sourceLabel[label] ?? label)}
          />
        </ReportCard>
      </div>
    </>
  );
}

function WebhooksTab({ report, loading }: { report: WebhookReport | null; loading: boolean }) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  return (
    <>
      {/* Split by direction throughout: averaging them would hide the one that
          matters. Outbound failing means a subscriber endpoint is down; inbound
          failing means we have stopped receiving WhatsApp traffic at all. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {report.directions.map((d) => (
          <div key={d.direction} className="rounded-lg border border-border bg-card p-4">
            <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
              {t(DIRECTION_LABEL[d.direction] ?? d.direction)}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <p className="text-caption text-muted-foreground">{t('نسبة النجاح')}</p>
                <p
                  className={cn(
                    'numeric text-h1 font-bold',
                    d.successRatePct !== null && d.successRatePct < 95 && 'text-destructive',
                  )}
                >
                  {formatPct(d.successRatePct)}
                </p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground">{t('الوسيط')}</p>
                <p className="numeric text-h1 font-bold">{d.medianLatencyMs ?? '—'}ms</p>
              </div>
              <div>
                <p className="text-caption text-muted-foreground">{t('الشريحة ٩٠')}</p>
                <p className="numeric text-h1 font-bold">{d.p90LatencyMs ?? '—'}ms</p>
              </div>
            </div>
            <p className="mt-2 text-caption text-muted-foreground">
              <span className="numeric">{d.total.toLocaleString('en-US')}</span> {t('عملية تسليم')} ·{' '}
              <span className="numeric">{d.failed.toLocaleString('en-US')}</span> {t('فاشلة')}
            </p>
            {d.total === 0 && (
              // A gateway that has gone silent shows no failures at all, which
              // would otherwise read as a flawless record.
              <p className="mt-1 text-caption text-warning">{t('لا توجد عمليات تسليم مسجّلة')}</p>
            )}
          </div>
        ))}
      </div>

      <ReportCard title={t('نقاط النهاية')}>
        {report.endpoints.length === 0 ? (
          <EmptyNote />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-h3">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="px-3 py-2 text-start font-medium">{t('الوجهة')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('عمليات التسليم')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('فشلت')}</th>
                  <th className="px-3 py-2 text-center font-medium">{t('نسبة النجاح')}</th>
                </tr>
              </thead>
              <tbody>
                {report.endpoints.map((endpoint) => (
                  <tr key={endpoint.webhookId} className="border-b border-border/40">
                    <td className="px-3 py-2">
                      <span className="font-medium" dir="ltr">
                        {endpoint.targetHost || t('البوابة')}
                      </span>
                    </td>
                    <td className="numeric px-3 py-2 text-center">{endpoint.total}</td>
                    <td className="numeric px-3 py-2 text-center text-destructive">
                      {endpoint.failed}
                    </td>
                    <td className="numeric px-3 py-2 text-center">
                      {formatPct(endpoint.successRatePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ReportCard>

      <ReportCard title={t('آخر حالات الفشل')}>
        {report.failures.length === 0 ? (
          <EmptyNote />
        ) : (
          <ul className="divide-y divide-border">
            {report.failures.map((failure) => (
              <li key={failure.id} className="py-2 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-micro font-medium text-destructive">
                    {failure.statusCode ?? t('بلا استجابة')}
                  </span>
                  <span className="text-caption font-medium" dir="ltr">
                    {failure.targetHost || t('البوابة')}
                  </span>
                  <span className="text-caption text-muted-foreground">{failure.eventType}</span>
                  <span className="numeric ms-auto text-micro text-muted-foreground" dir="ltr">
                    {failure.createdAt.slice(0, 19).replace('T', ' ')}
                  </span>
                </div>
                {failure.errorMessage && (
                  <p className="mt-1 truncate text-caption text-muted-foreground" dir="ltr">
                    {failure.errorMessage}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-caption text-muted-foreground">
          {t('يُحتفظ بالسجلات لمدة')} <span className="numeric">{report.retentionDays}</span>{' '}
          {t('يوم')}
        </p>
      </ReportCard>
    </>
  );
}
