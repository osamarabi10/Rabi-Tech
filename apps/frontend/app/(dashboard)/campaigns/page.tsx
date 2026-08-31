'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CalendarDays, ChevronLeft, ChevronRight, List, Megaphone, Plus, RefreshCw } from 'lucide-react';
import {
  fetchCampaigns,
  fetchTemplates,
  type Campaign,
  type Template,
} from '@/lib/data';
import { StatusBadge } from '@/components/status-badge';
import { CampaignComposer } from '@/components/campaigns/campaign-composer';
import {
  CAMPAIGN_STATUS_FILTERS,
  campaignStatusColor,
  campaignStatusLabel,
  type CampaignStatusFilter,
} from '@/components/campaigns/campaign-status';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { UpgradeGate } from '@/components/upgrade-gate';
import { cn } from '@/lib/utils';
import { EmptyState, ErrorState, LayoutSkeleton, NoResultsState } from '@/components/ui/operational-state';

const DATE_LOCALES = { ar: 'ar-PS', he: 'he-IL', en: 'en-GB' } as const;

function campaignDate(value: string | null, locale: keyof typeof DATE_LOCALES, t: (key: string) => string): string {
  if (!value) return t('لم يتم الإرسال بعد');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('غير معروف');
  return new Intl.DateTimeFormat(DATE_LOCALES[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function campaignDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

function CalendarView({ campaigns }: { campaigns: Campaign[] }) {
  const { locale, t } = useT();
  const scheduled = campaigns.filter((campaign) => campaign.scheduledAt);
  const [month, setMonth] = useState(() => monthStart(new Date()));

  if (scheduled.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={CalendarDays}
          title={t('لا توجد حملات مجدولة')}
          description={t('ستظهر الحملات المجدولة هنا حسب تاريخ الإرسال')}
        />
      </Card>
    );
  }

  const firstDay = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Array.from({ length: firstDay + daysInMonth }, (_, index) => {
    if (index < firstDay) return null;
    return index - firstDay + 1;
  });
  const weekDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(2024, 0, 7 + index);
    return new Intl.DateTimeFormat(DATE_LOCALES[locale], { weekday: 'short' }).format(date);
  });
  const monthLabel = new Intl.DateTimeFormat(DATE_LOCALES[locale], { month: 'long', year: 'numeric' }).format(month);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('الشهر السابق')}
          title={t('الشهر السابق')}
          onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}
        >
          <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
        <h2 className="text-sm font-semibold">{monthLabel}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t('الشهر التالي')}
          title={t('الشهر التالي')}
          onClick={() => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}
        >
          <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
        </Button>
      </div>
      <div className="grid grid-cols-7 border-b border-border bg-muted/30">
        {weekDays.map((day) => (
          <div key={day} className="min-w-0 px-1 py-2 text-center text-micro font-semibold text-muted-foreground">
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, index) => {
          const key = day === null
            ? `blank-${index}`
            : `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const dayCampaigns = day === null
            ? []
            : scheduled.filter((campaign) => campaignDateKey(campaign.scheduledAt!) === key);
          return (
            <div key={key} className="min-h-24 min-w-0 border-b border-e border-border p-1.5 last:border-e-0 sm:min-h-28">
              {day !== null && (
                <span className="numeric mb-1 block text-end text-caption text-muted-foreground" dir="ltr">{day}</span>
              )}
              <div className="space-y-1">
                {dayCampaigns.map((campaign) => (
                  <Link
                    key={campaign.id}
                    href={`/campaigns/${campaign.id}`}
                    className="block min-w-0 rounded border border-primary/20 bg-primary/10 px-1.5 py-1 text-micro font-medium text-foreground hover:border-primary/50"
                    title={campaign.title}
                  >
                    <span className="block truncate">{campaign.title}</span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  const { locale, t } = useT();
  return (
    <Card className="divide-y divide-border">
      {campaigns.map((campaign) => (
        <Link
          key={campaign.id}
          href={`/campaigns/${campaign.id}`}
          className="flex min-w-0 items-center gap-3 p-4 text-start transition-colors hover:bg-accent/50"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15">
            <Megaphone className="size-4 text-primary" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{campaign.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {campaign.audience} · {campaign.scheduledAt
                ? campaignDate(campaign.scheduledAt, locale, t)
                : campaign.date}
            </p>
          </div>
          <span className="numeric shrink-0 text-xs text-muted-foreground" dir="ltr">
            {campaign.recipients} {t('مستلم')}
          </span>
          <StatusBadge
            label={campaignStatusLabel(campaign.status, t)}
            color={campaignStatusColor(campaign.status)}
          />
        </Link>
      ))}
    </Card>
  );
}

export default function CampaignsPage() {
  const { t } = useT();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [statusFilter, setStatusFilter] = useState<CampaignStatusFilter>('ALL');
  const [view, setView] = useState<'list' | 'calendar'>('list');

  const load = async () => {
    setLoading(true);
    setError(false);
    try {
      setCampaigns(await fetchCampaigns());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    fetchTemplates({ category: 'CAMPAIGN' }).then(setTemplates).catch(() => {});
  }, []);

  const visibleCampaigns = statusFilter === 'ALL'
    ? campaigns
    : campaigns.filter((campaign) => campaign.status === statusFilter);

  return (
    // The nav entry and page stay; only the contents are gated. A missing menu
    // item reads as broken, a priced feature reads as something to buy.
    <UpgradeGate
      feature="broadcasts"
      title="البث"
      description="أرسل رسالة لمجموعة من جهات الاتصال دفعة واحدة، مع تقرير تسليم لكل مستلم."
    >
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-base font-extrabold">{t('الحملات والبث')}</h1>
        <div className="flex gap-2">
          <Button size="icon" variant="ghost" className="size-8" onClick={() => void load()} disabled={loading} aria-label={t('تحديث الحملات')} title={t('تحديث الحملات')}>
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
          </Button>
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="me-1 size-4" aria-hidden />
            {t('حملة جديدة')}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t('تصفية الحملات')} className="flex max-w-full gap-1 overflow-x-auto pb-1">
          {CAMPAIGN_STATUS_FILTERS.map((filter) => {
            const count = filter.value === 'ALL'
              ? campaigns.length
              : campaigns.filter((campaign) => campaign.status === filter.value).length;
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={statusFilter === filter.value}
                onClick={() => setStatusFilter(filter.value)}
                className={cn(
                  'shrink-0 rounded-md border px-2.5 py-1.5 text-caption transition-colors',
                  statusFilter === filter.value
                    ? 'border-primary bg-primary/10 font-semibold text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {t(filter.label)} <span className="numeric ms-1" dir="ltr">{count}</span>
              </button>
            );
          })}
        </nav>
        <div role="group" aria-label={t('طريقة عرض الحملات')} className="flex shrink-0 rounded-md border border-border p-0.5">
          <Button
            type="button"
            variant={view === 'list' ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            aria-label={t('عرض القائمة')}
            title={t('عرض القائمة')}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <List className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant={view === 'calendar' ? 'secondary' : 'ghost'}
            size="icon"
            className="size-8"
            aria-label={t('عرض التقويم')}
            title={t('عرض التقويم')}
            aria-pressed={view === 'calendar'}
            onClick={() => setView('calendar')}
          >
            <CalendarDays className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      {loading ? (
        <LayoutSkeleton label={t('جاري تحميل الحملات')} rows={5} />
      ) : error ? (
        <ErrorState
          title={t('تعذّر جلب الحملات')}
          description={t('تعذّر جلب الحملات')}
          retryLabel={t('حاول مرة أخرى')}
          onRetry={() => void load()}
        />
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={t('لا توجد حملات بعد')}
          description={t('أنشئ حملة لإرسال رسالة لمجموعة من جهات الاتصال دفعة واحدة')}
        />
      ) : visibleCampaigns.length === 0 ? (
        <NoResultsState
          title={t('لا توجد حملات في هذه الحالة')}
          description={t('جرّب حالة أخرى لعرض حملاتك')}
          clearLabel={t('كل الحالات')}
          onClear={() => setStatusFilter('ALL')}
        />
      ) : view === 'calendar' ? (
        <CalendarView campaigns={visibleCampaigns} />
      ) : (
        <CampaignList campaigns={visibleCampaigns} />
      )}

      <CampaignComposer
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={load}
        templates={templates}
      />
    </div>
    </UpgradeGate>
  );
}
