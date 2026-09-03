'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { Menu } from 'lucide-react';
import { AppSidebar } from '@/components/app-sidebar';
import { WorkspaceSwitcher } from '@/components/workspace-switcher';
import { BrandLogo } from '@/components/brand-logo';
import { EntitlementsProvider } from '@/lib/entitlements';
import { DashboardFooter } from '@/components/dashboard-footer';
import { TrialBanner } from '@/components/trial-banner';
import { ServiceStateBanner } from '@/components/service-state-banner';
import { useT } from '@/lib/i18n';
import { useTheme } from '@/lib/theme';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { t, setLocale } = useT();
  const { setTheme } = useTheme();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('rabitech_token');
    if (!token || token === 'demo') {
      localStorage.removeItem('rabitech_token');
      localStorage.removeItem('rabitech_user');
      router.replace('/login');
      return;
    }
    api
      .get('/api/auth/me')
      .then((res) => {
        localStorage.setItem('rabitech_user', JSON.stringify(res.data));
        if (['ar', 'he', 'en'].includes(res.data.locale)) setLocale(res.data.locale);
        if (['light', 'dark', 'system'].includes(res.data.theme)) setTheme(res.data.theme);
        setReady(true);
      })
      .catch((err) => {
        // A platform owner with no subscriber selected is legitimately signed in
        // — they just have no tenant to show. Send them to the console instead of
        // destroying a valid session.
        if (err?.response?.status === 403) {
          router.replace('/platform');
          return;
        }
        localStorage.removeItem('rabitech_token');
        localStorage.removeItem('rabitech_user');
        router.replace('/login');
      });
  }, [router, setLocale, setTheme]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        {t('جاري التحقق من الجلسة...')}
      </div>
    );
  }

  return (
    <EntitlementsProvider>
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/*
          Phones have no room for a 220px rail beside the content, so the rail
          becomes a drawer and this bar carries the only way to open it.
        */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label={t('فتح القائمة')}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <BrandLogo size="sm" showText={false} />
        </div>
        {/*
          Above the content and below the nav, on every dashboard page: a
          countdown that only appears on one screen is one a tenant meets by
          accident, and this one is telling them their access ends today.
        */}
        {/*
          Billing trouble outranks the trial countdown: a workspace with an
          overdue invoice has a harder deadline than one with hours left, and
          the two never apply at once anyway.
        */}
        <WorkspaceSwitcher />
        <ServiceStateBanner />
        <TrialBanner />
        {children}
        <DashboardFooter />
      </main>
    </div>
    </EntitlementsProvider>
  );
}
