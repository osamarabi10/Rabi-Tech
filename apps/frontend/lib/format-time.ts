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
  // en-GB rather than en-US on purpose: a 24-hour clock avoids AM/PM entirely,
  // which is what the operators of this product actually use.
  return date.toLocaleTimeString(activeIntlLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString(activeIntlLocale());
}
