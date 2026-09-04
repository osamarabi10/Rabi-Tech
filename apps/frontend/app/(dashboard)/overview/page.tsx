'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, CalendarClock, Clock, ContactRound, MessagesSquare, UsersRound } from 'lucide-react';
import {
  fetchCampaigns,
  fetchContactMergeSuggestions,
  fetchConversationBuckets,
  fetchDashboardSummary,
  fetchDashboardTeam,
  fetchLifecycleStages,
  fetchOverviewReport,
  fetchWaitingContacts,
  type Campaign,
  type ContactMergeSuggestion,
  type ConversationBuckets,
  type DashboardSummary,
  type DashboardTeam,
  type LifecycleStage,
  type OverviewReport,
  type ReportRange,
  type WaitingContacts,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { resolveReportPreset } from '@/components/reports/filter-bar';
import { ChartCard } from '@/components/reports/primitives';
import { LineChart, type Series } from '@/components/reports/line-chart';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/operational-state';
import { MergeSuggestions } from '@/components/contacts/merge-suggestions';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

/*
  How long someone has been waiting, in the shortest form that is still exact.

  Rounded to the unit an operator acts on: minutes below an hour, hours below a
  day, days above. "127 minutes" is a number to convert; "2h" is a decision.
*/
function waitedFor(minutes: number, t: (s: string) => string): string {
  if (minutes < 1) return t('الآن');
  if (minutes < 60) return minutes + t('د');
  if (minutes < 60 * 24) return Math.floor(minutes / 60) + t('س');
  return Math.floor(minutes / (60 * 24)) + t('ي');
}

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
  const router = useRouter();
  const range = useMemo<ReportRange>(() => {
    const resolved = resolveReportPreset('last_7_days');
    return { from: resolved.from, to: resolved.to };
  }, []);
  const [summary, setSummary] = useState<Resource<DashboardSummary>>(LOADING);
  const [lifecycle, setLifecycle] = useState<Resource<LifecycleStage[]>>(LOADING);
  const [overview, setOverview] = useState<Resource<OverviewReport>>(LOADING);
  const [campaigns, setCampaigns] = useState<Resource<Campaign[]>>(LOADING);
  const [buckets, setBuckets] = useState<Resource<ConversationBuckets>>(LOADING);
  const [waiting, setWaiting] = useState<Resource<WaitingContacts>>(LOADING);
  const [team, setTeam] = useState<Resource<DashboardTeam>>(LOADING);
  const [merges, setMerges] = useState<Resource<ContactMergeSuggestion[]>>(LOADING);
  const [groupBy, setGroupBy] = useState('');
  const [teamFilter, setTeamFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(() => {
    setSummary(LOADING);
    setLifecycle(LOADING);
    setOverview(LOADING);
    setCampaigns(LOADING);
    setBuckets(LOADING);
    setWaiting(LOADING);
    setTeam(LOADING);
    setMerges(LOADING);

    const request = <T,>(fetcher: () => Promise<T>, setter: (resource: Resource<T>) => void) => {
      fetcher()
        .then((data) => setter({ status: 'ready', data }))
        .catch(() => setter({ status: 'error' }));
    };

    request(fetchDashboardSummary, setSummary);
    request(fetchLifecycleStages, setLifecycle);
    request(() => fetchOverviewReport(range), setOverview);
    request(fetchCampaigns, setCampaigns);
    request(fetchConversationBuckets, setBuckets);
    request(fetchWaitingContacts, setWaiting);
    request(fetchDashboardTeam, setTeam);
    request(fetchContactMergeSuggestions, setMerges);
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  /*
    Earliest first, which is the only order this panel can be read in: the top
    row is the next thing that will happen. The previous version took the first
    five in whatever order the list arrived, so the soonest broadcast could be
    absent from a panel titled "upcoming".
  */
  const activeCampaigns = campaigns.status === 'ready'
    ? campaigns.data
      .filter((campaign) => campaign.status === 'SCHEDULED' && campaign.scheduledAt && new Date(campaign.scheduledAt).getTime() > Date.now())
      .sort((a, b) => new Date(a.scheduledAt as string).getTime() - new Date(b.scheduledAt as string).getTime())
      .slice(0, 5)
    : [];

  const teamMembers = team.status === 'ready' ? team.data.members : [];
  const teamNames = Array.from(
    new Map(teamMembers.filter((m) => m.teamId).map((m) => [m.teamId as string, m.teamName || ''])).entries(),
  );
  const visibleMembers = teamMembers.filter((m) =>
    (!teamFilter || m.teamId === teamFilter) && (!statusFilter || m.status === statusFilter));

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
            /*
              The funnel headline, not a second funnel.

              The full lifecycle funnel already exists in Reports. Rebuilding it
              here would give two implementations of one calculation, free to
              disagree. This surfaces the one number that belongs on a summary
              screen and links to the funnel for everything else.

              The won stage is the one flagged `isWon`, never the last element of
              the array. The first version of this used array position and
              reported "0% reached Unqualified" against real data, because the
              stages run Contacted, Qualified, Lead, Customer, Unqualified and
              the terminal stage is not the final one. Order in a list is not a
              meaning; the flag is.
            */
            const total = stages.reduce((sum, stage) => sum + stage.contactCount, 0);
            const won = stages.find((stage) => stage.isWon) ?? null;
            const reachedPct = total > 0 && won ? Math.round((won.contactCount / total) * 100) : 0;
            return (
              <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-3">
                  <p className="text-caption text-muted-foreground">
                    <span className="text-h2 font-bold tabular-nums text-foreground">{reachedPct}%</span>
                    <span className="ms-2">{won ? `${t('وصلوا إلى')} ${won.name}` : t('لا توجد مرحلة فوز محددة')}</span>
                  </p>
                  <Link href="/reports" className="inline-flex items-center gap-1 text-caption font-medium text-primary hover:underline">
                    {t('القمع الكامل')}
                    <ArrowUpRight className="size-3.5" aria-hidden />
                  </Link>
                </div>
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

      </div>
      {/*
        The old Team Members card is gone rather than kept alongside the new one.

        It counted active users and nothing else. The widget below answers the
        same question and four more — presence, team, current workload, and
        filtering — so keeping both would put two cards with the same title on
        one screen, which is what looking at the rendered page actually showed.
      */}

      {/*
        Opened and closed, four windows.

        Two numbers per window rather than one net figure: an organization that
        opened forty and closed forty is not the same as one that opened none
        and closed none, and a single number cannot tell them apart.
      */}
      <div className="mt-3">
        <DashboardPanel title={t('المحادثات المفتوحة والمغلقة')} icon={MessagesSquare} resource={buckets} onRetry={load}>
          {(data) => {
            const windows: Array<{ key: string; label: string; bucket: typeof data.today }> = [
              { key: 'today', label: t('اليوم'), bucket: data.today },
              { key: 'yesterday', label: t('أمس'), bucket: data.yesterday },
              { key: 'last14', label: t('١٤ يوم'), bucket: data.last14Days },
              { key: 'last30', label: t('٣٠ يوم'), bucket: data.last30Days },
            ];
            return (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {windows.map((w) => (
                  <div key={w.key} className="rounded-lg border border-border p-3">
                    <p className="text-caption font-medium uppercase tracking-wide text-muted-foreground">{w.label}</p>
                    <div className="mt-2 flex items-baseline gap-4">
                      <span>
                        <span className="text-h2 font-bold tabular-nums">{w.bucket.opened}</span>
                        <span className="ms-1 text-caption text-muted-foreground">{t('فُتحت')}</span>
                      </span>
                      <span>
                        <span className="text-h2 font-bold tabular-nums text-success">{w.bucket.closed}</span>
                        <span className="ms-1 text-caption text-muted-foreground">{t('أُغلقت')}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            );
          }}
        </DashboardPanel>
      </div>

      {/*
        Widget 2 — who is waiting, longest first.

        Sorted by wait rather than recency because the question this panel
        answers is "who has been ignored longest", not "who wrote last". Blocked
        contacts are excluded by the endpoint: a blocked number is one an
        operator has decided not to deal with, so listing it as waiting work
        would be asking them to act on a decision they already made.
      */}
      <div className="mt-3">
        <DashboardPanel
          title={t('جهات اتصال بمحادثات مفتوحة')}
          icon={Clock}
          resource={waiting}
          onRetry={load}
          isEmpty={(data) => data.contacts.length === 0}
          emptyTitle={t('لا أحد ينتظر ردًا')}
        >
          {(data) => (
            <ul className="divide-y divide-border">
              {data.contacts.map((row) => (
                <li key={row.conversationId} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <Avatar className="size-8 shrink-0">
                    {row.profilePic && <AvatarImage src={row.profilePic} alt="" />}
                    <AvatarFallback>{(row.name || '?').slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-small font-medium">{row.name}</p>
                    <p className="truncate text-caption text-muted-foreground">{row.lastMessage || t('لا توجد رسالة واردة بعد')}</p>
                  </div>
                  <div className="shrink-0 text-end">
                    <p className="text-small font-semibold tabular-nums">{waitedFor(row.waitingSinceMinutes, t)}</p>
                    <p className="text-caption text-muted-foreground">{row.assigneeName || t('غير معيّن')}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>

      {/*
        Widget 3 — the team, filterable by team and by presence.

        assignedCount excludes blocked contacts, so it matches the queue an
        agent can actually work rather than their historical volume.
      */}
      <div className="mt-3">
        <DashboardPanel
          title={t('أعضاء الفريق')}
          icon={UsersRound}
          resource={team}
          onRetry={load}
          isEmpty={(data) => data.members.length === 0}
          emptyTitle={t('لا يوجد أعضاء فريق')}
        >
          {() => (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={t('تصفية حسب الفريق')}
                  value={teamFilter}
                  onChange={(event) => setTeamFilter(event.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-caption"
                >
                  <option value="">{t('كل الفرق')}</option>
                  {teamNames.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                </select>
                <select
                  aria-label={t('تصفية حسب الحالة')}
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1 text-caption"
                >
                  <option value="">{t('كل الحالات')}</option>
                  <option value="available">{t('متاح')}</option>
                  <option value="away">{t('غائب')}</option>
                </select>
              </div>
              {visibleMembers.length === 0 ? (
                <EmptyState title={t('لا أحد يطابق هذه التصفية')} compact />
              ) : (
                <ul className="divide-y divide-border">
                  {visibleMembers.map((member) => (
                    <li key={member.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span
                        aria-hidden
                        className={`size-2 shrink-0 rounded-full ${member.status === 'available' ? 'bg-success' : 'bg-muted-foreground'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-small font-medium">{member.name}</p>
                        <p className="truncate text-caption text-muted-foreground">
                          {member.teamName || t('بدون فريق')} · {member.status === 'available' ? t('متاح') : t('غائب')}
                        </p>
                      </div>
                      <span className="shrink-0 text-small font-semibold tabular-nums">{member.assignedCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </DashboardPanel>
      </div>

      {/*
        Widget 4 — merge suggestions, the same component the Contacts screen
        uses. Reused rather than reimplemented so the two cannot drift.
      */}
      <div className="mt-3">
        <MergeSuggestions
          suggestions={merges.status === 'ready' ? merges.data : []}
          loading={merges.status === 'loading'}
          error={merges.status === 'error'}
          onRetry={load}
          /*
            Review hands off to Contacts rather than merging from here.

            Merging is destructive and irreversible — two records become one —
            and the dashboard shows a name and a phone, which is not enough to
            decide. The Contacts screen shows both records in full, which is
            where that decision can actually be made. A one-click merge on a
            summary screen would be the fastest way to lose a customer record.
          */
          onReview={(suggestion) => router.push(`/contacts?merge=${suggestion.primary.id}`)}
        />
      </div>

      {overview.status === 'loading' && (
        <section className="mt-3 rounded-lg border border-border bg-card" role="status" aria-busy="true" aria-label={t('جارٍ التحميل')}>
          {/* The header sits outside the status switch, as DashboardPanel does
              it: a card that loses its title when it fails leaves the reader
              unable to tell which of the six panels is the broken one. */}
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <MessagesSquare className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('المحادثات عبر الزمن')}</h2>
          </header>
          <div className="p-4">
            <SkeletonBlock className="h-5 w-1/4" />
            <SkeletonBlock className="mt-4 h-52 w-full" />
          </div>
        </section>
      )}
      {overview.status === 'error' && (
        <section className="mt-3 rounded-lg border border-border bg-card">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <MessagesSquare className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('المحادثات عبر الزمن')}</h2>
          </header>
          <div className="p-4">
            <ErrorState title={t('تعذر تحميل لوحة التحكم')} description={t('تحقق من الاتصال وحاول مرة أخرى')} retryLabel={t('حاول مرة أخرى')} onRetry={load} />
          </div>
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

      {/*
        Widget 5. Channel is shown because a scheduled broadcast on a number
        that is no longer connected is the failure this panel exists to catch,
        and the name alone cannot show it.
      */}
      <DashboardPanel title={t('البثوث القادمة')} icon={CalendarClock} resource={campaigns} onRetry={load} isEmpty={() => activeCampaigns.length === 0} emptyTitle={t('لا توجد بثوث مجدولة')}>
        {() => (
          <div className="divide-y divide-border">
            {activeCampaigns.map((campaign) => (
              <Link key={campaign.id} href="/campaigns" className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 hover:text-primary">
                <span className="min-w-0 truncate font-medium">{campaign.title}</span>
                <span className="flex shrink-0 items-center gap-3 text-caption text-muted-foreground">
                  {/* The channel it will send on. A broadcast scheduled against a
                      number that has since been unlinked is the failure this
                      panel exists to catch, and the title cannot show it. */}
                  <span className="truncate">{campaign.session?.label || campaign.session?.phoneNumber || t('قناة غير معروفة')}</span>
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
