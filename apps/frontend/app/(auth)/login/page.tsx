'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Wifi, WifiOff, Eye, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { BrandLogo } from '@/components/brand-logo';
import { useBranding } from '@/lib/branding-context';

export default function LoginPage() {
  const { t } = useT();
  const branding = useBranding();
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [showPass, setShowPass]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const [serverOk, setServerOk]   = useState<boolean | null>(null);
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem('rabitech_token');
    if (token && token !== 'demo') {
      const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
      router.replace(user.scope === 'PLATFORM' ? '/platform/subscribers' : '/inbox');
      return;
    }
    if (token === 'demo') {
      localStorage.removeItem('rabitech_token');
      localStorage.removeItem('rabitech_user');
    }
    api.get('/health').then(() => setServerOk(true)).catch(() => setServerOk(false));
  }, [router]);

  const login = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/login', { email, password });
      localStorage.setItem('rabitech_token', data.token);
      localStorage.setItem('rabitech_user', JSON.stringify(data.user));
      router.push(data.scope === 'PLATFORM' ? '/platform/subscribers' : '/inbox');
    } catch {
      toast.error(t('البريد الإلكتروني أو كلمة المرور غير صحيحة — أو الخادم غير متصل'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/*
        A single soft wash instead of the old blurred glows — those were tuned
        for a near-black canvas and read as smudges on a light background.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-gradient-to-b from-primary/[0.06] to-transparent"
      />

      <div className="relative z-10 w-full max-w-[380px] space-y-6">
        {/* Logo mark */}
        <div className="flex flex-col items-center gap-3">
          <BrandLogo size="lg" showText={false} />
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              {branding.productName}
            </h1>
            <p className="text-sm text-muted-foreground">{t('تسجيل الدخول للوحة التحكم')}</p>
          </div>
        </div>

        {/* Server status pill */}
        {serverOk !== null && (
          <div
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs',
              serverOk
                ? 'border-success/30 bg-success/12 text-success'
                : 'border-destructive/20 bg-destructive/8 text-destructive',
            )}
          >
            {serverOk ? (
              <Wifi className="mt-px h-3.5 w-3.5 shrink-0" />
            ) : (
              <WifiOff className="mt-px h-3.5 w-3.5 shrink-0" />
            )}
            <div className="space-y-1">
              {serverOk ? (
                <>
                  <p className="font-medium">{t('متصل بالخادم')}</p>
                </>
              ) : (
                <>
                  <p className="font-medium">{t('تعذّر الاتصال بالخادم')}</p>
                  <p className="text-destructive/70">{t('جرّب تحديث الصفحة، وإذا استمرت المشكلة تواصل مع الدعم')}</p>
                </>
              )}
            </div>
          </div>
        )}

        {/* Form card */}
        <div className="rounded-xl border border-border bg-card p-6 shadow-card space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="email" className="text-xs font-medium text-muted-foreground">
              {t('البريد الإلكتروني')}
            </Label>
            <Input
              id="email"
              type="email"
              dir="ltr"
              className="h-10 text-sm"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && login()}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              {t('كلمة المرور')}
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPass ? 'text' : 'password'}
                dir="ltr"
                className="h-10 pe-10 text-sm"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && login()}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <Button
            className="mt-1 h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-glow-sm hover:shadow-glow transition-shadow"
            onClick={login}
            disabled={loading || serverOk === false}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span className="h-4 w-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                {t('جاري الدخول...')}
              </span>
            ) : t('دخول')}
          </Button>
        </div>
      </div>
    </div>
  );
}
