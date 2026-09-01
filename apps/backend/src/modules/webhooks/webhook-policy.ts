import crypto from 'crypto';

/**
 * The delivery policy, and the ids, with no queue attached.
 *
 * Separated from the worker deliberately. The worker constructs a BullMQ
 * `Queue` at module load, which opens a Redis connection as a side effect of
 * `require` — so anything importing it to read a constant acquires a Redis
 * dependency and a process that never exits. The gate hit exactly that: it hung
 * with no output, because reading `MAX_ATTEMPTS` had connected it to Redis.
 *
 * These values are the contract the documentation states, so they live where
 * they can be read without starting anything.
 */

/**
 * 30s, 60s, 90s — the schedule Respond.io publishes.
 *
 * Linear rather than exponential on purpose: these are a subscriber's own
 * endpoints, usually a small server or a serverless function, and what is being
 * recovered from is a deploy or a restart — minutes, not hours. An exponential
 * ladder would still be retrying tomorrow, long after the event stopped being
 * useful to anyone.
 */
export const WEBHOOK_RETRY_DELAYS_MS = [30_000, 60_000, 90_000];

/** The first attempt plus its retries. */
export const MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

/** Auto-deactivation, as two numbers so the gate can assert on them. */
export const DEACTIVATE_AFTER_FAILURES = 30;
export const DEACTIVATE_WINDOW_MINUTES = 30;

/** A receiver that never answers must not hold a worker slot. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Per delivery attempt, so a receiver can tell a retry from a fresh event. */
export function newDeliveryId(): string {
  return 'whd_' + crypto.randomBytes(12).toString('hex');
}

/** Per occurrence, stable across retries — this is what makes dedup possible. */
export function newEventId(): string {
  return 'evt_' + crypto.randomBytes(12).toString('hex');
}
