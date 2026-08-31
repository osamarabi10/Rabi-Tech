import { prisma } from '../../prisma';

/**
 * Which currencies the platform is allowed to write onto a finance document.
 *
 * The answer is derived from the active Plan rows rather than a constant: the
 * currencies the platform can invoice in are exactly the ones it sells in, and
 * keeping a second list in code guarantees the two disagree the first time a
 * plan's currency changes.
 *
 * This lives in the backend because it is a rule about what may be written,
 * not about what may be displayed. A component that picks a currency is
 * guessing; by the time a value reaches a component the decision has already
 * been made and stored.
 *
 * Deliberately not a tax or jurisdiction rule — see finance.service.ts.
 */

export class CurrencyPolicyError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Distinct currencies across active plans, uppercased, sorted for stable output.
 *
 * Deliberately NOT filtered by archivedAt, unlike listPlans(). This gates what
 * may be written onto a finance document, and a subscriber on a withdrawn
 * edition still gets invoiced - in the currency their plan is priced in. Adding
 * archivedAt here would refuse their renewal the moment the edition was
 * archived, because assertSellableCurrency() fails closed by design and the
 * archived plan's currency would no longer appear in the allowed set.
 *
 * "What may we still charge in" is a resolution question, not an offer one.
 * Archiving stops the selling; it does not stop the billing.
 */
export async function sellableCurrencies(): Promise<string[]> {
  const rows = await prisma.plan.findMany({
    where: { isActive: true },
    select: { currency: true },
    distinct: ['currency'],
  });
  return rows
    .map((row) => row.currency?.trim().toUpperCase())
    .filter((code): code is string => Boolean(code))
    .sort();
}

/**
 * Resolve a caller-supplied currency, or refuse.
 *
 * Refuses three things that used to fall through to a default: a missing
 * value, a blank one, and one no active plan sells in. Defaulting here is what
 * puts an invoice in the wrong currency and makes the amount on it wrong by
 * whatever the exchange rate happens to be — an error nothing downstream can
 * detect, because the number itself is well-formed.
 */
export async function assertSellableCurrency(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CurrencyPolicyError('currency is required', 400);
  }
  const currency = raw.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CurrencyPolicyError('currency must be a three-letter code', 400);
  }

  const allowed = await sellableCurrencies();
  if (allowed.length === 0) {
    // Fails closed. No active plan means there is no answer to "what do we
    // sell in", and inventing one here would be the same guess this module
    // exists to prevent.
    throw new CurrencyPolicyError(
      'No active plan defines a currency, so no currency can be invoiced yet',
      409,
    );
  }
  if (!allowed.includes(currency)) {
    throw new CurrencyPolicyError(
      `currency ${currency} is not sold by any active plan (allowed: ${allowed.join(', ')})`,
      400,
    );
  }
  return currency;
}
