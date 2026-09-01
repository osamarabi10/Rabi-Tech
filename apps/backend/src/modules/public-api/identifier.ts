import { Prisma } from '@prisma/client';
import { normalizePhone } from '../contacts/phone';

/**
 * The contact identifier grammar: `id:`, `phone:`, `email:`.
 *
 * Borrowed from Respond.io, whose API takes `id:123`, `phone:+60121233112` or
 * `email:x@y.com` in one path segment. It is the right shape for a public API
 * and worth copying exactly, because integrators moving between the two should
 * not have to learn a second convention for the same idea.
 *
 * ## The prefix is required
 *
 * A bare value cannot be disambiguated safely. `972501234567` is a plausible
 * phone number and a plausible external id; guessing wrong does not error, it
 * silently addresses **a different contact** — and on a `PUT` that means
 * overwriting someone else's record. So an unprefixed identifier is a 400 with
 * the grammar in the message, rather than a guess.
 *
 * ## Phone numbers are normalised before lookup
 *
 * Stored phones are E.164 digits. A caller sending `+972-50-123-4567` and one
 * sending `972501234567` mean the same contact, and an API that finds the
 * record for only one of them produces duplicate contacts through nobody's
 * fault. `normalizePhone` is the same function the inbound webhook uses, so the
 * API and WhatsApp agree on identity.
 */

export type ContactRef =
  | { ok: true; kind: 'id' | 'phone' | 'email'; where: Prisma.ContactWhereInput; value: string }
  | { ok: false; message: string };

const KINDS = ['id', 'phone', 'email'] as const;

export function parseContactRef(raw: unknown, defaultCountryCode?: string): ContactRef {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'A contact identifier is required.' };

  const separator = text.indexOf(':');
  if (separator <= 0) {
    return {
      ok: false,
      message: `Identify the contact as "id:<id>", "phone:<number>" or "email:<address>". Received "${text.slice(0, 40)}".`,
    };
  }

  const kind = text.slice(0, separator).toLowerCase() as (typeof KINDS)[number];
  const value = text.slice(separator + 1).trim();
  if (!(KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: `Unknown identifier type "${kind}". Use id, phone or email.` };
  }
  if (!value) return { ok: false, message: `The ${kind} identifier is empty.` };

  if (kind === 'id') return { ok: true, kind, where: { id: value }, value };

  if (kind === 'email') {
    // Stored lower-cased; matching case-sensitively would create a second
    // contact for the same mailbox on the next create_or_update.
    const email = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { ok: false, message: `"${value.slice(0, 60)}" is not a valid email address.` };
    }
    return { ok: true, kind, where: { email }, value: email };
  }

  const phone = normalizePhone(value, defaultCountryCode);
  if (!phone.ok) {
    return { ok: false, message: `"${value.slice(0, 40)}" is not a usable phone number: ${phone.reason}` };
  }
  return { ok: true, kind, where: { phone: phone.phone }, value: phone.phone };
}
