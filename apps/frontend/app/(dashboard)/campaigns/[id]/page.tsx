'use client';

import Link from 'next/link';
import { ArrowLeft, BarChart3, CheckCircle2, Clock3, Megaphone, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCampaignReport, type CampaignReport } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { StatusBadge } from '@/components/status-badge';
import { campaignStatusColor, campaignStatusLabel } from '@/components/campaigns/campaign-status';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';

const DATE_LOCALES = { ar: 'ar-PS', he: 'he-IL', en: 'en-GB' } as const;

function ratio(part: number, total: number): number | null {
  return total === 0 ? null : Math.round((part / total) * 1000) / 10;
}

export default function CampaignDetailPage() {
  const { locale, t } = useT();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(false);
    try {
      setReport(await fetchCampaignReport(id));
    } catch {
      setReport(null);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    if (!report) return [];
    return [
      { key: 'pending', label: t('بالانتظار'), value: report.counts.pending, icon: Clock3, color: 'hsl(var(--status-pending))' },
      { key: 'sent', label: t('أُرسلت'), value: report.counts.sent, icon: Megaphone, color: 'hsl(var(--status-open))' },
      { key: 'delivered', label: t('وصلت'), value: report.counts.delivered, icon: CheckCircle2, color: 'hsl(var(--status-resolved))' },
      { key: 'read', label: t('قُرئت'), value: report.counts.read, icon: BarChart3, color: 'hsl(var(--status-waiting))' },
      { key: 'failed', label: t('فشلت'), value: report.counts.failed, icon: XCircle, color: 'hsl(var(--danger))' },
    ];
  }, [report, t]);

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden />
          {t('العودة إلى الحملات')}
        </Link>
        {report && (
          <StatusBadge
            label={campaignStatusLabel(report.campaign.status, t)}
            color={campaignStatusColor(report.campaign.status)}
          />
        )}
      </div>

      {loading ? (
        <LayoutSkeleton label={t('جاري تحميل تقرير الحملة')} rows={4} />
      ) : error ? (
        <ErrorState
          title={t('تعذّر جلب تقرير الحملة')}
          description={t('تعذّر جلب تقرير الحملة')}
          retryLabel={t('حاول مرة أخرى')}
          onRetry={() => void load()}
        />
      ) : !report ? (
        <EmptyState
          icon={Megaphone}
          title={t('لا توجد بيانات للحملة')}
          description={t('لا توجد بيانات للحملة')}
        />
      ) : (
        <div className="space-y-5">
          <header>
            <h1 className="text-h1 font-extrabold">{report.campaign.title}</h1>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
              <span>{t('الحالة')}: {campaignStatusLabel(report.campaign.status, t)}</span>
              <span>{t('وقت الإرسال')}: {report.campaign.sentAt
                ? new Intl.DateTimeFormat(DATE_LOCALES[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.campaign.sentAt))
                : t('لم يتم الإرسال بعد')}</span>
              {report.campaign.scheduledAt && (
                <span>{t('موعد الإرسال')}: {new Intl.DateTimeFormat(DATE_LOCALES[locale], { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(report.campaign.scheduledAt))}</span>
              )}
            </div>
          </header>

          <section aria-labelledby="campaign-delivery-title">
            <h2 id="campaign-delivery-title" className="mb-3 text-sm font-semibold">{t('تحليلات التسليم')}</h2>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              {metrics.map((metric) => {
                const Icon = metric.icon;
                return (
                  <div key={metric.key} className="rounded-lg border border-border bg-card p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-caption text-muted-foreground">{metric.label}</span>
                      <Icon className="size-4" style={{ color: metric.color }} aria-hidden />
                    </div>
                    <p className="numeric mt-2 text-xl font-bold" dir="ltr">{metric.value}</p>
                  </div>
                );
              })}
            </div>
          </section>

          {report.total === 0 ? (
            <EmptyState
              icon={BarChart3}
              title={t('لا توجد بيانات التسليم')}
              description={t('ستظهر تحليلات التسليم بعد إضافة مستلمين للحملة')}
            />
          ) : (
            <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="campaign-breakdown-title">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="campaign-breakdown-title" className="text-sm font-semibold">{t('تفصيل النتائج')}</h2>
                <span className="numeric text-caption text-muted-foreground" dir="ltr">{report.total} {t('مستلم')}</span>
              </div>
              <div className="mt-4 space-y-3">
                {metrics.map((metric) => {
                  const percentage = ratio(metric.value, report.total);
                  return (
                    <div key={metric.key}>
                      <div className="mb-1 flex items-center justify-between gap-3 text-caption">
                        <span>{metric.label}</span>
                        <span className="numeric text-muted-foreground" dir="ltr">{metric.value} · {percentage ?? 0}%</span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div className="h-full rounded-full" style={{ width: `${percentage ?? 0}%`, backgroundColor: metric.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {report.failures.length > 0 && (
            <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4" aria-labelledby="campaign-failures-title">
              <h2 id="campaign-failures-title" className="text-sm font-semibold text-destructive">{t('حالات الفشل')}</h2>
              <div className="mt-3 space-y-2">
                {report.failures.map((failure) => (
                  <div key={failure.id} className="rounded border border-destructive/20 bg-background px-3 py-2">
                    <p className="text-caption font-medium" dir="ltr">{failure.contact.name || failure.contact.phone}</p>
                    {failure.error && <p className="mt-1 break-words text-micro text-muted-foreground">{failure.error}</p>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
