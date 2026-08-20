import logger from './logger';

/**
 * Refuses to start with weak or missing secrets in production.
 *
 * This exists because the platform shipped with `POSTGRES_PASSWORD: secret`
 * hardcoded in docker-compose. A weak credential that nobody notices is worse
 * than one that crashes the process on boot — this makes it impossible to miss.
 */
const KNOWN_WEAK = new Set([
  'secret', 'password', 'changeme', 'change-me', 'dev-admin-key', 'admin',
  'test', 'postgres', '123456', 'letmein', 'default', 'rabitech',
]);

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'CHANNEL_ENCRYPTION_KEY',
] as const;

/** Secrets that must also clear a minimum length. */
const MIN_LENGTH: Record<string, number> = {
  JWT_SECRET: 32,
  CHANNEL_ENCRYPTION_KEY: 32,
};

function weak(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  if (KNOWN_WEAK.has(lowered)) return true;
  // A password embedded in a connection string, e.g. postgres://user:secret@host
  const inUrl = lowered.match(/:\/\/[^:]+:([^@]+)@/);
  return inUrl ? KNOWN_WEAK.has(inUrl[1]) : false;
}

export function verifySecrets(): void {
  const problems: string[] = [];

  for (const key of REQUIRED) {
    const value = process.env[key];
    if (!value?.trim()) {
      problems.push(`${key} is not set`);
      continue;
    }
    if (weak(value)) problems.push(`${key} uses a known-weak value`);
    const min = MIN_LENGTH[key];
    if (min && value.trim().length < min) {
      problems.push(`${key} is shorter than ${min} characters`);
    }
  }

  if (process.env.OPENWA_API_KEY && weak(process.env.OPENWA_API_KEY)) {
    problems.push('OPENWA_API_KEY uses a known-weak value');
  }

  if (problems.length === 0) return;

  // Deliberate, opt-in escape hatch. Rotating a live database credential is an
  // operator action, and a half-finished rotation should not be able to take the
  // whole platform down. Setting this makes the insecure state a conscious choice
  // that is re-announced on every boot rather than a silent default.
  if (process.env.ALLOW_INSECURE_SECRETS === '1') {
    logger.error('⚠ RUNNING WITH INSECURE SECRETS — rotate and remove ALLOW_INSECURE_SECRETS', {
      problems,
    });
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    logger.error('Refusing to start: insecure configuration', {
      problems,
      hint: 'Rotate the credential, or set ALLOW_INSECURE_SECRETS=1 to boot anyway (not for real customer data).',
    });
    // Exit rather than serve customer conversations with a guessable credential.
    process.exit(1);
  }

  logger.warn('Insecure configuration (allowed outside production)', { problems });
}
