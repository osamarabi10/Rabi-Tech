/**
 * Locale-aware time and date formatting for non-component modules.
 *
 * The formatters here used to pass a hardcoded `'ar'` locale, so an English
 * interface rendered message timestamps as "04:36 م" — Arabic meridiem markers
 * inside an otherwise-English screen. Components can read the locale from the
 * i18n context; `lib/data.ts` and other plain modules cannot, so they read the
 * same persisted value the provider writes.
 *
 * Reading `localStorage` directly rather than threading the locale through
 * every caller keeps the two in step without a second source of truth: the
 * provider owns the key, this only observes it.
 */

const LOCALE_KEY = 'rabitech_locale';

/** BCP-47 tags for the three supported interface languages. */
const INTL_LOCALE: Record<string, string> = {
  ar: 'ar',
  he: 'he-IL',
  en: 'en-GB',
};

export function activeIntlLocale(): string {
  if (typeof window === 'undefined') return INTL_LOCALE.ar;
  const saved = window.localStorage.getItem(LOCALE_KEY);
  return INTL_LOCALE[saved ?? 'ar'] ?? INTL_LOCALE.ar;
}

export function formatTimeOfDay(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  // 12-hour, with the meridiem the *active* locale uses: ص/م in Arabic, am/pm
  // in English and Hebrew. The bug this file exists to fix was never the clock
  // — it was the hardcoded Arabic locale, which printed "م" inside an English
  // screen. Passing the live locale keeps the familiar 12-hour reading while
  // letting each language render its own marker.
  return date.toLocaleTimeString(activeIntlLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString(activeIntlLocale());
}
