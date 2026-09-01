/**
 * The timezone a broadcast recipient is probably in.
 *
 * ## "Probably" is the honest word, and it shapes the whole design
 *
 * A phone number does not carry a timezone. It carries a country code, and a
 * country code is only a timezone for countries that have one. `+1` spans six.
 * `+7` spans eleven. Treating a prefix as a timezone would be precise-looking
 * and wrong, and the failure is invisible: a message arrives at 03:00 for
 * somebody the system believed was at 13:00.
 *
 * So this map carries **only single-timezone countries**, and everything else
 * resolves to the organization's own timezone. That default is not a
 * compromise — it is usually right. A small business broadcasting to its own
 * customers is broadcasting to people in its own city, and the org timezone is
 * the one an owner actually understands when they set "no messages after nine".
 *
 * ## Why `countryCode` beats the prefix when it is set
 *
 * `Contact.countryCode` is filled by the CSV import and editable in the contact
 * panel, which means a human asserted it. A prefix is inferred. Where both
 * exist the asserted one wins.
 *
 * Numbers here are stored digits-only with no leading `+` (see the inbound
 * worker), so the prefixes are matched against that form.
 */

/**
 * ISO-3166 alpha-2 → IANA zone, restricted to countries with a single zone.
 *
 * Deliberately short. It covers this product's market and its neighbours, and a
 * country absent from here is not a bug — it falls back to the organization's
 * timezone, which is the safe answer. Adding a multi-zone country to this map
 * would be the bug.
 */
const COUNTRY_ZONES: Record<string, string> = {
  PS: 'Asia/Hebron',
  IL: 'Asia/Jerusalem',
  JO: 'Asia/Amman',
  LB: 'Asia/Beirut',
  SY: 'Asia/Damascus',
  EG: 'Africa/Cairo',
  SA: 'Asia/Riyadh',
  AE: 'Asia/Dubai',
  QA: 'Asia/Qatar',
  KW: 'Asia/Kuwait',
  BH: 'Asia/Bahrain',
  OM: 'Asia/Muscat',
  IQ: 'Asia/Baghdad',
  TR: 'Europe/Istanbul',
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  DE: 'Europe/Berlin',
  FR: 'Europe/Paris',
  IT: 'Europe/Rome',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
};

/**
 * Dialling prefix → country, longest-match first.
 *
 * `970` and `972` are both here and both resolve to a Palestinian/Israeli zone
 * one minute apart in practice — which is the point: this map exists to be
 * right about the market this product serves, and approximately right
 * elsewhere.
 *
 * Multi-timezone countries are absent on purpose. `1` and `7` do not appear.
 */
const PREFIX_COUNTRIES: Array<[string, string]> = [
  ['970', 'PS'], ['972', 'IL'], ['962', 'JO'], ['961', 'LB'], ['963', 'SY'],
  ['20', 'EG'], ['966', 'SA'], ['971', 'AE'], ['974', 'QA'], ['965', 'KW'],
  ['973', 'BH'], ['968', 'OM'], ['964', 'IQ'], ['90', 'TR'], ['44', 'GB'],
  ['353', 'IE'], ['49', 'DE'], ['33', 'FR'], ['39', 'IT'], ['31', 'NL'],
  ['32', 'BE'], ['46', 'SE'], ['47', 'NO'], ['45', 'DK'],
].sort((a, b) => b[0].length - a[0].length) as Array<[string, string]>;

export function resolveContactTimezone(input: {
  countryCode?: string | null;
  phone?: string | null;
  organizationTimezone: string;
}): { timezone: string; source: 'country' | 'prefix' | 'organization' } {
  const asserted = input.countryCode?.trim().toUpperCase();
  if (asserted && COUNTRY_ZONES[asserted]) {
    return { timezone: COUNTRY_ZONES[asserted], source: 'country' };
  }

  const digits = (input.phone || '').replace(/[^\d]/g, '');
  if (digits) {
    for (const [prefix, country] of PREFIX_COUNTRIES) {
      if (digits.startsWith(prefix) && COUNTRY_ZONES[country]) {
        return { timezone: COUNTRY_ZONES[country], source: 'prefix' };
      }
    }
  }

  return { timezone: input.organizationTimezone, source: 'organization' };
}

/** Minutes past local midnight, in `timezone`. */
function localMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  // Intl renders midnight as 24 in some locales' hourCycle. Normalise, or a
  // window starting at 00:00 never matches for the first hour of the day.
  return (hour % 24) * 60 + minute;
}

function parseTime(value: string): number {
  const [h, m] = String(value).split(':').map((n) => parseInt(n, 10));
  return ((h || 0) % 24) * 60 + (m || 0);
}

/**
 * Whether `at` falls inside a quiet window, and when that window ends.
 *
 * The window normally wraps midnight — "21:00 to 08:00" is the shape an owner
 * writes — so a naive `start <= now < end` is false for every useful setting.
 * Both orientations are handled: wrapping windows match outside the range,
 * same-day windows match inside it.
 *
 * Returns the delay in milliseconds until the window ends, which is what the
 * caller needs: a recipient in quiet hours is not skipped, they are sent later.
 */
export function quietWindow(input: {
  at: Date;
  timezone: string;
  start: string;
  end: string;
}): { quiet: boolean; msUntilOver: number } {
  const now = localMinutes(input.at, input.timezone);
  const start = parseTime(input.start);
  const end = parseTime(input.end);

  // A window of zero width is not a window. Treated as "no quiet hours" rather
  // than as "always quiet", which would silently stop every broadcast.
  if (start === end) return { quiet: false, msUntilOver: 0 };

  const wraps = start > end;
  const quiet = wraps ? now >= start || now < end : now >= start && now < end;
  if (!quiet) return { quiet: false, msUntilOver: 0 };

  const minutesUntilEnd = now < end ? end - now : 24 * 60 - now + end;
  return { quiet: true, msUntilOver: minutesUntilEnd * 60_000 };
}
