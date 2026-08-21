'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, Megaphone, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import {
  fetchCampaignsReport,
  fetchConversationsReport,
  fetchGatewayReport,
  fetchOverviewReport,
  fetchSessions,
  fetchTeamReport,
  fetchTeams,
  type CampaignReportRow,
  type ConversationsReport,
  type DrilldownMetric,
  type GatewayReport,
  type OverviewReport,
  type ReportRange,
  type Session,
  type Team,
  type TeamReportRow,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DistributionBars,
  EmptyNote,
  MetricTile,
  ReportCard,
  Sparkline,
  formatDuration,
  formatPct,
} from '@/components/reports/primitives';
import { VolumeHeatmap } from '@/components/reports/heatmap';
import { DrilldownPanel } from '@/components/reports/drilldown-panel';

/**
 * Reports (M7).
 *
 * Five surfaces, one question each, rather than one page that answers none of
 * them well:
 *
 * - **Overview** — is the operation growing, and against what?
 * - **Conversations** — how fast do we answer, and when are we busy?
 * - **Team** — who is carrying the load?
 * - **Campaigns** — did the broadcast do anything?
 * - **Gateway** — is the channel actually working?
 *
 * Each tab fetches only when it is opened. The tabs are independent queries and
 * loading all five on mount would make the slowest one the cost of the page.
 */

type TabKey = 'overview' | 'conversations' | 'team' | 'campaigns' | 'gateway';

const RANGES = [
  { days: 7, label: 'آخر ٧ أيام' },
  { days: 30, label: 'آخر ٣٠ يوم' },
  { days: 90, label: 'آخر ٩٠ يوم' },
] as const;

const BUCKET_LABEL: Record<string, string> = {
  under_5m: 'أقل من ٥ دقائق',
  under_15m: 'أقل من ١٥ دقيقة',
  under_1h: 'أقل من ساعة',
  under_4h: 'أقل من ٤ ساعات',
  under_24h: 'أقل من ٢٤ ساعة',
  over_24h: 'أكثر من ٢٤ ساعة',
};

const HEADLINE_LABEL: Record<string, string> = {
  conversationsStarted: 'محادثات بدأت',
  conversationsResolved: 'محادثات حُلّت',
  inbound: 'رسائل واردة',
  outbound: 'رسائل صادرة',
  contactsAdded: 'جهات اتصال جديدة',
};

/** Which headline tiles can be opened, and as what. */
const HEADLINE_DRILLDOWN: Record<string, DrilldownMetric | undefined> = {
  conversationsStarted: 'started',
  conversationsResolved: 'resolved',
};

export default function ReportsPage() {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>('overview');
  const [days, setDays] = useState<number>(30);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [drilldown, setDrilldown] = useState<{ metric: DrilldownMetric; agentId?: string } | null>(
    null,
  );

  const range = useMemo<ReportRange>(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 3600_000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [days]);

  const [overview, setOverview] = useState<OverviewReport | null>(null);
  const [conversations, setConversations] = useState<ConversationsReport | null>(null);
  const [team, setTeam] = useState<TeamReportRow[] | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignReportRow[] | null>(null);
  const [gateway, setGateway] = useState<GatewayReport | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);

  const [teams, setTeams] = useState<Team[]>([]);
  const [teamFilter, setTeamFilter] = useState('');
  const [teamSearch, setTeamSearch] = useState('');

  useEffect(() => {
    fetchTeams().then(setTeams).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      if (tab === 'overview') setOverview(await fetchOverviewReport(range));
      if (tab === 'conversations') setConversations(await fetchConversationsReport(range));
      if (tab === 'team') {
        const res = await fetchTeamReport(range, {
          teamId: teamFilter || undefined,
          q: teamSearch.trim() || undefined,
        });
        setTeam(res.agents);
      }
      if (tab === 'campaigns') setCampaigns((await fetchCampaignsReport(range)).campaigns);
      if (tab === 'gateway') {
        // Stored session state and live connectivity come from different places
        // on purpose — a cached copy of "connected" is the more convincing of
        // the two and the wrong one.
        const [report, live] = await Promise.all([fetchGatewayReport(range), fetchSessions()]);
        setGateway(report);
        setSessions(live);
      }
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [tab, range, teamFilter, teamSearch]);

  useEffect(() => {
    load();
  }, [load]);

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'overview', label: 'نظرة عامة' },
    { key: 'conversations', label: 'المحادثات' },
    { key: 'team', label: 'الفريق' },
    { key: 'campaigns', label: 'الحملات' },
    { key: 'gateway', label: 'حالة القناة' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-extrabold">{t('التقارير')}</h1>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                onClick={() => setDays(r.days)}
                className={cn(
                  'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
                  days === r.days
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent',
                )}
              >
                {t(r.label)}
              </button>
            ))}
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      <nav className="mb-4 flex flex-wrap gap-1 border-b border-border">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
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
        <p className="py-10 text-center text-sm text-destructive">{t('تعذّر جلب التقرير')}</p>
      ) : (
        <div className="space-y-4">
          {tab === 'overview' && (
            <OverviewTab
              report={overview}
              loading={loading}
              onDrilldown={(metric) => setDrilldown({ metric })}
            />
          )}

          {tab === 'conversations' && <ConversationsTab report={conversations} loading={loading} />}

          {tab === 'team' && (
            <TeamTab
              rows={team}
              loading={loading}
              teams={teams}
              teamFilter={teamFilter}
              onTeamFilter={setTeamFilter}
              search={teamSearch}
              onSearch={setTeamSearch}
              onDrilldown={(agentId) => setDrilldown({ metric: 'resolved', agentId })}
            />
          )}

          {tab === 'campaigns' && <CampaignsTab rows={campaigns} loading={loading} />}

          {tab === 'gateway' && (
            <GatewayTab report={gateway} sessions={sessions} loading={loading} />
          )}
        </div>
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
  return <p className="py-10 text-center text-sm text-muted-foreground">{t('جاري التحميل...')}</p>;
}

function OverviewTab({
  report,
  loading,
  onDrilldown,
}: {
  report: OverviewReport | null;
  loading: boolean;
  onDrilldown: (metric: DrilldownMetric) => void;
}) {
  const { t } = useT();
  if (!report) return loading ? <Loading /> : <EmptyNote />;

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {report.headlines.map((headline) => {
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ReportCard title={t('الرسائل الواردة')}>
          <Sparkline points={report.series} valueOf={(p) => p.inbound} />
        </ReportCard>
        <ReportCard title={t('الرسائل الصادرة')}>
          <Sparkline points={report.series} valueOf={(p) => p.outbound} />
        </ReportCard>
        <ReportCard title={t('محادثات حُلّت')}>
          <Sparkline points={report.series} valueOf={(p) => p.resolved} />
        </ReportCard>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link href="/inbox">
            <MessageSquare className="me-1.5 h-3.5 w-3.5" />
            {t('الرسائل')}
          </Link>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <Link href="/campaigns">
            <Megaphone className="me-1.5 h-3.5 w-3.5" />
            {t('الحملات')}
          </Link>
        </Button>
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
          <p className="text-[11px] text-muted-foreground">{t('الوسيط')}</p>
          <p className="numeric text-lg font-bold">{formatDuration(stats.medianMinutes, t)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">{t('المتوسط')}</p>
          <p className="numeric text-lg font-bold">{formatDuration(stats.meanMinutes, t)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted-foreground">{t('الشريحة ٩٠')}</p>
          <p className="numeric text-lg font-bold">{formatDuration(stats.p90Minutes, t)}</p>
        </div>
      </div>
      <DistributionBars buckets={stats.buckets} labelFor={(l) => t(BUCKET_LABEL[l] ?? l)} />
      {stats.truncated && (
        <p className="mt-3 text-[11px] text-warning">{t('عيّنة جزئية — الفترة أوسع من الحد')}</p>
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
  teams,
  teamFilter,
  onTeamFilter,
  search,
  onSearch,
  onDrilldown,
}: {
  rows: TeamReportRow[] | null;
  loading: boolean;
  teams: Team[];
  teamFilter: string;
  onTeamFilter: (v: string) => void;
  search: string;
  onSearch: (v: string) => void;
  onDrilldown: (agentId: string) => void;
}) {
  const { t } = useT();

  return (
    <ReportCard
      title={t('أداء الوكلاء')}
      action={
        <div className="flex items-center gap-2">
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t('بحث بالاسم')}
            className="h-7 w-32 rounded-md border border-border bg-background px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <select
            value={teamFilter}
            onChange={(e) => onTeamFilter(e.target.value)}
            className="select-field-sm"
          >
            <option value="">{t('كل الفرق')}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
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
          <table className="w-full text-xs">
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
                      <span className="ms-2 text-[11px] text-muted-foreground">{row.team.name}</span>
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
                      <span className="ms-1 text-[10px] text-muted-foreground">
                        ({row.csatCount})
                      </span>
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

function CampaignsTab({ rows, loading }: { rows: CampaignReportRow[] | null; loading: boolean }) {
  const { t } = useT();
  if (!rows) return loading ? <Loading /> : <EmptyNote />;
  if (rows.length === 0) return <EmptyNote />;

  const pct = (part: number, whole: number) => (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

  return (
    <ReportCard title={t('أداء الحملات')}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
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
                    <span className="numeric ms-2 text-[11px] text-muted-foreground" dir="ltr">
                      {row.sentAt.slice(0, 10)}
                    </span>
                  )}
                </td>
                <td className="numeric px-3 py-2 text-center">{row.recipients}</td>
                <td className="numeric px-3 py-2 text-center">
                  {row.delivered}
                  <span className="ms-1 text-[10px] text-muted-foreground">
                    {formatPct(pct(row.delivered, row.recipients))}
                  </span>
                </td>
                <td className="numeric px-3 py-2 text-center">
                  {row.read}
                  <span className="ms-1 text-[10px] text-muted-foreground">
                    {formatPct(pct(row.read, row.recipients))}
                  </span>
                </td>
                <td className="numeric px-3 py-2 text-center text-destructive">{row.failed}</td>
                <td className="numeric px-3 py-2 text-center">
                  {row.replied}
                  <span className="ms-1 text-[10px] text-muted-foreground">
                    {formatPct(pct(row.replied, row.recipients))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
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
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-xs"
                >
                  <span>
                    {session.label}
                    {session.phoneNumber && (
                      <span className="numeric ms-2 text-[11px] text-muted-foreground" dir="ltr">
                        {session.phoneNumber}
                      </span>
                    )}
                  </span>
                  {connected === undefined ? (
                    <span className="text-[11px] text-muted-foreground">{t('غير معروف')}</span>
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
