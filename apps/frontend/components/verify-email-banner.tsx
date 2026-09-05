'use client';

import { useEffect, useState } from 'react';
import { MailWarning } from 'lucide-react';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * The address nobody has confirmed yet.
 *
 * ## Why this banner exists at all
 *
 * Verification used to be a gate: no confirmed address, no WhatsApp gateway.
 * That gate is gone (docs/DECISIONS.md D-8) because no mail transport exists to
 * pass through it, so a customer who closed the signup tab was locked out of the
 * product forever with nothing on screen to say why.
 *
 * Removing a gate silently would be worse than leaving it. The obligation did
 * not disappear -- an unconfirmed address still means a lost password cannot be
 * recovered -- so it moves from a block nobody could see to a line everybody
 * can. Shown on every dashboard page, and not dismissible: this stops being
 * true the moment somebody acts on it, and until then it is still true.
 *
 * ## The tone is deliberately quiet
 *
 * Neutral, not red. Nothing is broken and nothing is about to stop working, and
 * a warning colour here would compete with the two banners above it -- an
 * overdue invoice and a trial running out -- which are about access ending.
 *
 * ## Resending shows the link when nothing sent it
 *
 * The endpoint reports whether the mail provider actually delivers. It does not
 * today, so the response carries the link and this renders it, exactly as the
 * signup screen does. A button that says "sent" over a provider that sends
 * nothing is the fabricated-success shape the pairing screen was fixed for.
 * When a real provider lands, `delivered` is true, no link comes back, and this
 * says the message is on its way instead.
 */

type VerificationState = {
  verified: boolean;
  email: string | null;
  canResend: boolean;
};

type ResendResult = {
  verified: boolean;
  delivered: boolean;
  verificationUrl: string | null;
};

export function VerifyEmailBanner() {
  const { t } = useT();
  const [state, setState] = useState<VerificationState | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<ResendResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/billing/email-verification')
      .then((res) => {
        if (!cancelled) setState(res.data as VerificationState);
      })
      // A confirmed address is the common case, and a failed lookup is not a
      // reason to tell somebody their account needs attention.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /*
    Only an explicit `verified: false` renders this.

    `!state.verified` would have been enough for the endpoint as written, and
    wrong for every other answer: a response that is missing the field, a proxy
    returning an empty body, a future version of this route that renames it —
    each would be read as "this account is unconfirmed" and would nag a customer
    who confirmed months ago. A banner that accuses on missing evidence is the
    same fabricated-state error as a spinner over a dead gateway, pointed the
    other way.
  */
  if (state?.verified !== false) return null;

  const resend = async () => {
    setSending(true);
    setFailed(false);
    try {
      const res = await api.post('/api/billing/email-verification/resend');
      const result = res.data as ResendResult;
      // Verified in another tab while this one sat open. Take the banner away
      // rather than reporting a send nobody needed.
      if (result.verified) {
        setState({ ...state, verified: true });
        return;
      }
      setSent(result);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-1.5 text-caption text-muted-foreground"
    >
      <span className="flex items-start gap-1.5">
        <MailWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <b className="text-foreground">{t('Confirm your email address')}</b>
          {state.email ? ` ${state.email}` : ''}
        </span>
      </span>

      {sent?.verificationUrl ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>{t('No mail provider is configured, so the link is shown here instead of being sent.')}</span>
          <a
            href={sent.verificationUrl}
            className="font-semibold text-primary underline underline-offset-2"
          >
            {t('افتح رابط التفعيل')}
          </a>
        </span>
      ) : sent ? (
        <span>{t('The link is on its way to your inbox.')}</span>
      ) : state.canResend ? (
        <button
          type="button"
          onClick={resend}
          disabled={sending}
          className="font-semibold text-primary underline underline-offset-2 disabled:opacity-60"
        >
          {sending ? t('جاري الإرسال...') : t('Send the link again')}
        </button>
      ) : null}

      {failed && (
        <span className="text-danger">{t('Could not prepare a confirmation link')}</span>
      )}
    </div>
  );
}
