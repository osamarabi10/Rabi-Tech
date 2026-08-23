import nodemailer, { type Transporter } from 'nodemailer';
import logger from '../../lib/logger';
import type { MailProvider, OutgoingMail } from './mail.provider';

/**
 * SMTP, deliberately, instead of a mail SaaS.
 *
 * Postmark, SendGrid and SES each need an account, a decision and a contract.
 * SMTP needs a mailbox you already own. Every business running this product
 * already has one, and every one of those SaaS providers speaks SMTP anyway —
 * so choosing this now costs nothing later. Switching to an API provider is
 * another class implementing the same interface.
 *
 * ## The connection is made once and kept
 *
 * `pool: true` reuses the TCP connection across sends. The outbox flushes in
 * batches of fifty; opening and TLS-negotiating fifty times would take longer
 * than the sending, and some hosts rate-limit connections far more harshly than
 * they rate-limit messages.
 *
 * ## Failure is thrown, never swallowed
 *
 * The outbox is built to retry with backoff and to surface what never
 * succeeded. A provider that catches its own errors and reports success would
 * defeat all of that and produce exactly the failure this product cannot
 * afford: a warning we believe was delivered and was not.
 */

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  readonly delivers = true;

  private transporter: Transporter;
  private from: string;

  constructor(config: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  }) {
    this.from = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      // True for implicit TLS on 465; false for 587, where STARTTLS upgrades
      // the connection after greeting. Both are encrypted — the flag is about
      // *when*, not *whether*.
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
      pool: true,
      maxConnections: 3,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
    });
  }

  /**
   * Prove the credentials work, at boot.
   *
   * Without this the first evidence of a wrong password is a customer who never
   * received a suspension warning. `verify()` costs one handshake at startup and
   * turns a silent misconfiguration into a loud one.
   */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch (error) {
      logger.error('SMTP credentials did not verify — mail will fail', {
        error: String(error).slice(0, 300),
      });
      return false;
    }
  }
}

/**
 * Build the provider from the environment, or return null.
 *
 * Null means "stay on the log provider". Half-configured SMTP — a host with no
 * password — is treated as absent rather than attempted, because a provider
 * that throws on every send fills the outbox with permanent failures and buries
 * the real ones.
 */
export function smtpProviderFromEnv(): SmtpMailProvider | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  const from = process.env.MAIL_FROM?.trim() || (user ? `RabiTech <${user}>` : '');

  if (!host || !user || !password || !from) {
    if (host || user || password) {
      // Partially set is almost always a typo or a half-finished deploy, and
      // silently ignoring it would look identical to "not configured yet".
      logger.warn('SMTP is partially configured and will not be used', {
        hasHost: !!host,
        hasUser: !!user,
        hasPassword: !!password,
        hasFrom: !!from,
      });
    }
    return null;
  }

  const port = Number(process.env.SMTP_PORT || 587);
  // Default from the port rather than requiring the flag: 465 is implicit TLS
  // and everything else is STARTTLS, and getting that pairing wrong produces a
  // timeout nobody can read.
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === 'true'
    : port === 465;

  return new SmtpMailProvider({ host, port, secure, user, password, from });
}
