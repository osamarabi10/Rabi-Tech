import crypto from 'crypto';

/**
 * The click marker that travels inside the visitor's own message.
 *
 * ## Why it is visible, and why that is not a flaw to engineer away
 *
 * A `wa.me/...?text=` link pre-fills the visitor's composer. They see what they
 * are about to send, and they can edit or delete any of it before sending. So
 * this marker is read by a human every single time it is used, and attribution
 * through this route is **best-effort by construction**. No token design fixes
 * that, and any report built on it must show what it missed alongside what it
 * caught.
 *
 * What the design can do is make the marker read as *deliberate* rather than as
 * a bug. `#gw_a1b2c3d4e5` looks like a reference code; a bare random string
 * looks like something went wrong and invites deletion.
 *
 * ## The alphabet
 *
 * Crockford base32 — no `i`, `l`, `o` or `u`. Ten characters is 50 bits, far
 * more than collision resistance needs here. The length is chosen against a
 * different constraint: long enough not to collide, short enough that the
 * marker does not dominate the message the customer is sending. Guessing is not
 * the threat — a guessed token buys an attacker a wrong attribution row, which
 * is worth nothing to them.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export const CLICK_TOKEN_LENGTH = 10;
export const CLICK_TOKEN_MARKER = '#gw_';

/** Widget tokens sit in a URL rather than a message, so they can afford to be longer. */
export const WIDGET_TOKEN_LENGTH = 12;

function randomFrom(alphabet: string, length: number): string {
  // Rejection-free because 256 is not a multiple of 32; taking the low 5 bits of
  // each byte is uniform over a 32-character alphabet.
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] & 31];
  return out;
}

export function newClickToken(): string {
  return randomFrom(ALPHABET, CLICK_TOKEN_LENGTH);
}

export function newWidgetToken(): string {
  return randomFrom(ALPHABET, WIDGET_TOKEN_LENGTH);
}

/** The marker as it appears in the pre-filled text. */
export function formatClickMarker(clickToken: string): string {
  return `${CLICK_TOKEN_MARKER}${clickToken}`;
}

/**
 * Pull candidate click tokens out of an inbound message body.
 *
 * **This decides nothing.** It extracts strings that have the shape of a marker;
 * whether any of them means anything is settled by looking one up in
 * `WidgetClick` and finding it unclaimed. That separation is deliberate: a
 * customer can type `#gw_` followed by ten characters by accident or on
 * purpose, and pattern-matching the body would let them assign themselves to a
 * campaign. The table is the authority, the regex is only a filter.
 *
 * Returns every match rather than the first, because the marker is appended to
 * text the customer may have edited around, and taking only the first would
 * lose a real token sitting behind a stray one.
 */
export function extractClickTokens(body: string): string[] {
  if (!body) return [];
  const pattern = new RegExp(`${CLICK_TOKEN_MARKER}([${ALPHABET}]{${CLICK_TOKEN_LENGTH}})`, 'g');
  const found: string[] = [];
  for (const match of body.matchAll(pattern)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/**
 * The `wa.me` destination, with the marker appended to the widget's prefill.
 *
 * The phone number is digits only — `wa.me` rejects `+` and separators, and this
 * codebase already stores numbers digits-only for the same reason.
 */
export function buildWhatsAppHandoff(phone: string, prefillText: string, clickToken: string): string {
  const digits = phone.replace(/\D/g, '');
  const text = [prefillText.trim(), formatClickMarker(clickToken)].filter(Boolean).join(' ');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
