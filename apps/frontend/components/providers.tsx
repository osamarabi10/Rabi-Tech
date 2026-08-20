'use client';

import { Toaster } from '@/components/ui/sonner';
import { BrandingProvider } from '@/lib/branding-context';
import type { Branding } from '@/lib/branding';
import { I18nProvider, useT } from '@/lib/i18n';

function ThemedToaster() {
  const { locale } = useT();
  return <Toaster position="bottom-center" richColors dir={locale === 'en' ? 'ltr' : 'rtl'} />;
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
      <I18nProvider>
        {children}
        <ThemedToaster />
      </I18nProvider>
    </BrandingProvider>
  );
}
