'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquareText, Trash2 } from 'lucide-react';
import {
  fetchAutoReplies,
  saveAutoReply,
  deleteAutoReply,
  type AutoReplyKind,
  type AutoReplySlot,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

/** Human labels + when each auto-reply fires. */
const KIND_INFO: Record<AutoReplyKind, { label: string; when: string }> = {
  WELCOME: { label: 'ترحيب', when: 'أول رسالة من عميل جديد' },
  OUT_OF_HOURS: { label: 'خارج أوقات العمل', when: 'رسالة تصل خارج ساعات العمل' },
  CSAT_PROMPT: { label: 'طلب تقييم', when: 'بعد إغلاق المحادثة' },
  CSAT_THANKS: { label: 'شكر بعد التقييم', when: 'بعد ما يرسل العميل تقييمه' },
  CONVERSATION_CLOSED: { label: 'إغلاق المحادثة', when: 'عند إغلاق المحادثة' },
  AWAITING_CLIENT: { label: 'بانتظار رد العميل', when: 'عند طلب معلومات إضافية' },
  KEYWORD_CRITICAL: { label: 'رد تلقائي — عاجل', when: 'كلمة مفتاحية بأولوية عاجلة' },
  KEYWORD_HIGH: { label: 'رد تلقائي — عالية', when: 'كلمة مفتاحية بأولوية عالية' },
  KEYWORD_MEDIUM: { label: 'رد تلقائي — متوسطة', when: 'كلمة مفتاحية بأولوية متوسطة' },
  KEYWORD_LOW: { label: 'رد تلقائي — عادية', when: 'كلمة مفتاحية بأولوية عادية' },
};

export function AutoRepliesCard({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useT();
  const [slots, setSlots] = useState<AutoReplySlot[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const rows = await fetchAutoReplies();
      setSlots(rows);
      setDrafts(
        Object.fromEntries(rows.map((s) => [s.kind, s.template?.body ?? ''])),
      );
    } catch {
      toast.error(t('فشل تحميل الردود التلقائية'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (slot: AutoReplySlot) => {
    const body = (drafts[slot.kind] ?? '').trim();
    if (!body) {
      toast.error(t('نص الرد لا يمكن أن يكون فارغاً'));
      return;
    }
    setSaving(slot.kind);
    try {
      await saveAutoReply(slot.kind, {
        body,
        title: slot.template?.title || KIND_INFO[slot.kind].label,
      });
      toast.success(t('تم الحفظ'));
      await load();
    } catch {
      toast.error(t('فشل الحفظ'));
    } finally {
      setSaving(null);
    }
  };

  const handleToggle = async (slot: AutoReplySlot) => {
    setSaving(slot.kind);
    try {
      await saveAutoReply(slot.kind, { isActive: !slot.template?.isActive });
      await load();
    } catch {
      toast.error(t('فشل التحديث'));
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (slot: AutoReplySlot) => {
    if (!confirm(t('حذف هذا الرد نهائياً؟ لن يتم إرسال أي شيء عند هذا الحدث.'))) return;
    setSaving(slot.kind);
    try {
      await deleteAutoReply(slot.kind);
      toast.success(t('تم الحذف — لن يُرسل شيء عند هذا الحدث'));
      await load();
    } catch {
      toast.error(t('فشل الحذف'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquareText className="h-4 w-4 text-primary" />
          {t('الردود التلقائية')}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t('كل رسالة تلقائية تُرسل لعملائك تتحكم فيها من هنا. إذا الرد غير مفعّل أو محذوف، ما رح يتم إرسال أي شيء.')}
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading && <p className="text-xs text-muted-foreground">{t('جارِ التحميل...')}</p>}

        {!loading && slots.map((slot) => {
          const info = KIND_INFO[slot.kind];
          const active = slot.template?.isActive ?? false;
          const busy = saving === slot.kind;
          const dirty = (drafts[slot.kind] ?? '') !== (slot.template?.body ?? '');

          return (
            <div
              key={slot.kind}
              className="rounded-lg border border-border bg-secondary/30 p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{t(info.label)}</span>
                    {slot.configured ? (
                      <Badge variant={active ? 'default' : 'secondary'} className="text-micro">
                        {active ? t('مفعّل') : t('متوقف')}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-micro">
                        {t('غير مضبوط — لا يُرسل شيء')}
                      </Badge>
                    )}
                  </div>
                  <p className="text-caption text-muted-foreground">{t(info.when)}</p>
                </div>

                {isAdmin && (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => handleToggle(slot)}
                    >
                      {active ? t('إيقاف') : t('تفعيل')}
                    </Button>
                    {slot.configured && (
                      <Button
                        size="icon"
                        variant="outline"
                        className="h-8 w-8"
                        disabled={busy}
                        onClick={() => handleDelete(slot)}
                        title={t('حذف')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>

              <Textarea
                rows={2}
                className="text-sm"
                value={drafts[slot.kind] ?? ''}
                disabled={!isAdmin || busy}
                placeholder={t('اكتب نص الرسالة... اتركه فارغاً وما رح يُرسل شيء')}
                onChange={(e) =>
                  setDrafts((d) => ({ ...d, [slot.kind]: e.target.value }))
                }
              />

              {isAdmin && dirty && (
                <div className="flex justify-end">
                  <Button size="sm" disabled={busy} onClick={() => handleSave(slot)}>
                    {busy ? t('جارِ الحفظ...') : t('حفظ')}
                  </Button>
                </div>
              )}
            </div>
          );
        })}

        {!isAdmin && !loading && (
          <p className="text-xs text-muted-foreground">
            {t('تعديل الردود التلقائية متاح لمدير المؤسسة فقط.')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
