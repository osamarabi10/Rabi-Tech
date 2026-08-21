'use client';

import { Toaster } from '@/components/ui/sonner';
import { BrandingProvider } from '@/lib/branding-context';
import type { Branding } from '@/lib/branding';
import { I18nProvider, useT } from '@/lib/i18n';
import { ThemeProvider, useTheme } from '@/lib/theme';
import { DensityProvider } from '@/lib/density';

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
