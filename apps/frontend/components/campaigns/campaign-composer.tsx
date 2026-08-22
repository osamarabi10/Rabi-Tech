'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send, Users, CalendarClock, ArrowLeft, ArrowRight, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { activeFilter, countRules } from '@/lib/contact-filter';

/** The server's own message, when it sent one. */
function serverError(err: unknown): string | null {
  const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof message === 'string' && message ? message : null;
}
import {
  createCampaign,
  previewCampaignAudience,
  sendCampaign,
  type ContactFilterDsl,
  type Template,
  fetchSegments,
  type Segment,
} from '@/lib/data';
import { renderTemplate } from '@/lib/utils';
import { ContactFilterBuilder } from '@/components/contacts/contact-filter-builder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Step = 'compose' | 'target' | 'review';

const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'compose', label: 'الرسالة' },
  { key: 'target',  label: 'الجمهور' },
  { key: 'review',  label: 'المراجعة' },
];

/** Sample contact used to resolve {{variables}} in the preview bubble. */
type SampleContact = { id: string; name: string | null; phone: string; firstName: string | null };

export function CampaignComposer({
  open,
  onClose,
  onCreated,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  templates: Template[];
}) {
  const { t } = useT();
  const [step, setStep] = useState<Step>('compose');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState<ContactFilterDsl>({ $and: [] });
  const [scheduledAt, setScheduledAt] = useState('');
  const [audience, setAudience] = useState<{ count: number; sample: SampleContact[]; excludedOptedOut: number } | null>(null);
  const [counting, setCounting] = useState(false);
  const [audienceError, setAudienceError] = useState<string | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segmentId, setSegmentId] = useState<string>('');
  /** The filter as the chosen segment defines it, to detect later edits. */
  const [segmentBaseline, setSegmentBaseline] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setStep('compose');
    setTitle(''); setMessage('');
    setFilter({ $and: [] });
    setScheduledAt(''); setAudience(null);
  };

  const close = () => { reset(); onClose(); };

  // Recount whenever the audience changes — the number an admin approves must be
  // the number that actually receives the blast, not a stale figure.
  const refreshAudience = useCallback(async () => {
    setCounting(true);
    try {
      setAudience(await previewCampaignAudience(activeFilter(filter)));
      setAudienceError(null);
    } catch (err) {
      // Show the reason the server gave — it names the offending field or
      // operator. A generic "couldn't count" left the admin staring at a number
      // that had quietly stopped updating with no way to tell which rule broke.
      setAudience(null);
      setAudienceError(serverError(err) || t('تعذّر حساب الجمهور'));
    } finally {
      setCounting(false);
    }
    // Watch the whole filter, not just its top-level $and: with nested groups a
    // change inside a group would otherwise never trigger a recount, leaving a
    // stale audience number on screen — the one number that must never be stale.
  }, [JSON.stringify(filter), t]);

  useEffect(() => {
    if (!open) return;
    fetchSegments().then(setSegments).catch(() => setSegments([]));
  }, [open]);

  useEffect(() => {
    if (!open || step !== 'target') return;
    const timer = window.setTimeout(refreshAudience, 350);
    return () => window.clearTimeout(timer);
  }, [open, step, refreshAudience]);

  useEffect(() => { if (open && step === 'review' && !audience) refreshAudience(); },
    [open, step, audience, refreshAudience]);

  const sample = audience?.sample?.[0];
  const previewText = renderTemplate(message, {
    contactName: sample?.name || sample?.firstName || t('صديقنا'),
    firstName: sample?.firstName || sample?.name || t('صديقنا'),
    phone: sample?.phone || '',
  });

  const audienceFilter = activeFilter(filter);
  // Once a loaded segment is edited the audience is no longer that segment.
  // Saying otherwise would let someone believe they are sending to the saved
  // definition when they are not.
  const edited = Boolean(segmentBaseline) && JSON.stringify(filter) !== segmentBaseline;
  const activeCount = countRules(audienceFilter);

  const submit = async (mode: 'now' | 'schedule') => {
    if (!title.trim() || !message.trim()) {
      toast.error(t('أدخل اسم الحملة والرسالة'));
      return;
    }
    if (mode === 'schedule' && !scheduledAt) {
      toast.error(t('اختر وقت الإرسال'));
      return;
    }
    setSubmitting(true);
    try {
      const created = await createCampaign({
        title,
        message,
        audienceFilter,
        scheduledAt: mode === 'schedule' ? new Date(scheduledAt).toISOString() : null,
      });
      if (mode === 'now') {
        const { queued } = await sendCampaign(created.id);
        toast.success(t('بدأ الإرسال') + ` — ${queued}`);
      } else {
        toast.success(t('تمت جدولة الحملة'));
      }
      onCreated();
      close();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل إنشاء الحملة'));
    } finally {
      setSubmitting(false);
    }
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const canAdvance = step === 'compose' ? title.trim() && message.trim() : true;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('حملة جديدة')}</DialogTitle>
        </DialogHeader>

        {/* Step rail */}
        <div className="flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex flex-1 items-center gap-2">
              <div className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-caption font-bold',
                i <= stepIndex ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}>{i + 1}</div>
              <span className={cn('text-xs', i === stepIndex ? 'font-semibold text-foreground' : 'text-muted-foreground')}>
                {t(s.label)}
              </span>
              {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
            </div>
          ))}
        </div>

        {step === 'compose' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('اسم الحملة')}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('عرض العيد')} />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t('الرسالة')}</Label>
                <span className="text-micro text-muted-foreground">{message.length}/3000</span>
              </div>
              <Textarea
                value={message}
                maxLength={3000}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                placeholder={t('اكتب رسالتك… استخدم {{contactName}} لاسم العميل')}
              />
              <p className="text-micro text-muted-foreground">
                {t('المتغيرات المتاحة')}: <code>{'{{contactName}}'}</code> <code>{'{{firstName}}'}</code>
              </p>
            </div>
            {templates.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('قوالب جاهزة')}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {templates.slice(0, 6).map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      onClick={() => setMessage(tpl.body)}
                      className="rounded-full border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                      {tpl.title}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 'target' && (
          <div className="space-y-3">
            {/*
              Above the builder, not a tab. A tab would imply the two are
              alternatives; the real value is picking a saved segment and then
              adding a condition for this one campaign, so the segment is a
              starting point that stays editable.
            */}
            {segments.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <Label className="text-xs">{t('شريحة محفوظة')}</Label>
                <select
                  value={segmentId}
                  onChange={(event) => {
                    const next = segments.find((segment) => segment.id === event.target.value);
                    setSegmentId(next?.id ?? '');
                    setFilter(next ? next.filter : { $and: [] });
                    setSegmentBaseline(next ? JSON.stringify(next.filter) : '');
                  }}
                  className="select-field select-field-sm"
                >
                  <option value="">{t('بدون')}</option>
                  {segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>{segment.name}</option>
                  ))}
                </select>
                {segmentId && edited && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-micro text-muted-foreground">
                    {t('شريحة مخصصة')}
                  </span>
                )}
              </div>
            )}
            <ContactFilterBuilder value={filter} onChange={setFilter} />
            <div
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2',
                audienceError ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/40',
              )}
            >
              <Users className={cn('h-4 w-4 shrink-0', audienceError ? 'text-destructive' : 'text-primary')} />
              {audienceError ? (
                <span className="text-xs text-destructive">{audienceError}</span>
              ) : counting ? (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> {t('جاري الحساب...')}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span>
                    <strong className="text-foreground">{audience?.count ?? 0}</strong>{' '}
                    <span className="text-muted-foreground">
                      {activeCount ? t('جهة اتصال مطابقة') : t('جهة اتصال (الكل)')}
                    </span>
                  </span>
                  {/*
                    Consent is enforced on the server whatever this says, so the
                    line is not a control — it is the explanation for a count
                    that is smaller than the filter implies.
                  */}
                  {(audience?.excludedOptedOut ?? 0) > 0 && (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <ShieldOff className="h-3 w-3 shrink-0" aria-hidden />
                      {t('مستثنى بسبب إلغاء الاشتراك')}:{' '}
                      <strong className="numeric font-mono tabular-nums text-foreground">
                        {audience?.excludedOptedOut}
                      </strong>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-3">
            {/* WhatsApp-style bubble so the admin sees what the customer sees. */}
            <div className="rounded-lg bg-[#0b141a] p-3">
              <div className="ms-auto max-w-[85%] rounded-lg rounded-te-sm bg-[#005c4b] px-3 py-2">
                <p className="whitespace-pre-wrap break-words text-small leading-relaxed text-white">
                  {previewText || t('(رسالة فارغة)')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-micro text-muted-foreground">{t('المستقبلون')}</p>
                <p className="text-base font-bold">{counting ? '…' : audience?.count ?? 0}</p>
                {/* Last screen before the send: the exclusion is stated here
                    too, so nobody approves a number without knowing what it
                    already leaves out. */}
                {(audience?.excludedOptedOut ?? 0) > 0 && (
                  <p className="mt-0.5 flex items-center gap-1 text-micro text-muted-foreground">
                    <ShieldOff className="h-3 w-3 shrink-0" aria-hidden />
                    {t('مستثنى بسبب إلغاء الاشتراك')}:{' '}
                    <span className="numeric font-mono tabular-nums">{audience?.excludedOptedOut}</span>
                  </p>
                )}
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-micro text-muted-foreground">{t('الجمهور')}</p>
                <p className="truncate font-medium">
                  {activeCount ? `${activeCount} ${t('فلتر')}` : t('كل جهات الاتصال')}
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">
                <CalendarClock className="h-3.5 w-3.5" /> {t('جدولة (اختياري)')}
              </Label>
              <Input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
            </div>

            {(audience?.count ?? 0) === 0 && (
              <p className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-xs text-warning">
                {t('لا يوجد مستقبلون مطابقون — عدّل الفلاتر قبل الإرسال')}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={stepIndex === 0 || submitting}
            onClick={() => setStep(STEPS[Math.max(0, stepIndex - 1)].key)}
          >
            <ArrowRight className="h-4 w-4" /> {t('السابق')}
          </Button>

          {step !== 'review' ? (
            <Button size="sm" disabled={!canAdvance} onClick={() => setStep(STEPS[stepIndex + 1].key)}>
              {t('التالي')} <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={submitting || !scheduledAt || (audience?.count ?? 0) === 0}
                onClick={() => submit('schedule')}
              >
                <CalendarClock className="h-4 w-4" /> {t('جدولة')}
              </Button>
              <Button
                size="sm"
                disabled={submitting || (audience?.count ?? 0) === 0}
                onClick={() => submit('now')}
              >
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t('إرسال الآن')}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
