import { PlanCode, normalizePlanCode } from './plans';

/**
 * Validation for platform-owner commercial terms.
 *
 * Lives beside the resolver rather than inline in the route so the tenancy
 * harness can exercise the rules directly, and so the console can eventually
 * share the same value bounds instead of re-deriving them.
 */

export class CommercialTermsError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'CommercialTermsError';
  }
}

export function isCommercialTermsError(error: unknown): error is CommercialTermsError {
  return error instanceof CommercialTermsError;
}

/** The commercial columns, as they exist on a row. */
export type CommercialState = {
  planOverride: string | null;
  macQuotaOverride: number | null;
  discountPercent: number | null;
  creditCents: number;
  overrideReason: string | null;
  overrideExpiresAt: Date | null;
};

export type CommercialPatch = Partial<CommercialState>;

/** `undefined` means "not supplied"; `null` means "clear it". */
function supplied(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

function optionalInt(
  value: unknown,
  label: string,
  { min, max }: { min: number; max?: number },
): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new CommercialTermsError(`${label} must be a whole number`);
  }
  if (parsed < min) throw new CommercialTermsError(`${label} cannot be below ${min}`);
  if (max !== undefined && parsed > max) {
    throw new CommercialTermsError(`${label} cannot be above ${max}`);
  }
  return parsed;
}

function optionalPlan(value: unknown): string | null {
  if (value === null || value === '' || value === 'NONE') return null;
  try {
    return normalizePlanCode(value) as PlanCode;
  } catch {
    throw new CommercialTermsError('Plan override must be FREE, GROWTH, BUSINESS or ENTERPRISE');
  }
}

function optionalDate(value: unknown, now: Date): Date | null {
  if (value === null || value === '') return null;
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new CommercialTermsError('Expiry is not a valid date');
  // An override that is already expired when it is saved would be accepted by
  // the database and then ignored by the resolver — silently doing nothing,
  // which reads as a bug rather than as a rejected input.
  if (parsed <= now) throw new CommercialTermsError('Expiry must be in the future');
  return parsed;
}

/**
 * Build the patch to apply, validating it against the row it will be applied to.
 *
 * Only supplied keys are touched: a PATCH that omits `creditCents` must not
 * zero it.
 */
export function parseCommercialPatch(
  body: Record<string, unknown>,
  current: CommercialState,
  now = new Date(),
): CommercialPatch {
  const patch: CommercialPatch = {};

  if (supplied(body, 'planOverride')) patch.planOverride = optionalPlan(body.planOverride);
  if (supplied(body, 'macQuotaOverride')) {
    patch.macQuotaOverride = optionalInt(body.macQuotaOverride, 'MAC quota', { min: 0 });
  }
  if (supplied(body, 'discountPercent')) {
    patch.discountPercent = optionalInt(body.discountPercent, 'Discount', { min: 0, max: 100 });
  }
  if (supplied(body, 'creditCents')) {
    const credit = optionalInt(body.creditCents, 'Credit', { min: 0 });
    // creditCents is NOT NULL with a default of 0; clearing it means zero.
    patch.creditCents = credit ?? 0;
  }
  if (supplied(body, 'overrideExpiresAt')) {
    patch.overrideExpiresAt = optionalDate(body.overrideExpiresAt, now);
  }
  if (supplied(body, 'overrideReason')) {
    const reason = body.overrideReason === null ? null : String(body.overrideReason).trim();
    patch.overrideReason = reason || null;
  }

  const merged = { ...current, ...patch };

  // Note "would result in", not "was supplied": clearing planOverride while
  // macQuotaOverride stays set still leaves an overridden organization, so a
  // reason is still required. creditCents is excluded — a credit is a
  // bookkeeping entry, not an entitlement exception.
  const overridden =
    merged.planOverride !== null ||
    merged.macQuotaOverride !== null ||
    merged.discountPercent !== null ||
    merged.overrideExpiresAt !== null;

  if (overridden && !merged.overrideReason) {
    throw new CommercialTermsError('A reason is required whenever any override is set');
  }

  // An expiry with nothing to expire is meaningless and would make the CHECK
  // constraint demand a reason for an organization that has no override.
  if (merged.overrideExpiresAt !== null
    && merged.planOverride === null
    && merged.macQuotaOverride === null
    && merged.discountPercent === null) {
    throw new CommercialTermsError('Expiry needs an override to expire');
  }

  return patch;
}

/** True when the resulting row carries any entitlement exception. */
export function hasLiveOverrideFields(state: CommercialState): boolean {
  return state.planOverride !== null
    || state.macQuotaOverride !== null
    || state.discountPercent !== null;
}
