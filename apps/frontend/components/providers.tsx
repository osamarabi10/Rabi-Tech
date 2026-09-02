'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { Toaster } from '@/components/ui/sonner';
import { flushPendingCommits } from '@/components/ui/toast';
import { BrandingProvider } from '@/lib/branding-context';
import type { Branding } from '@/lib/branding';
import { I18nProvider, useT } from '@/lib/i18n';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';

/**
 * Flush any deferred toast commit when the route changes.
 *
 * `pagehide` and `beforeunload` in `ui/toast.tsx` cover leaving the site.
 * Neither fires on a Next.js client-side navigation, which is the common case —
 * archive something, click another destination inside the app, and without this
 * the scheduled write is dropped while its toast is unmounted. The user saw the
 * row disappear and no error, so they are certain it happened. That is silent
 * data loss, and it is the specific hazard the deferred-commit mode creates.
 */
function FlushDeferredCommitsOnNavigate() {
  const pathname = usePathname();
  const previous = useRef(pathname);

  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    flushPendingCommits();
  }, [pathname]);

  return null;
}

function ThemedToaster() {
  const { locale } = useT();
  const { resolved } = useTheme();
  // Sonner renders in a portal outside the themed tree, so it needs telling
  // which scheme it is in — otherwise toasts stay white on a dark page.
  return (
    <Toaster
      position="bottom-center"
      richColors
      theme={resolved}
      dir={locale === 'en' ? 'ltr' : 'rtl'}
    />
  );
}

export function Providers({
  branding,
  children,
}: {
  branding?: Branding;
  children: React.ReactNode;
}) {
  return (
    <BrandingProvider branding={branding}>
      <ThemeProvider>
        <I18nProvider>
          {/* Innermost: density is a view preference with no bearing on theme,
              locale or branding, so nothing above it needs to re-render when it
              changes. */}
          <DensityProvider>
            {children}
            <ThemedToaster />
          </DensityProvider>
        </I18nProvider>
      </ThemeProvider>
    </BrandingProvider>
  );
}
