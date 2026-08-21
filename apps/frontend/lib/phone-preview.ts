/**
 * Client-side mirror of the server's phone normalization.
 *
 * Exists only so the preview table can flag bad rows *before* a large file is
 * uploaded — the server's `modules/contacts/phone.ts` remains the authority and
 * re-validates every row. Keep the two in step; if they ever disagree, the
 * server wins and the preview was merely optimistic.
 *
 * Note what this deliberately does NOT do: it does not produce `+E.164`.
 * Contacts are stored digits-only because inbound WhatsApp addresses normalize
 * to that form, and a stored `+` would mean an imported contact never matches
 * their own incoming message. `displayE164` is for showing, not storing.
 */

/**
 * Stable reason codes, not display text.
 *
 * Returning a rendered Arabic string here is what made the preview show Arabic
 * errors inside an English interface: the component had nothing to translate.
 * The caller maps these through `t()`.
 */
export type PhoneReason = 'empty' | 'non_numeric' | 'no_country_code' | 'too_short' | 'too_long';

export type PreviewPhone = { ok: true; phone: string } | { ok: false; reason: PhoneReason };

const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function previewPhone(raw: unknown, defaultCountryCode?: string): PreviewPhone {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  let digits = text.replace(/[\s()\-.‏‎]/g, '');
  const hadPlus = digits.startsWith('+');
  if (hadPlus) digits = digits.slice(1);
  if (!hadPlus && digits.startsWith('00')) digits = digits.slice(2);

  if (!/^\d+$/.test(digits)) return { ok: false, reason: 'non_numeric' };

  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  if (!hadPlus && cc && digits.startsWith('0')) {
    digits = cc + digits.slice(1);
  } else if (!hadPlus && cc && digits.length <= 10 && !digits.startsWith(cc)) {
    digits = cc + digits;
  }

  if (digits.startsWith('0')) return { ok: false, reason: 'no_country_code' };
  if (digits.length < MIN_DIGITS) return { ok: false, reason: 'too_short' };
  if (digits.length > MAX_DIGITS) return { ok: false, reason: 'too_long' };

  return { ok: true, phone: digits };
}

export const displayE164 = (phone: string) => (phone.startsWith('+') ? phone : `+${phone}`);

/** Arabic source strings for each code, to be passed through `t()`. */
export const PHONE_REASON_LABELS: Record<PhoneReason | 'no_phone_column', string> = {
  empty: 'رقم فارغ',
  non_numeric: 'يحتوي أحرفًا غير رقمية',
  no_country_code: 'ينقصه رمز الدولة',
  too_short: 'قصير جدًا',
  too_long: 'طويل جدًا',
  no_phone_column: 'لم يتم تحديد عمود الهاتف',
};
