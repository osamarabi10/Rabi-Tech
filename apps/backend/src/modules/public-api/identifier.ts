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

/**
 * Refuse a phone: or email: identifier once an organization has more than one
 * organization.
 *
 * ## The temporary state this encodes, and the condition that ends it
 *
 * A phone number identifies one contact per WORKSPACE now, not one per
 * organization. An API token, however, is scoped to an organization: ApiToken
 * is not one of the four workspace-scoped models, and giving it a workspace is
 * a change to the token model, its issuing UI and its documentation — too much
 * to carry into a commit whose subject is scope enforcement.
 *
 * So while every organization has exactly one organization, resolving against the
 * default is not merely convenient, it is EXACTLY correct: there is one answer
 * and this finds it. The moment a second organization exists that stops being
 * true, and the honest response is not to pick one. Returning a contact from
 * whichever organization sorted first would be a silent wrong answer on a PUT —
 * overwriting a record belonging to a different part of the business.
 *
 * Therefore: correct today, loud tomorrow. This is a deliberate temporary
 * state, and the condition that ends it is the first organization to create a
 * second organization. When token scoping lands, this function is deleted, not
 * relaxed.
 *
 * id: identifiers are unaffected — a contact id is unique on its own and needs
 * no organization to disambiguate it.
 */
export async function assertRefUnambiguous(
  client: { workspace: { count: (args?: any) => Promise<number> } },
  ref: ContactRef,
): Promise<void> {
  if (!ref.ok || ref.kind === 'id') return;

  const workspaces = await client.workspace.count();
  if (workspaces <= 1) return;

  throw new AmbiguousIdentifierError(
    `This organization has ${workspaces} workspaces, so "${ref.kind}:" no longer identifies one `
    + 'contact: the same address can belong to a different person in each workspace. '
    + 'Address the contact by "id:<id>", which is unambiguous, until API tokens can be '
    + 'scoped to a workspace.',
  );
}

/** Thrown by assertRefUnambiguous; the routes map it to a 400. */
export class AmbiguousIdentifierError extends Error {}

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
