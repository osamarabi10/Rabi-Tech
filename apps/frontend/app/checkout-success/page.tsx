'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * What happened to the payment the customer just made.
 *
 * This page used to answer `.catch(() => setStatus('pending'))`: every failure —
 * no network, an expired session, a server error — was rendered as "pending",
 * for ever, to somebody who had just paid. It could not tell *not activated
 * yet* from *I could not ask*, which are different things to a customer and
 * lead to different actions. It is the defect family this codebase keeps
 * paying for, on the screen where trust is thinnest.
 *
 * So there are four states now, and "unreachable" is one of them. It was also
 * bare English in a product whose first language is Arabic and whose layout is
 * RTL; the copy is translated like every other screen.
 */
type Outcome = 'asking' | 'pending' | 'paid' | 'failed' | 'canceled' | 'unreachable';

export default function CheckoutSuccessPage() {
  const { t } = useT();
  const params = useSearchParams();
  const externalRef = params.get('externalRef') || '';
  const [outcome, setOutcome] = useState<Outcome>('asking');

  useEffect(() => {
    if (!externalRef) {
      setOutcome('unreachable');
      return;
    }
    let live = true;
    const load = () => api
      .get(`/api/billing/checkout-status/${encodeURIComponent(externalRef)}`)
      .then((response) => {
        if (!live) return;
        const status = String(response.data?.status || '');
        setOutcome(
          status === 'paid' ? 'paid'
            : status === 'failed' ? 'failed'
              : status === 'canceled' ? 'canceled'
                : 'pending',
        );
      })
      .catch(() => {
        // Not "pending". We asked and could not get an answer, and saying so is
        // the whole point of this page.
        if (live) setOutcome('unreachable');
      });
    load();
    const timer = window.setInterval(load, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [externalRef]);

  const copy: Record<Outcome, { icon: JSX.Element; title: string; body: string }> = {
    asking: {
      icon: <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />,
      title: t('عم نتأكد من حالة الدفع'),
      body: t('ثواني بس.'),
    },
    pending: {
      icon: <Clock className="h-5 w-5 text-muted-foreground" aria-hidden />,
      title: t('الدفع وصل، والتفعيل لسا ما صار'),
      body: t('منفعّل الاشتراك على نفس حسابك. الصفحة بتحدّث حالها لحالها.'),
    },
    paid: {
      icon: <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />,
      title: t('تم تفعيل اشتراكك'),
      body: t('كل إشي محفوظ زي ما كان — نفس الحساب ونفس المحادثات.'),
    },
    failed: {
      icon: <AlertCircle className="h-5 w-5 text-danger" aria-hidden />,
      title: t('الدفع ما تم'),
      body: t('ما انسحب أي مبلغ. فيك تجرّب مرة تانية أو تحكي معنا.'),
    },
    canceled: {
      icon: <AlertCircle className="h-5 w-5 text-warning" aria-hidden />,
      title: t('انلغت عملية الدفع'),
      body: t('ما انسحب أي مبلغ. باقتك ما تغيّرت.'),
    },
    unreachable: {
      icon: <AlertCircle className="h-5 w-5 text-warning" aria-hidden />,
      title: t('ما قدرنا نتأكد من حالة الدفع'),
      body: t('هاي مشكلة بالاتصال مش بالدفع: ما منعرف شو صار، ومنعرفش إذا انسحب مبلغ. جرّب تحدّث الصفحة، وإذا ضلت هيك احكي معنا.'),
    },
  };

  const shown = copy[outcome];

  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <div className="rounded-lg border border-border bg-card p-6" data-testid={`checkout-${outcome}`}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">{shown.icon}</span>
            <div>
              <h1 className="text-xl font-semibold">{shown.title}</h1>
              <p className="mt-2 text-caption leading-6 text-muted-foreground">{shown.body}</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild variant={outcome === 'paid' ? 'default' : 'outline'}>
              <Link href="/inbox">{t('رجوع للتطبيق')}</Link>
            </Button>
            {(outcome === 'failed' || outcome === 'canceled') && (
              <Button asChild variant="outline"><Link href="/pricing">{t('رجوع للباقات')}</Link></Button>
            )}
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
