'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Send, Users, CalendarClock, ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  createCampaign,
  previewCampaignAudience,
  sendCampaign,
  type ContactFilterDsl,
  type Template,
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
  const [audience, setAudience] = useState<{ count: number; sample: SampleContact[] } | null>(null);
  const [counting, setCounting] = useState(false);
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
  const rules = filter.$and || [];
  const refreshAudience = useCallback(async () => {
    setCounting(true);
    try {
      const active = rules.filter((r) =>
        ['isEmpty', 'isNotEmpty'].includes(r.operator) || String(r.value ?? '').trim(),
      );
      setAudience(await previewCampaignAudience(active.length ? { $and: active } : null));
    } catch {
      setAudience(null);
      toast.error(t('تعذّر حساب الجمهور'));
    } finally {
      setCounting(false);
    }
  }, [JSON.stringify(rules), t]);

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

  const activeRules = rules.filter((r) =>
    ['isEmpty', 'isNotEmpty'].includes(r.operator) || String(r.value ?? '').trim(),
  );
  const audienceFilter = activeRules.length ? { $and: activeRules } : null;

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
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold',
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
                <span className="text-[10px] text-muted-foreground">{message.length}/3000</span>
              </div>
              <Textarea
                value={message}
                maxLength={3000}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                placeholder={t('اكتب رسالتك… استخدم {{contactName}} لاسم العميل')}
              />
              <p className="text-[10px] text-muted-foreground">
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
                      className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
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
            <ContactFilterBuilder value={filter} onChange={setFilter} />
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
              <Users className="h-4 w-4 shrink-0 text-primary" />
              {counting ? (
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> {t('جاري الحساب...')}
                </span>
              ) : (
                <span className="text-xs">
                  <strong className="text-foreground">{audience?.count ?? 0}</strong>{' '}
                  <span className="text-muted-foreground">
                    {activeRules.length ? t('جهة اتصال مطابقة') : t('جهة اتصال (الكل)')}
                  </span>
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
                <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white">
                  {previewText || t('(رسالة فارغة)')}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-[10px] text-muted-foreground">{t('المستقبلون')}</p>
                <p className="text-base font-bold">{counting ? '…' : audience?.count ?? 0}</p>
              </div>
              <div className="rounded-md border border-border px-3 py-2">
                <p className="text-[10px] text-muted-foreground">{t('الجمهور')}</p>
                <p className="truncate font-medium">
                  {activeRules.length ? `${activeRules.length} ${t('فلتر')}` : t('كل جهات الاتصال')}
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
