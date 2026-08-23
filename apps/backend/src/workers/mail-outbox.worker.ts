import logger from '../lib/logger';
import { getMailProvider, setMailProvider } from '../modules/mail/mail.provider';
import { smtpProviderFromEnv } from '../modules/mail/smtp.provider';
import { flushOutbox } from '../modules/mail/mail.service';

/**
 * Drains the mail outbox.
 *
 * ## An interval rather than a queue
 *
 * Every other background job here rides BullMQ, and this one deliberately does
 * not. The outbox table *is* the queue — it holds the work, the attempt count,
 * the backoff and the dedupe constraint. Putting a Redis queue in front of a
 * durable table would give two places a message can be pending and one of them
 * loses its contents on restart. The table cannot.
 *
 * ## Why thirty seconds
 *
 * Dunning runs half-hourly, which is right for a deadline measured in days.
 * Mail cannot share that: a password reset that arrives up to half an hour
 * later is a reset nobody waits for. Thirty seconds is under the threshold
 * where a person refreshes their inbox and assumes it is broken.
 */

const INTERVAL_MS = 30_000;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;
/** One pass at a time: a slow provider must not stack overlapping flushes. */
let running = false;

export function startMailOutboxWorker(): void {
  if (timer) return;

  /*
   * Chosen once, at boot, from the environment.
   *
   * Absent or half-configured SMTP leaves the log provider in place rather
   * than installing one that throws on every send — which would fill the
   * outbox with permanent failures and bury the real ones.
   */
  const smtp = smtpProviderFromEnv();
  if (smtp) {
    setMailProvider(smtp);
    // Verified rather than assumed: without this, the first evidence of a
    // wrong password is a customer who never got their suspension warning.
    smtp.verify().then((ok) => {
      if (ok) logger.info('SMTP verified — mail is being delivered');
    });
  }

  const provider = getMailProvider();
  if (!provider.delivers) {
    // Said at boot, loudly, because the alternative is discovering it from a
    // customer who never received the warning we recorded as sent.
    logger.warn(
      'Mail outbox worker started with a non-delivering provider — messages will be logged, not sent',
      { provider: provider.name },
    );
  } else {
    logger.info('Mail outbox worker started', { provider: provider.name });
  }

  timer = setInterval(() => {
    if (running) return;
    running = true;
    flushOutbox(BATCH)
      .then((result) => {
        if (result.sent || result.failed || result.retried) {
          logger.info('Mail outbox flushed', result);
        }
      })
      .catch((error) => logger.error('Mail outbox flush failed', { error: String(error) }))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);

  // Never hold the process open on our account. A shutting-down server should
  // not wait thirty seconds for a timer that has nothing to do.
  timer.unref();
}

export function stopMailOutboxWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
