'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleCard } from '@/components/ui/feedback-primitives';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { fetchCurrentProfile, updateNotificationPreferences, type NotificationDelivery, type NotificationPreferences } from '@/lib/data';
import { useT } from '@/lib/i18n';

const FIELDS: Array<{ key: Exclude<keyof NotificationPreferences, 'notificationSound'>; title: string; description: string }> = [
  { key: 'notificationNewMessage', title: 'الرسائل الجديدة', description: 'عند وصول رسالة إلى محادثة مسندة لك أو إلى مشرفي الفريق' },
  { key: 'notificationAssignment', title: 'تعيين المحادثات', description: 'عندما يسند إليك زميل محادثة جديدة' },
  { key: 'notificationMention', title: 'الإشارات', description: 'عندما يذكرك زميل في ملاحظة داخلية' },
  { key: 'notificationResolution', title: 'إغلاق المحادثات', description: 'عندما تُغلق محادثة كنت مسؤولاً عنها' },
  { key: 'notificationEscalation', title: 'تصعيد المحادثات', description: 'عندما تتجاوز محادثة مهلة الرد المحددة' },
];

export default function NotificationSettingsPage() {
  const { t } = useT();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const profile = await fetchCurrentProfile();
      setPreferences({
        notificationNewMessage: profile.notificationNewMessage,
        notificationAssignment: profile.notificationAssignment,
        notificationMention: profile.notificationMention,
        notificationResolution: profile.notificationResolution,
        notificationEscalation: profile.notificationEscalation,
        notificationSound: profile.notificationSound,
      });
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!preferences) return;
    setSaving(true);
    try {
      const saved = await updateNotificationPreferences(preferences);
      setPreferences(saved);
      const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
      localStorage.setItem('rabitech_user', JSON.stringify({ ...user, ...saved }));
      toast.success(t('تم حفظ إعدادات الإشعارات'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('تعذر حفظ إعدادات الإشعارات'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex-1 overflow-y-auto p-5"><LayoutSkeleton label={t('جاري التحميل...')} rows={6} /></div>;
  if (loadError || !preferences) return <div className="flex-1 overflow-y-auto p-5"><ErrorState title={t('تعذر تحميل إعدادات الإشعارات')} retryLabel={t('إعادة المحاولة')} onRetry={load} /></div>;

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="border-b border-border px-5 py-4">
        <h1 className="text-base font-bold">{t('إعدادات الإشعارات')}</h1>
      </header>
      <div className="mx-auto max-w-3xl px-5 py-5">
        <section aria-labelledby="delivery-title">
          <h2 id="delivery-title" className="text-sm font-semibold">{t('التنبيهات داخل التطبيق')}</h2>
          <p className="mt-1 text-caption text-muted-foreground">{t('اختر الأحداث التي تريد ظهورها في مركز الإشعارات')}</p>
          <div className="mt-4 divide-y divide-border border-y border-border">
            {FIELDS.map((field) => (
              <div key={field.key} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <h3 className="text-small font-semibold">{t(field.title)}</h3>
                  <p className="mt-1 text-caption text-muted-foreground">{t(field.description)}</p>
                </div>
                <div className="w-full shrink-0 sm:w-48">
                  <Label className="sr-only">{t(field.title)}</Label>
                  <Select value={preferences[field.key]} onValueChange={(value) => setPreferences({ ...preferences, [field.key]: value as NotificationDelivery })}>
                    <SelectTrigger aria-label={t(field.title)}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="IN_APP">{t('داخل التطبيق')}</SelectItem>
                      <SelectItem value="OFF">{t('متوقف')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6 border-t border-border" aria-labelledby="sound-title">
          <h2 id="sound-title" className="sr-only">{t('الصوت')}</h2>
          <ToggleCard title={t('صوت الإشعار')} description={t('شغّل نغمة قصيرة عند وصول إشعار جديد أثناء استخدام التطبيق')} checked={preferences.notificationSound} onCheckedChange={(checked) => setPreferences({ ...preferences, notificationSound: checked })} />
        </section>

        <div className="flex justify-end pt-5">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t('حفظ')}
          </Button>
        </div>
      </div>
    </div>
  );
}
