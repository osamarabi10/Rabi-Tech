'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Globe2,
  Link2,
  Loader2,
  MessageCircle,
  QrCode,
  RefreshCw,
  TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchChannelCapabilities,
  fetchGrowthQr,
  fetchOrganizationBranding,
  fetchSessions,
  type ChannelCapabilities,
  type OrganizationBranding,
  type Session,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, EmptyState, LayoutSkeleton, SkeletonBlock } from '@/components/ui/operational-state';

type Resource<T> =
  | { status: 'loading'; data: null }
  | { status: 'ready'; data: T }
  | { status: 'error'; data: null };

type ToolKind = 'click-to-chat' | 'qr' | 'widget';
type Placement = 'start' | 'end';

const LOADING: Resource<never> = { status: 'loading', data: null };

function clickToChatUrl(phone: string | null | undefined, greeting: string): string | null {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  const query = new URLSearchParams();
  if (greeting.trim()) query.set('text', greeting.trim());
  const suffix = query.toString();
  return `https://wa.me/${digits}${suffix ? `?${suffix}` : ''}`;
}

function statusCopy(status: Session['connectionStatus'], t: (key: string) => string): string {
  if (status === 'CONNECTED') return t('متصل');
  if (status === 'UNAVAILABLE') return t('تعذر التحقق من الاتصال');
  return t('غير متصل');
}

function TypeButton({
  active,
  icon: Icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-w-0 items-start gap-3 rounded-lg border p-3 text-start transition-colors ${active ? 'border-primary bg-primary/10' : 'border-border hover:bg-accent'}`}
    >
      <Icon className={`mt-0.5 size-5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
      <span className="min-w-0">
        <span className="block text-small font-semibold">{label}</span>
        <span className="mt-1 block text-caption text-muted-foreground">{description}</span>
      </span>
      {active && <Check className="ms-auto mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
    </button>
  );
}

function CopyButton({ value, label, errorLabel, onCopied }: { value: string; label: string; errorLabel: string; onCopied: () => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      onCopied();
    } catch {
      // The action remains visible; browsers can deny clipboard access in a
      // non-secure preview, so report that rather than pretending it copied.
      toast.error(errorLabel);
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
      <Copy className="size-4" aria-hidden />
      {label}
    </Button>
  );
}

export default function GrowthPage() {
  const { t } = useT();
  const [resource, setResource] = useState<{
    sessions: Resource<Session[]>;
    branding: Resource<OrganizationBranding>;
    capabilities: Resource<{ capabilities: ChannelCapabilities | null; code: string | null; message: string | null }>;
  }>({ sessions: LOADING, branding: LOADING, capabilities: LOADING });
  const [tool, setTool] = useState<ToolKind>('click-to-chat');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [greeting, setGreeting] = useState(() => t('مرحباً! كيف يمكننا مساعدتك؟'));
  const [buttonLabel, setButtonLabel] = useState(() => t('تحدث معنا'));
  const [placement, setPlacement] = useState<Placement>('end');
  const [qr, setQr] = useState<Resource<string | null>>({ status: 'loading', data: null });
  const [qrAttempt, setQrAttempt] = useState(0);

  const load = useCallback(async () => {
    setResource({ sessions: LOADING, branding: LOADING, capabilities: LOADING });
    const [sessions, branding, capabilities] = await Promise.allSettled([
      fetchSessions(),
      fetchOrganizationBranding(),
      fetchChannelCapabilities(),
    ]);
    setResource({
      sessions: sessions.status === 'fulfilled' ? { status: 'ready', data: sessions.value } : { status: 'error', data: null },
      branding: branding.status === 'fulfilled' ? { status: 'ready', data: branding.value } : { status: 'error', data: null },
      capabilities: capabilities.status === 'fulfilled' ? { status: 'ready', data: capabilities.value } : { status: 'error', data: null },
    });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sessions = resource.sessions.status === 'ready' ? resource.sessions.data : [];
  const branding = resource.branding.status === 'ready' ? resource.branding.data : null;
  const capabilities = resource.capabilities.status === 'ready' ? resource.capabilities.data : null;
  const selectedSession = sessions.find((session) => session.id === selectedSessionId)
    || sessions.find((session) => session.isActiveChannel && session.phoneNumber)
    || sessions.find((session) => session.phoneNumber)
    || sessions[0]
    || null;
  const target = useMemo(
    () => clickToChatUrl(selectedSession?.phoneNumber, greeting),
    [greeting, selectedSession?.phoneNumber],
  );
  const widgetOrigin = branding?.customDomainVerified && branding.customDomain
    ? `https://${branding.customDomain}`
    : 'https://your-domain.example';
  const embedCode = target
    ? `<script src="${widgetOrigin}/widget.js" data-target="${target}" data-label="${buttonLabel}"></script>`
    : '';

  useEffect(() => {
    if (tool !== 'qr' || !target) {
      setQr({ status: 'ready', data: null });
      return;
    }
    let cancelled = false;
    setQr({ status: 'loading', data: null });
    fetchGrowthQr(target)
      .then((dataUrl) => { if (!cancelled) setQr({ status: 'ready', data: dataUrl }); })
      .catch(() => { if (!cancelled) setQr({ status: 'error', data: null }); });
    return () => { cancelled = true; };
  }, [qrAttempt, target, tool]);

  const retryQr = () => setQrAttempt((attempt) => attempt + 1);
  const copySuccess = (message: string) => toast.success(t(message));
  const missingSession = resource.sessions.status === 'ready' && !selectedSession?.phoneNumber;
  const pageError = resource.sessions.status === 'error' || resource.branding.status === 'error';
  const loading = resource.sessions.status === 'loading' || resource.branding.status === 'loading' || resource.capabilities.status === 'loading';

  if (loading) {
    return <div className="flex-1 overflow-y-auto p-5"><LayoutSkeleton label={t('جاري تحميل أدوات النمو')} rows={7} /></div>;
  }
  if (pageError) {
    return <div className="flex-1 overflow-y-auto p-5"><ErrorState title={t('تعذر تحميل أدوات النمو')} description={t('تحقق من الاتصال وحاول مرة أخرى')} retryLabel={t('حاول مرة أخرى')} onRetry={() => void load()} /></div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <TrendingUp className="size-5" aria-hidden />
            <span className="text-caption font-semibold">{t('أدوات النمو')}</span>
          </div>
          <h1 className="mt-1 text-h1 font-extrabold">{t('حوّل زياراتك إلى محادثات')}</h1>
          <p className="mt-1 max-w-2xl text-small text-muted-foreground">{t('أنشئ رابط اتصال أو رمز QR أو معاينة أداة المحادثة لمساحة عملك.')}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-4" aria-hidden />
          {t('تحديث')}
        </Button>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-tool-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="growth-tool-title" className="text-small font-semibold">{t('اختر أداة')}</h2>
                <p className="mt-1 text-caption text-muted-foreground">{t('تتغير المعاينة حسب الأداة التي تختارها.')}</p>
              </div>
              <div className="flex items-center gap-2 text-caption text-muted-foreground">
                <MessageCircle className="size-4" aria-hidden />
                {capabilities?.capabilities?.canInitiateConversations
                  ? t('القناة تسمح ببدء المحادثات')
                  : t('بدء المحادثة يعتمد على رسالة العميل')}
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <TypeButton active={tool === 'click-to-chat'} icon={Link2} label={t('رابط اتصال')} description={t('رابط يفتح محادثة واتساب')} onClick={() => setTool('click-to-chat')} />
              <TypeButton active={tool === 'qr'} icon={QrCode} label={t('رمز QR')} description={t('رمز قابل للمسح يفتح المحادثة')} onClick={() => setTool('qr')} />
              <TypeButton active={tool === 'widget'} icon={Code2} label={t('أداة محادثة')} description={t('معاينة زر قابل للتضمين')} onClick={() => setTool('widget')} />
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-config-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="growth-config-title" className="text-small font-semibold">{t('إعدادات المعاينة')}</h2>
                <p className="mt-1 text-caption text-muted-foreground">{t('هذه إعدادات معاينة محلية وليست نشرًا عامًا.')}</p>
              </div>
              <Globe2 className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="growth-session">{t('رقم واتساب')}</Label>
                <select id="growth-session" className="select-field w-full" value={selectedSession?.id || ''} onChange={(event) => setSelectedSessionId(event.target.value)}>
                  <option value="">{t('اختر رقمًا')}</option>
                  {sessions.map((session) => <option key={session.id} value={session.id}>{session.label || session.sessionName} · {session.phoneNumber || t('لا يوجد رقم')}</option>)}
                </select>
                {selectedSession && <p className="text-caption text-muted-foreground">{statusCopy(selectedSession.connectionStatus, t)}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="growth-placement">{t('موضع الزر')}</Label>
                <select id="growth-placement" className="select-field w-full" value={placement} onChange={(event) => setPlacement(event.target.value as Placement)}>
                  <option value="start">{t('بداية الصفحة')}</option>
                  <option value="end">{t('نهاية الصفحة')}</option>
                </select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="growth-greeting">{t('رسالة البداية')}</Label>
                <Input id="growth-greeting" value={greeting} onChange={(event) => setGreeting(event.target.value)} maxLength={500} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="growth-button-label">{t('نص الزر')}</Label>
                <Input id="growth-button-label" value={buttonLabel} onChange={(event) => setButtonLabel(event.target.value)} maxLength={60} />
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-output-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 id="growth-output-title" className="text-small font-semibold">{tool === 'click-to-chat' ? t('رابط الاتصال') : tool === 'qr' ? t('رمز QR') : t('كود التضمين')}</h2>
                <p className="mt-1 text-caption text-muted-foreground">{t('راجع الناتج قبل استخدامه في موقعك أو موادك التسويقية.')}</p>
              </div>
              {tool === 'click-to-chat' && target && <CopyButton value={target} label={t('نسخ الرابط')} errorLabel={t('تعذر نسخ المحتوى')} onCopied={() => copySuccess('تم نسخ الرابط')} />}
              {tool === 'widget' && embedCode && <CopyButton value={embedCode} label={t('نسخ الكود')} errorLabel={t('تعذر نسخ المحتوى')} onCopied={() => copySuccess('تم نسخ الكود')} />}
            </div>
            {missingSession ? (
              <EmptyState icon={MessageCircle} compact title={t('لا يوجد رقم واتساب متاح')} description={t('اربط رقم واتساب من إعدادات القنوات لإنشاء رابط اتصال.')} />
            ) : tool === 'qr' ? (
              <div className="mt-4 flex min-h-72 items-center justify-center rounded-lg border border-border bg-muted/30 p-4">
                {qr.status === 'loading' && <div className="space-y-3 text-center" role="status" aria-busy="true" aria-label={t('جاري إنشاء رمز QR')}><SkeletonBlock className="mx-auto size-56" /><p className="text-caption text-muted-foreground">{t('جاري إنشاء رمز QR')}</p></div>}
                {qr.status === 'error' && <ErrorState compact title={t('تعذر إنشاء رمز QR')} description={t('تحقق من الرابط وحاول مرة أخرى')} retryLabel={t('حاول مرة أخرى')} onRetry={retryQr} />}
                {qr.status === 'ready' && qr.data && <div className="space-y-3 text-center"><img src={qr.data} alt={t('رمز QR لفتح محادثة واتساب')} className="size-56 bg-white p-2" /><p className="text-caption text-muted-foreground" dir="ltr">{target}</p></div>}
              </div>
            ) : tool === 'click-to-chat' ? (
              <div className="mt-4 space-y-3">
                <div className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3"><code className="block min-w-max font-mono text-caption" dir="ltr">{target}</code></div>
                <a href={target || '#'} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-2 text-small font-medium ${target ? 'text-primary hover:underline' : 'pointer-events-none text-muted-foreground'}`} aria-disabled={!target}>
                  <ExternalLink className="size-4" aria-hidden />
                  {t('فتح رابط الاتصال')}
                </a>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-3"><code className="block min-w-max whitespace-pre-wrap break-all font-mono text-caption" dir="ltr">{embedCode || t('لا يمكن إنشاء الكود قبل ربط رقم')}</code></div>
                <p className="text-caption text-muted-foreground">{t('كود التضمين في وضع المعاينة حتى يتوفر نطاق عام وأداة منشورة.')}</p>
              </div>
            )}
          </section>
        </div>

        <aside className="min-w-0 space-y-4">
          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-preview-title">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="growth-preview-title" className="text-small font-semibold">{t('المعاينة')}</h2>
                <p className="mt-1 text-caption text-muted-foreground">{t('المحتوى الظاهر للزائر')}</p>
              </div>
              <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-1 text-micro font-semibold text-warning">{t('معاينة فقط')}</span>
            </div>
            <div className="mt-4 flex min-h-80 items-end justify-center overflow-hidden rounded-lg border border-border bg-muted/40 p-5">
              <div className={`w-full max-w-sm ${placement === 'start' ? 'me-auto' : 'ms-auto'}`}>
                <div className="rounded-lg border border-border bg-card p-4 shadow-card">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground"><MessageCircle className="size-5" aria-hidden /></div>
                    <div className="min-w-0"><p className="truncate text-small font-semibold">{branding?.productName || t('مساحة العمل')}</p><p className="text-caption text-muted-foreground">{t('نحن هنا للمساعدة')}</p></div>
                  </div>
                  <p className="mt-4 rounded-lg bg-muted p-3 text-small">{greeting || t('اكتب رسالة البداية')}</p>
                  <button type="button" className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-small font-semibold text-primary-foreground" style={{ justifyContent: placement === 'start' ? 'flex-start' : 'flex-end' }}>
                    <MessageCircle className="size-4" aria-hidden />
                    {buttonLabel || t('تحدث معنا')}
                  </button>
                  {branding?.footerText && <p className="mt-3 text-center text-micro text-muted-foreground">{branding.footerText}</p>}
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-domain-title">
            <div className="flex items-start gap-3">
              <Globe2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <h2 id="growth-domain-title" className="text-small font-semibold">{t('النطاق العام')}</h2>
                {branding?.customDomainVerified ? (
                  <p className="mt-1 text-caption text-success">{t('النطاق العام موثق')}: <span dir="ltr">{branding.customDomain}</span></p>
                ) : (
                  <>
                    <p className="mt-1 text-caption text-warning">{t('لا يوجد نطاق عام موثق')}</p>
                    <p className="mt-2 text-caption text-muted-foreground">{t('الرابط والرمز يعملان للاتصال بواتساب. أداة المحادثة تبقى في وضع المعاينة حتى توثيق نطاق عام.')}</p>
                    <Link href="/settings/general#branding" className="mt-3 inline-flex items-center gap-1 text-caption font-medium text-primary hover:underline">{t('إدارة النطاق')}<ExternalLink className="size-3.5" aria-hidden /></Link>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4" aria-labelledby="growth-attribution-title">
            <div className="flex items-start gap-3">
              <Globe2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0">
                <h2 id="growth-attribution-title" className="text-small font-semibold">{t('الإسناد')}</h2>
                <p className="mt-1 text-caption text-muted-foreground">{branding?.footerText || t('لا يوجد سطر إسناد مخصص')}</p>
                {!branding?.canCustomizeFooter && <p className="mt-2 text-caption text-muted-foreground">{t('يُفرض سطر الإسناد حسب باقة مساحة العمل.')}</p>}
                <Link href="/settings/general#branding" className="mt-3 inline-flex items-center gap-1 text-caption font-medium text-primary hover:underline">{t('إدارة العلامة التجارية')}<ExternalLink className="size-3.5" aria-hidden /></Link>
              </div>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
