'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CalendarClock, ContactRound, MessagesSquare, UsersRound } from 'lucide-react';
import {
  fetchCampaigns,
  fetchDashboardSummary,
  fetchLifecycleStages,
  fetchOverviewReport,
  fetchOrganizationUsers,
  type Campaign,
  type DashboardSummary,
  type LifecycleStage,
  type OverviewReport,
  type ReportRange,
  type OrganizationUsersResponse,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { resolveReportPreset } from '@/components/reports/filter-bar';
import { ChartCard } from '@/components/reports/primitives';
import { LineChart, type Series } from '@/components/reports/line-chart';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/operational-state';

type Resource<T> =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; data: T };

const LOADING: Resource<never> = { status: 'loading' };

function DashboardPanel<T>({
  title,
  icon: Icon,
  resource,
  onRetry,
  isEmpty,
  emptyTitle,
  children,
}: {
  title: string;
  icon: typeof ContactRound;
  resource: Resource<T>;
  onRetry: () => void;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  children: (data: T) => ReactNode;
}) {
  const { t } = useT();

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      </header>
      <div className="p-4">
        {resource.status === 'loading' && (
          <div role="status" aria-busy="true" aria-label={t('جارٍ التحميل')} className="space-y-3">
            <SkeletonBlock className="h-9 w-1/3" />
            <SkeletonBlock className="h-4 w-2/3" />
            <SkeletonBlock className="h-3 w-full" />
          </div>
        )}
        {resource.status === 'error' && (
          <ErrorState
            title={t('تعذر تحميل لوحة التحكم')}
            description={t('تحقق من الاتصال وحاول مرة أخرى')}
            retryLabel={t('حاول مرة أخرى')}
            onRetry={onRetry}
            compact
          />
        )}
        {resource.status === 'ready' && isEmpty?.(resource.data) && (
          <EmptyState title={emptyTitle || t('لا توجد بيانات في هذه الفترة')} compact />
        )}
        {resource.status === 'ready' && !isEmpty?.(resource.data) && children(resource.data)}
      </div>
    </section>
  );
}

function MetricValue({ value, link, linkLabel, detail }: { value: number; link: string; linkLabel: string; detail?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <div className="numeric text-3xl font-extrabold leading-none">{value}</div>
        {detail && <div className="mt-2 text-caption text-muted-foreground">{detail}</div>}
      </div>
      <Link href={link} className="inline-flex items-center gap-1 text-caption font-medium text-primary hover:underline">
        {linkLabel}
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function conversationSeries(report: OverviewReport, t: (key: string) => string): Series[] {
  return [
    { key: 'started', label: t('المحادثات التي بدأت'), color: '#2563eb', points: report.series.map((point) => ({ date: point.date, value: point.conversationsStarted })) },
    { key: 'resolved', label: t('المحادثات التي حُلّت'), color: '#047857', points: report.series.map((point) => ({ date: point.date, value: point.resolved })) },
  ];
}

export default function OverviewPage() {
  const { t, locale } = useT();
  const range = useMemo<ReportRange>(() => {
    const resolved = resolveReportPreset('last_7_days');
    return { from: resolved.from, to: resolved.to };
  }, []);
  const [summary, setSummary] = useState<Resource<DashboardSummary>>(LOADING);
  const [lifecycle, setLifecycle] = useState<Resource<LifecycleStage[]>>(LOADING);
  const [users, setUsers] = useState<Resource<OrganizationUsersResponse>>(LOADING);
  const [overview, setOverview] = useState<Resource<OverviewReport>>(LOADING);
  const [campaigns, setCampaigns] = useState<Resource<Campaign[]>>(LOADING);
  const [groupBy, setGroupBy] = useState('');

  const load = useCallback(() => {
    setSummary(LOADING);
    setLifecycle(LOADING);
    setUsers(LOADING);
    setOverview(LOADING);
    setCampaigns(LOADING);

    const request = <T,>(fetcher: () => Promise<T>, setter: (resource: Resource<T>) => void) => {
      fetcher()
        .then((data) => setter({ status: 'ready', data }))
        .catch(() => setter({ status: 'error' }));
    };

    request(fetchDashboardSummary, setSummary);
    request(fetchLifecycleStages, setLifecycle);
    request(fetchOrganizationUsers, setUsers);
    request(() => fetchOverviewReport(range), setOverview);
    request(fetchCampaigns, setCampaigns);
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const activeCampaigns = campaigns.status === 'ready'
    ? campaigns.data.filter((campaign) => campaign.status === 'SCHEDULED' && campaign.scheduledAt && new Date(campaign.scheduledAt).getTime() > Date.now()).slice(0, 5)
    : [];

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-h1 font-extrabold">{t('لوحة التحكم')}</h1>
          <p className="mt-1 text-small text-muted-foreground">{t('ملخص المؤسسة')}</p>
        </div>
        <span className="text-caption text-muted-foreground">{t('آخر ٧ أيام')}</span>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <DashboardPanel title={t('جهات الاتصال')} icon={ContactRound} resource={summary} onRetry={load} isEmpty={(data) => data.totalContacts === 0} emptyTitle={t('لا توجد جهات اتصال')}>
          {(data) => <MetricValue value={data.totalContacts} link="/contacts" linkLabel={t('فتح جهات الاتصال')} />}
        </DashboardPanel>
        <DashboardPanel title={t('المحادثات المفتوحة')} icon={MessagesSquare} resource={summary} onRetry={load}>
          {(data) => <MetricValue value={data.openConversations} link="/inbox" linkLabel={t('فتح المحادثات')} detail={`${data.resolvedThisWeek} ${t('محادثات حُلّت هذا الأسبوع')}`} />}
        </DashboardPanel>
        <DashboardPanel title={t('قنوات نشطة')} icon={CalendarClock} resource={summary} onRetry={load} isEmpty={(data) => data.activeSessions === 0} emptyTitle={t('لا توجد قنوات نشطة')}>
          {(data) => <MetricValue value={data.activeSessions} link="/settings/channels" linkLabel={t('فتح الإعدادات')} />}
        </DashboardPanel>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DashboardPanel title={t('مراحل دورة الحياة')} icon={ContactRound} resource={lifecycle} onRetry={load} isEmpty={(data) => data.length === 0} emptyTitle={t('لا توجد مراحل دورة حياة')}>
          {(stages) => {
            const maximum = Math.max(1, ...stages.map((stage) => stage.contactCount));
            return (
              <div className="space-y-3">
                {stages.map((stage) => (
                  <div key={stage.id}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-small">
                      <span className="min-w-0 truncate">{stage.emoji ? `${stage.emoji} ` : ''}{stage.name}</span>
                      <span className="numeric shrink-0 font-semibold">{stage.contactCount}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted" aria-label={`${stage.name}: ${stage.contactCount}`}>
                      <div className="h-full rounded-full bg-primary" style={{ width: `${(stage.contactCount / maximum) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            );
          }}
        </DashboardPanel>

        <DashboardPanel title={t('أعضاء الفريق')} icon={UsersRound} resource={users} onRetry={load} isEmpty={(data) => data.users.length === 0} emptyTitle={t('لا يوجد أعضاء فريق')}>
          {(data) => {
            const active = data.users.filter((user) => user.isActive);
            return (
              <div>
                <div className="flex items-end justify-between gap-3">
                  <div className="numeric text-3xl font-extrabold leading-none">{active.length}</div>
                  <span className="text-caption text-muted-foreground">{t('نشط')}</span>
                </div>
                <div className="mt-3 border-t border-border pt-3 text-small text-muted-foreground">
                  {t('إجمالي الأعضاء')}: <span className="numeric font-semibold text-foreground">{data.users.length}</span>
                </div>
              </div>
            );
          }}
        </DashboardPanel>
      </div>

      {overview.status === 'loading' && (
        <section className="mt-3 rounded-lg border border-border bg-card p-4" role="status" aria-busy="true" aria-label={t('جارٍ التحميل')}>
          <SkeletonBlock className="h-5 w-1/4" />
          <SkeletonBlock className="mt-4 h-52 w-full" />
        </section>
      )}
      {overview.status === 'error' && (
        <section className="mt-3 rounded-lg border border-border bg-card">
          <ErrorState title={t('تعذر تحميل لوحة التحكم')} description={t('تحقق من الاتصال وحاول مرة أخرى')} retryLabel={t('حاول مرة أخرى')} onRetry={load} />
        </section>
      )}
      {overview.status === 'ready' && (
        <div className="mt-3">
          {(() => {
            const series = conversationSeries(overview.data, t);
            const visibleSeries = groupBy ? series.filter((item) => item.key === groupBy) : series;
            const chartData = overview.data.series.map((point) => ({
              date: point.date,
              started: point.conversationsStarted,
              resolved: point.resolved,
            }));
            return (
              <ChartCard
                title={t('المحادثات عبر الزمن')}
                filename="rabitech-conversations"
                data={chartData}
                groupBy={groupBy}
                onGroupByChange={setGroupBy}
                groupByOptions={series.map((item) => ({ value: item.key, label: item.label }))}
              >
                <LineChart series={visibleSeries} />
              </ChartCard>
            );
          })()}
        </div>
      )}

      <DashboardPanel title={t('البثوث القادمة')} icon={CalendarClock} resource={campaigns} onRetry={load} isEmpty={() => activeCampaigns.length === 0} emptyTitle={t('لا توجد بثوث مجدولة')}>
        {() => (
          <div className="divide-y divide-border">
            {activeCampaigns.map((campaign) => (
              <Link key={campaign.id} href="/campaigns" className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:text-primary">
                <span className="min-w-0 truncate font-medium">{campaign.title}</span>
                <span className="flex shrink-0 items-center gap-3 text-caption text-muted-foreground">
                  <span className="numeric">{campaign.scheduledAt ? dateFormatter.format(new Date(campaign.scheduledAt)) : ''}</span>
                  <span className="numeric">{campaign.recipients} {t('مستلم')}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </DashboardPanel>
    </div>
  );
}
