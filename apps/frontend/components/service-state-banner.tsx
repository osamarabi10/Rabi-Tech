'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The warning that arrives before the lockout does.
 *
 * ## The state this exists for is the one where nothing looks wrong
 *
 * A subscriber inside their dunning grace period has a working product and a
 * deadline. Everything responds, nothing is greyed out, and on Thursday morning
 * it all stops. The email was sent; whether it was read is not something this
 * product gets to assume.
 *
 * So the warning lives where they already are, on every page, and it does not
 * dismiss. A banner you can close is a banner that is closed on the morning it
 * matters — and unlike a marketing notice, the cost of missing this one is a
 * business losing its customer conversations for a day.
 *
 * ## It never says more than the server told it
 *
 * The deadline comes from the server as a timestamp and is formatted here,
 * because the sentence around it exists in three languages. A server-composed
 * message would arrive in whichever one the server picked.
 */

type ServiceState =
  | { kind: 'ok' }
  | { kind: 'overdue'; suspendAt: string; reason: string | null }
  | { kind: 'suspended'; reason: string | null }
  | { kind: 'trial_expired' };

export function ServiceStateBanner() {
  const { t, locale } = useT();
  const [state, setState] = useState<ServiceState>({ kind: 'ok' });

  useEffect(() => {
    let cancelled = false;

    const read = () =>
      api
        .get('/api/billing/service-state')
        .then((res) => {
          if (!cancelled) setState(res.data as ServiceState);
        })
        // An organization in good standing is the common case, and a failed lookup
        // is not something to announce in a red bar.
        .catch(() => {});

    read();
    // Re-read on a slow loop rather than once: the deadline can be lifted by a
    // payment mid-session, and a banner still threatening a suspension that was
    // cleared an hour ago is worse than no banner.
    const timer = setInterval(read, 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (state.kind === 'ok') return null;

  // `trial_expired` is deliberately silent here: the API is already refusing
  // every request and the client has already been redirected to the pricing
  // page. A banner would be shouting at somebody who is no longer in the room.
  if (state.kind === 'trial_expired') return null;

  const suspended = state.kind === 'suspended';
  const deadline =
    state.kind === 'overdue'
      ? new Date(state.suspendAt).toLocaleDateString(
          locale === 'ar' ? 'ar' : locale === 'he' ? 'he' : 'en-GB',
          { day: 'numeric', month: 'long' },
        )
      : null;

  return (
    <div
      role="alert"
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 text-caption',
        suspended
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      <span className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <b>
            {suspended
              ? t('مؤسستك متوقفة مؤقتاً')
              : t('في فاتورة متأخرة')}
          </b>{' '}
          {suspended
            ? t('ما في إشي انحذف. بترجع تشتغل فوراً أول ما تنحل الفاتورة.')
            : /*
                The date is the whole message. "You have an overdue invoice"
                is a fact; "service stops on the 30th" is a decision someone
                can act on.
              */
              `${t('الخدمة بتوقف يوم')} ${deadline} ${t('إذا ما انسدّدت.')}`}
        </span>
      </span>
      <Link
        href="/billing"
        className="font-semibold underline underline-offset-2"
      >
        {t('روح للفوترة')}
      </Link>
    </div>
  );
}
