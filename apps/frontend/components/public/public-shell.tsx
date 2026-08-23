'use client';

import Link from 'next/link';
import { Globe } from 'lucide-react';
import { BrandLogo } from '@/components/brand-logo';
import { LOCALES, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Header, footer and language switch for the pages a visitor sees before they
 * have an account.
 *
 * The public pages were English-only server components while the product they
 * advertise ships in Arabic, Hebrew and English. A Palestinian business owner
 * arriving at the landing page was told about a WhatsApp product for local
 * service teams in the one language the interface would not be using.
 *
 * The switch is visible rather than automatic. Inside the app the locale is a
 * saved preference; a first-time visitor has none, and guessing from
 * `Accept-Language` gets it wrong for exactly the bilingual users this product
 * serves — plenty of whom browse with an English-configured phone and want the
 * Arabic.
 */

export function PublicShell({ children }: { children: React.ReactNode }) {
  // One list, from the module that owns it: a second copy here would drift the
  // first time a language is added.
  const { t, locale, setLocale } = useT();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <BrandLogo />
          </Link>

          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
              role="group"
              aria-label={t('اللغة')}
            >
              <Globe className="mx-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              {LOCALES.map((language) => (
                <button
                  key={language.code}
                  type="button"
                  onClick={() => setLocale(language.code)}
                  aria-pressed={locale === language.code}
                  className={cn(
                    'rounded px-2 py-1 text-caption transition-colors',
                    locale === language.code
                      ? 'bg-primary/10 font-semibold text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {language.label}
                </button>
              ))}
            </div>

            <Link
              href="/login"
              className="rounded-md border border-border px-3 py-1.5 text-caption font-medium hover:bg-accent"
            >
              {t('دخول')}
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-5 text-caption text-muted-foreground">
          <span>© RabiTech</span>
          <div className="flex flex-wrap gap-4">
            <Link href="/pricing" className="hover:text-foreground">{t('الأسعار')}</Link>
            <Link href="/signup" className="hover:text-foreground">{t('إنشاء حساب')}</Link>
            <Link href="/login" className="hover:text-foreground">{t('دخول')}</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
