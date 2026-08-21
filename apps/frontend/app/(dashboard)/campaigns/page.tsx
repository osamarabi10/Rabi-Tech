'use client';

import { useEffect, useState } from 'react';
import { Megaphone, Plus, RefreshCw } from 'lucide-react';
import { STATUS_CONFIG } from '@/lib/constants';
import {
  fetchCampaigns,
  fetchTemplates,
  fetchCampaignReport,
  type Campaign,
  type CampaignReport,
  type Template,
} from '@/lib/data';
import { StatusBadge } from '@/components/status-badge';
import { CampaignComposer } from '@/components/campaigns/campaign-composer';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';
import { UpgradeGate } from '@/components/upgrade-gate';
import { cn } from '@/lib/utils';

export default function CampaignsPage() {
  const { t } = useT();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);

  const load = () =>
    fetchCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    fetchTemplates({ category: 'CAMPAIGN' }).then(setTemplates).catch(() => {});
  }, []);

  const openReport = async (id: string) => {
    setReportLoading(true);
    try {
      setReport(await fetchCampaignReport(id));
    } catch {
      setReport(null);
    } finally {
      setReportLoading(false);
    }
  };

  const metrics = report
    ? [
        // Darkened for the light canvas — the mid shades these replace sat at
        // ~2.3:1 on white, which is unreadable even for large numerals.
        { label: t('بالانتظار'), value: report.counts.pending, color: '#475569' },
        { label: t('أُرسلت'), value: report.counts.sent, color: 'hsl(var(--status-open))' },
        { label: t('وصلت'), value: report.counts.delivered, color: 'hsl(var(--status-resolved))' },
        { label: t('قُرئت'), value: report.counts.read, color: '#6D28D9' },
        { label: t('فشلت'), value: report.counts.failed, color: 'hsl(var(--danger))' },
      ]
    : [];

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
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={load} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </Button>
          <Button size="sm" onClick={() => setShowNew(true)}>
            <Plus className="me-1 h-4 w-4" />
            {t('حملة جديدة')}
          </Button>
        </div>
      </div>

      <Card className="divide-y divide-border">
        {loading && (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('جاري التحميل...')}</p>
        )}
        {!loading && campaigns.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Megaphone className="h-6 w-6 text-primary" />
            </div>
            <p className="text-sm font-medium">{t('لا توجد حملات بعد')}</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {t('أنشئ حملة لإرسال رسالة لمجموعة من جهات الاتصال دفعة واحدة')}
            </p>
          </div>
        )}
        {campaigns.map((c) => {
          const sc = STATUS_CONFIG[c.status] || STATUS_CONFIG.DRAFT;
          return (
            <button
              key={c.id}
              onClick={() => openReport(c.id)}
              className="flex w-full items-center gap-3 p-4 text-start transition-colors hover:bg-accent/50"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/15">
                <Megaphone className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{c.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.audience} · {c.date}
                </p>
              </div>
              {c.recipients > 0 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {c.recipients} {t('مستلم')}
                </span>
              )}
              <StatusBadge label={sc.label} color={sc.color} />
            </button>
          );
        })}
      </Card>

      <CampaignComposer
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={load}
        templates={templates}
      />

      {/* Delivery report */}
      <Dialog open={!!report || reportLoading} onOpenChange={(v) => !v && setReport(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{report?.campaign.title || t('تقرير الحملة')}</DialogTitle>
          </DialogHeader>
          {reportLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('جاري التحميل...')}</p>
          )}
          {report && (
            <div className="space-y-3">
              <div className="grid grid-cols-5 gap-2">
                {metrics.map((m) => (
                  <div key={m.label} className="rounded-md border border-border px-2 py-2 text-center">
                    <p className="text-lg font-bold" style={{ color: m.color }}>{m.value}</p>
                    <p className="text-[10px] text-muted-foreground">{m.label}</p>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('الإجمالي')}: <strong className="text-foreground">{report.total}</strong>
              </p>

              {report.failures.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-destructive">{t('حالات الفشل')}</p>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {report.failures.map((f) => (
                      <div key={f.id} className="rounded border border-destructive/20 bg-destructive/5 px-2 py-1.5">
                        <p className="text-[11px] font-medium" dir="ltr">
                          {f.contact.name || f.contact.phone}
                        </p>
                        {f.error && (
                          <p className="truncate text-[10px] text-muted-foreground" title={f.error}>
                            {f.error}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </UpgradeGate>
  );
}
