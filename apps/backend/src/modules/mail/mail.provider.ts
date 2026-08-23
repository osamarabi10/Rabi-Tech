import logger from '../../lib/logger';

/**
 * Sending mail, behind an interface.
 *
 * There is no email provider configured for this product, and that is a
 * commercial decision rather than a missing afternoon of work: it needs an
 * account, a verified sending domain, SPF and DKIM records, and someone to own
 * the deliverability of a domain that has never sent a message. The same shape
 * as the payment provider, and blocked on the same kind of choice.
 *
 * So this is the seam. Everything upstream — dunning warnings, trial notices,
 * password resets — is written against `MailProvider` and works today. Turning
 * real delivery on is one class and one environment variable, and none of the
 * callers change.
 *
 * ## Until then, mail is logged, not silently dropped
 *
 * The default provider writes each message to the log and reports success. That
 * is a deliberate choice between two bad options: failing would fill the outbox
 * with permanent failures and mask real ones, and pretending silently would let
 * the product claim to have warned a customer it never contacted.
 *
 * Logging does neither. The message is recoverable, the outbox row records that
 * it was "sent" by the log provider, and the console shows which provider is
 * active so nobody mistakes a development stack for a live one.
 */

export type OutgoingMail = {
  to: string;
  subject: string;
  /** Plain text. Templates that need HTML can add a field; none do yet. */
  body: string;
};

export interface MailProvider {
  /** Stable name, recorded against every send. */
  readonly name: string;
  /** Whether this provider actually delivers to a mailbox. */
  readonly delivers: boolean;
  send(mail: OutgoingMail): Promise<void>;
}

/**
 * The default. Writes the message where a developer can read it.
 *
 * `delivers: false` is load-bearing: the console reads it to say, out loud,
 * that nothing is reaching customers. A product that cannot tell you whether
 * its emails are real is worse than one that cannot send them.
 */
class LogMailProvider implements MailProvider {
  readonly name = 'log';
  readonly delivers = false;

  async send(mail: OutgoingMail): Promise<void> {
    logger.info('[mail:log] message not delivered — no provider configured', {
      to: mail.to,
      subject: mail.subject,
      body: mail.body,
    });
  }
}

let provider: MailProvider = new LogMailProvider();

export function getMailProvider(): MailProvider {
  return provider;
}

/** Swapped in tests, and by the registry once a real provider exists. */
export function setMailProvider(next: MailProvider): void {
  provider = next;
}
