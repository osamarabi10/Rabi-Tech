'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Archive } from 'lucide-react';
import {
  archiveGrowthWidget,
  createGrowthWidget,
  fetchGrowthWidgets,
  fetchSessions,
  type GrowthWidget,
  type Session,
} from '@/lib/data';
import { useT } from '@/lib/i18n';

/**
 * Growth widgets — chat links that produce attributed contacts.
 *
 * One widget type exists, and the screen says so rather than showing a type
 * picker with a single option. QR codes and the embeddable script arrive with
 * their implementations; a disabled option for something unbuilt is a promise
 * the product cannot keep.
 */
export function GrowthWidgets() {
  const { t } = useT();
  const [widgets, setWidgets] = useState<GrowthWidget[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [prefillText, setPrefillText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchGrowthWidgets().then(setWidgets).catch(() => setWidgets([]));
  }, []);

  useEffect(() => {
    load();
    fetchSessions().then(setSessions).catch(() => {});
  }, [load]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await createGrowthWidget({ name, sessionId, prefillText });
      setName('');
      setPrefillText('');
      load();
    } catch (err: any) {
      setError(err?.response?.data?.error || t('تعذّر إنشاء الأداة'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (widget: GrowthWidget) => {
    try {
      await navigator.clipboard.writeText(widget.url);
      setCopied(widget.id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard permission is not something to interrupt the user over */
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="flex items-center gap-2 text-h2 text-fg">
          <Link2 className="size-5" aria-hidden />
          {t('أدوات النمو')}
        </h1>
        <p className="mt-1 text-body text-muted">
          {t('روابط محادثة تُسجّل مصدر كل عميل جديد يصل عبرها.')}
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-body-strong text-fg">{t('رابط محادثة جديد')}</h2>

        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-caption text-muted">{t('الاسم')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-body"
              placeholder={t('مثال: إعلان انستغرام')}
            />
          </label>

          <label className="block">
            <span className="text-caption text-muted">{t('القناة')}</span>
            <select
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-body"
            >
              <option value="">{t('اختر قناة')}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sessionName}{s.phoneNumber ? ` — ${s.phoneNumber}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-caption text-muted">{t('نص جاهز (اختياري)')}</span>
            <input
              value={prefillText}
              onChange={(e) => setPrefillText(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-surface-2 px-3 py-2 text-body"
              placeholder={t('مرحبًا، أريد الاستفسار عن')}
            />
          </label>
        </div>

        {/*
          Said plainly, once, where it matters. The tracking code is appended to
          this text and the customer sees it in their own composer before
          sending — so attribution here is a floor, not a measurement, and the
          person writing the prefill is the one who needs to know that.
        */}
        <p className="mt-2 text-caption text-muted">
          {t('يُضاف رمز تتبّع قصير في نهاية الرسالة (مثل ‎#gw_a1b2c3d4e5‎). العميل يراه ويمكنه حذفه قبل الإرسال، لذلك تُعد النسبة المنسوبة حدًّا أدنى.')}
        </p>

        {error && <p className="mt-2 text-caption text-danger">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={busy || !name.trim() || !sessionId}
          className="mt-3 rounded-md bg-primary px-4 py-2 text-body-strong text-on-primary disabled:opacity-50"
        >
          {busy ? t('جارٍ الإنشاء…') : t('إنشاء')}
        </button>
      </section>

      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="text-body-strong text-fg">{t('الأدوات الحالية')}</h2>

        {widgets === null && <p className="mt-2 text-body text-muted">{t('جارٍ التحميل…')}</p>}
        {widgets?.length === 0 && (
          <p className="mt-2 text-body text-muted">{t('لا توجد أدوات بعد.')}</p>
        )}

        <ul className="mt-3 space-y-3">
          {widgets?.map((w) => (
            <li key={w.id} className="rounded-md border border-border bg-surface-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-body-strong text-fg">{w.name}</p>
                  <p className="text-caption text-muted">
                    {w.sessionName}{w.phoneNumber ? ` — ${w.phoneNumber}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copy(w)}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption"
                  >
                    <Copy className="size-3.5" aria-hidden />
                    {copied === w.id ? t('تم النسخ') : t('نسخ الرابط')}
                  </button>
                  <button
                    type="button"
                    onClick={() => archiveGrowthWidget(w.id).then(load).catch(() => {})}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption text-muted"
                  >
                    <Archive className="size-3.5" aria-hidden />
                    {t('أرشفة')}
                  </button>
                </div>
              </div>

              <code className="mt-2 block overflow-x-auto rounded bg-surface-3 px-2 py-1 text-caption text-muted">
                {w.url}
              </code>

              {/*
                Contacts first and clicks second, with clicks explicitly marked
                unverified. The redirect is public, so anyone can inflate the
                click count; a contact costs a real message from a real number.
              */}
              <p className="mt-2 text-caption text-muted">
                <span className="text-fg">{w.contacts.toLocaleString()}</span> {t('عميل')}
                {' · '}
                {w.clicks.toLocaleString()} {t('نقرة (غير موثّقة)')}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
