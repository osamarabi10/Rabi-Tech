/**
 * The secret every signed URL in this platform is signed with.
 *
 * ## Why this exists (D-29)
 *
 * Four separate places signed with `process.env.JWT_SECRET || 'dev-secret'` or
 * `|| 'default-secret'`: media URLs, branding assets, Meta message media and
 * snippet attachments. If `JWT_SECRET` were ever absent, every one of them
 * would sign with a constant that is committed to a **public** repository — and
 * would do it silently, because a fallback that works is indistinguishable from
 * a fallback that is correct.
 *
 * A signed URL is not a convenience here. Possession of a valid signature *is*
 * the authorisation, because a browser cannot put an `Authorization` header on
 * an `<img src>`. So a predictable signing key does not degrade the feature; it
 * removes the access control from it entirely, for every tenant at once.
 *
 * ## Why the boot gate was not enough
 *
 * `verifySecrets()` lists `JWT_SECRET` as required and runs at startup, which
 * looks like it makes the fallbacks dead code. It does not:
 *
 * - Outside production it only **warns**.
 * - `ALLOW_INSECURE_SECRETS=1` downgrades it to a log line — and that flag is
 *   set on this deployment today, deliberately, while credentials are rotated.
 *
 * Both are correct behaviours for a boot gate: a half-finished credential
 * rotation should not take the platform down. Neither is a reason to sign with
 * a public constant in the meantime.
 *
 * ## Presence, not strength
 *
 * This checks only that a secret was configured. Minimum length lives in
 * `verify-secrets.ts` and belongs there — one policy in one place. Enforcing 32
 * characters here as well would also break CI, whose `JWT_SECRET` is 23
 * characters (`.github/workflows/tenancy-bleed.yml`), and a signing helper that
 * silently redefines the strength policy is its own version of this bug.
 */

export class SigningSecretMissingError extends Error {
  constructor() {
    super(
      'JWT_SECRET is not set. Signed URLs (media, branding, snippets) cannot be ' +
      'issued or verified without it, and will never fall back to a default key.',
    );
    this.name = 'SigningSecretMissingError';
  }
}

/**
 * Read at call time, never cached.
 *
 * A module-level constant would bind whatever the environment held at import,
 * which is the shape of D-12: a value captured from the wrong place, once, and
 * then wrong forever without anything saying so.
 */
export function signingSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) throw new SigningSecretMissingError();
  return secret;
}
