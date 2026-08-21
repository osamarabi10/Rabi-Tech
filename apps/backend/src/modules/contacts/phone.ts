/**
 * Phone normalization for contact import.
 *
 * ## Why this does not produce `+E.164`
 *
 * Contacts are stored **digits only** — `972542030590`, no `+`. That is not an
 * oversight: inbound WhatsApp addresses arrive as `972542030590@c.us` and the
 * inbound path strips the suffix and any leading `+` before matching
 * (`normalizedDirectAddress` in modules/usage/entitlements.ts).
 *
 * So an import that stored `+972542030590` would create a contact that never
 * matches their own incoming message. The customer messages in, the system does
 * not recognise them, and a *second* contact is created with the same person's
 * number. That is the worst possible outcome for a contacts import: it looks
 * like it worked.
 *
 * The number is therefore *validated* as E.164 and *stored* in the form the rest
 * of the system already uses. `displayE164()` exists so the UI can still show
 * the `+` form the user expects to see.
 */

/** E.164 allows 15 digits total, and no real number is shorter than 8. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export type PhoneResult =
  | { ok: true; phone: string }
  | { ok: false; reason: string };

/**
 * Normalize a raw CSV cell to storage form.
 *
 * `defaultCountryCode` (digits, e.g. "972") rescues the most common real-world
 * spreadsheet: local numbers with a leading zero and no country code. Without
 * it, an otherwise valid export is entirely rejected, which pushes people into
 * editing the CSV by hand — where they make worse mistakes.
 */
export function normalizePhone(raw: unknown, defaultCountryCode?: string): PhoneResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'phone is empty' };

  // Spreadsheets emit +972-54 203 0590, (054) 203-0590, and 972.54.203.0590.
  let digits = text.replace(/[\s()\-.‏‎]/g, '');
  const hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);
  // A leading 00 is the other way people write an international prefix.
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);

  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'phone contains non-numeric characters' };

  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  if (!hadPlus && cc && digits.startsWith('0')) {
    // National form: drop the trunk zero and prepend the country code.
    digits = cc + digits.slice(1);
  } else if (!hadPlus && cc && digits.length <= 10 && !digits.startsWith(cc)) {
    // Bare local number with no trunk zero.
    digits = cc + digits;
  }

  if (digits.startsWith('0')) {
    return { ok: false, reason: 'phone is missing a country code' };
  }
  if (digits.length < MIN_DIGITS) return { ok: false, reason: 'phone is too short' };
  if (digits.length > MAX_DIGITS) return { ok: false, reason: 'phone is too long' };

  return { ok: true, phone: digits };
}

/** The `+` form, for display only. Never stored. */
export function displayE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}
