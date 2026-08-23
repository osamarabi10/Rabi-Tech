'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Clock } from 'lucide-react';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * How long is left of the free trial.
 *
 * ## It counts down against the server's clock, not the device's
 *
 * The endpoint returns the deadline *and* the server's current time, and this
 * keeps the difference between them. A device whose clock is an hour fast would
 * otherwise show an hour less trial than the tenant has — or, worse, show a
 * trial as expired while the API happily keeps serving, which reads as the
 * product being broken rather than as a clock being wrong.
 *
 * ## It never claims the trial ended
 *
 * At zero it stops at "less than a minute" and leaves the announcement to the
 * server, because this component cannot know: the platform owner may have
 * extended the trial a second ago, and a banner asserting a lockout that has not
 * happened is the same class of error as a channel warning about a fault nobody
 * confirmed. The real transition is the API returning TRIAL_EXPIRED, which the
 * interceptor acts on.
 */

type TrialResponse = {
  state: 'none' | 'active' | 'expired';
  endsAt: string | null;
  serverNow: string | null;
};

/** Whole minutes remaining, counted from the server's clock. */
function minutesLeft(endsAt: number, skewMs: number): number {
  return Math.floor((endsAt - (Date.now() + skewMs)) / 60_000);
}

export function TrialBanner() {
  const { t } = useT();
  const [endsAt, setEndsAt] = useState<number | null>(null);
  /** serverNow − deviceNow at the moment we asked. */
  const [skewMs, setSkewMs] = useState(0);
  const [minutes, setMinutes] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/billing/trial')
      .then((res) => {
        if (cancelled) return;
        const data = res.data as TrialResponse;
        if (data.state !== 'active' || !data.endsAt) return;
        const deadline = new Date(data.endsAt).getTime();
        const skew = data.serverNow ? new Date(data.serverNow).getTime() - Date.now() : 0;
        setEndsAt(deadline);
        setSkewMs(skew);
        setMinutes(minutesLeft(deadline, skew));
      })
      // A workspace that is not on a trial is the common case, and a failed
      // lookup is not something to shout about in a banner.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (endsAt === null) return;
    // Once a minute is enough for a banner that renders whole minutes, and it
    // keeps a tab open for hours from re-rendering every second for no reason.
    const timer = setInterval(() => setMinutes(minutesLeft(endsAt, skewMs)), 30_000);
    return () => clearInterval(timer);
  }, [endsAt, skewMs]);

  if (endsAt === null || minutes === null) return null;

  const remaining = Math.max(minutes, 0);
  const hours = Math.floor(remaining / 60);
  const mins = remaining % 60;

  /*
   * Two tones, one threshold. Below half an hour this stops being background
   * information and becomes something to act on — and a banner that is urgent
   * for the whole three hours is a banner nobody reads by the end of the first.
   */
  const urgent = remaining <= 30;

  const label =
    remaining < 1
      ? t('أقل من دقيقة على انتهاء التجربة')
      : hours > 0
        ? `${t('باقي')} ${hours} ${t('س')} ${mins} ${t('د')} ${t('من تجربتك المجانية')}`
        : `${t('باقي')} ${mins} ${t('د')} ${t('من تجربتك المجانية')}`;

  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-caption',
        urgent
          ? 'border-warning/30 bg-warning/10 text-warning'
          : 'border-border bg-muted/40 text-muted-foreground',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {label}
      </span>
      <Link
        href="/pricing"
        className="font-semibold text-primary underline-offset-2 hover:underline"
      >
        {t('اختار باقة')}
      </Link>
    </div>
  );
}
