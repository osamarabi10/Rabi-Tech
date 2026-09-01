'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, Check, Clock, Loader2, QrCode } from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * The plans, read from the server that enforces them.
 *
 * This page used to hold its own hardcoded copy of the catalogue — four cards
 * with prices and limits typed by hand — and it had already drifted from the
 * entitlement table deciding what a subscriber actually gets. A price list that
 * disagrees with the system charging the customer is the worst page in the
 * product to maintain by hand.
 */

type Plan = {
  code: string;
  name: string;
  monthlyPriceCents: number;
  currency?: string;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  usersLimit: number | null;
  /** FREE | FIXED | NEGOTIATED. Published by listPlans since E8.1. */
  pricingModel?: 'FREE' | 'FIXED' | 'NEGOTIATED';
  billingInterval?: 'MONTHLY' | 'YEARLY';
  autoProvisionGateway?: boolean;
  customDomain?: boolean;
  whiteLabel?: boolean;
};

/**
 * A price, or the fact that there isn't a published one.
 *
 * Reads pricingModel rather than inferring from the price. It used to test
 * `monthlyPriceCents === 0`, which was right about ENTERPRISE by accident:
 * "priced at zero" and "priced by agreement" are different facts, and the
 * catalogue has been able to tell them apart since pricingModel landed. An
 * edition that is genuinely free would have been labelled "by agreement", and
 * a negotiated edition someone gave a placeholder price would have been
 * advertised at that price.
 */
function priceLabel(plan: Plan, t: (key: string) => string): string {
  if (plan.pricingModel === 'NEGOTIATED') return t('حسب الاتفاق');
  return `${(plan.monthlyPriceCents / 100).toLocaleString('en-US')} ${plan.currency ?? 'USD'}`;
}

/** Per month or per year — the same number means different things. */
function periodLabel(plan: Plan, t: (key: string) => string): string {
  return plan.billingInterval === 'YEARLY' ? t('سنوياً') : t('شهرياً');
}

/** `null` means no ceiling, which is a promise and not a missing value. */
function limit(value: number | null, t: (k: string) => string): string {
  return value === null ? t('بلا حد') : value.toLocaleString('en-US');
}

/** A negotiated edition has no self-serve path, so "start the trial" is a cheque signup cannot cash. */
function ctaFor(plan: Plan, t: (key: string) => string): string {
  return plan.pricingModel === 'NEGOTIATED' ? t('احكي معنا') : t('ابدأ التجربة المجانية');
}

export default function PricingPage() {
  const { t } = useT();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * Why they landed here. Set by the API client when a workspace is refused, so
   * somebody who was working a second ago is told what happened rather than
   * being dropped on a price list with no explanation.
   */
  const trialExpired = params.get('trial') === 'expired';
  const suspended = params.get('account') === 'suspended';

  useEffect(() => {
    api
      .get('/api/billing/plans')
      .then((response) => setPlans(response.data))
      .catch(() => setFailed(true));
  }, []);

  /*
    What this page lists is what the product actually sells.

    That used to be spelled `code !== 'FREE'`, which was a name standing in for
    a rule. The rule is pricingModel: FREE means an edition is not sold, which
    is exactly what makes Free unsuitable here - it is the trial mechanism
    rather than a tier anyone buys, and the trial itself runs on a real paid
    plan so a WhatsApp number can be connected.

    Deliberately the same predicate the server uses. isPaidPlan derives from
    pricingModel and decides whether a signup opens a checkout session at all,
    so an edition this page offers is precisely an edition signup can sell. A
    code literal could not make that promise: a second unsold edition would
    have been advertised, and a Free tier that genuinely became purchasable
    would have stayed hidden.

    NEGOTIATED editions stay listed - they are sold, just not at a published
    price - and ctaFor sends them to a conversation instead of a signup.
  */
  const sellable = (plans ?? []).filter((plan) => plan.pricingModel !== 'FREE');

  return (
    <PublicShell>
      <section className="mx-auto max-w-6xl px-6 py-14">
        {(trialExpired || suspended) && (
          <div className="mb-8 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-4">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="font-semibold text-warning">
                {trialExpired ? t('خلصت فترتك التجريبية') : t('اشتراكك موقوف')}
              </p>
              <p className="mt-1 text-caption leading-6 text-muted-foreground">
                {trialExpired
                  ? t('شغلك ومحادثاتك محفوظة زي ما هي. اختار باقة وبترجع تشتغل من نفس المكان.')
                  : t('تواصل معنا لإعادة تفعيل الاشتراك. بياناتك محفوظة.')}
              </p>
            </div>
          </div>
        )}

        <h1 className="text-3xl font-bold">{t('اختار الباقة اللي بتناسب شغلك')}</h1>
        <p className="mt-3 max-w-2xl text-caption leading-6 text-muted-foreground">
          {t('كل الباقات فيها نفس المنصة: صندوق الوارد المشترك، الردود التلقائية، الأتمتة، والتقارير. الفرق بالحدود الشهرية وعدد المستخدمين — مش بالمزايا.')}
        </p>

        {/*
          The trial, stated before the prices. It is the first thing anyone on
          this page wants to know, and burying it under four cards means the
          people most likely to try are the ones least likely to see it.
        */}
        <div className="mt-6 max-w-2xl rounded-lg border border-primary/30 bg-primary/5 p-4">
          <p className="flex items-start gap-2 font-semibold">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            {t('جرّب المنصة كاملة ٣ ساعات، بدون بطاقة دفع.')}
          </p>
          <p className="mt-1.5 ps-6 text-caption leading-6 text-muted-foreground">
            {t('بتربط رقم واتساب بمسح QR وبتشتغل عليه فوراً — نفس المنصة اللي بتشتريها، مش نسخة مقصوصة. بعد ما تخلص، بتختار باقة وبتكمّل من نفس المكان.')}
          </p>
        </div>

        {/*
          The pricing model, bound to the QR connection every time it appears —
          the claim is about the connection that exists, not a promise about
          every future one.
        */}
        <div className="mt-4 max-w-2xl rounded-lg border border-border bg-muted/40 p-4">
          <p className="flex items-start gap-2 font-semibold">
            <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            {t('مع الربط بمسح QR: سعر شهري ثابت، وبدون أي رسوم على كل رسالة.')}
          </p>
          <p className="mt-1.5 ps-6 text-caption leading-6 text-muted-foreground">
            {t('بتدفع الباقة وبس. اللي جوّا حدودك بتبعته بدون عدّاد شغّال عليك.')}
          </p>
        </div>

        {failed && (
          <p className="mt-8 text-caption text-destructive">{t('تعذّر تحميل الباقات')}</p>
        )}

        {!plans && !failed && (
          <div className="mt-8 flex items-center gap-2 text-caption text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('جارٍ التحميل...')}
          </div>
        )}

        {plans && (
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {sellable.map((plan) => (
              <div
                key={plan.code}
                className="flex flex-col rounded-lg border border-border bg-card p-5"
              >
                <h2 className="text-lg font-bold">{plan.name}</h2>
                <p className="mt-3 text-3xl font-bold">
                  <span className="numeric" dir="ltr">{priceLabel(plan, t)}</span>
                </p>
                {plan.monthlyPriceCents > 0 && (
                  <p className="mt-1 text-caption text-muted-foreground">{periodLabel(plan, t)}</p>
                )}

                {/*
                  Whether a plan connects a WhatsApp number is the single most
                  important fact on the card. It used to sit in 10px underneath
                  the limits — where a customer finds it after paying, at the QR
                  screen.
                */}
                <p className="mt-4 border-t border-border pt-4 text-caption leading-6">
                  {plan.autoProvisionGateway
                    ? t('بتربط رقم واتساب بمسح QR، وبتبدأ بنفس اليوم')
                    : t('لوحة التحكم بس — ما فيه ربط رقم واتساب')}
                </p>

                <ul className="mt-4 space-y-2 text-caption">
                  <Row label={t('جهة اتصال نشطة بالشهر')} value={limit(plan.monthlyActiveContactsLimit, t)} />
                  <Row label={t('رسالة صادرة بالشهر')} value={limit(plan.monthlyOutboundMessagesLimit, t)} />
                  <Row label={t('رسالة حملات بالشهر')} value={limit(plan.monthlyCampaignSendsLimit, t)} />
                  <Row label={t('مستخدم')} value={limit(plan.usersLimit, t)} />
                  {plan.customDomain && <Row label={t('نطاقك الخاص')} value="✓" />}
                  {plan.whiteLabel && <Row label={t('علامتك بدون ذكرنا')} value="✓" />}
                </ul>

                <Button asChild className="mt-5 w-full">
                  <Link href={`/signup?plan=${plan.code}`}>{ctaFor(plan, t)}</Link>
                </Button>
              </div>
            ))}
          </div>
        )}

        {/*
          MAC is the number that decides which plan someone needs, and the page
          never defined it. Wording checked against the code: distinct contacts
          with at least one message in either direction that month — not stored
          contacts, not conversations, not messages.
        */}
        <div className="mt-10 max-w-2xl rounded-lg border border-border p-5">
          <h2 className="font-semibold">{t('شو يعني «جهة اتصال نشطة»؟')}</h2>
          <p className="mt-2 text-caption leading-6 text-muted-foreground">
            {t('أي عميل تبادلت معه رسالة — منك أو منه — خلال الشهر. بيتحسب مرة وحدة مهما كان عدد الرسائل.')}
          </p>
          <p className="mt-1.5 text-caption leading-6 text-muted-foreground">
            {t('عدد جهات الاتصال المخزّنة عندك ما بيتحسب: خزّن قد ما بدك. والعدّاد بيرجع من الصفر كل شهر.')}
          </p>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <p className="text-caption text-muted-foreground">
            {t('مش متأكد أي باقة؟ ابدأ التجربة وقرّر بعدين.')}
          </p>
          <Button asChild>
            <Link href="/signup">{t('ابدأ التجربة المجانية')}</Link>
          </Button>
        </div>
      </section>
    </PublicShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden />
        {label}
      </span>
      <span className="numeric shrink-0 font-mono tabular-nums" dir="ltr">
        {value}
      </span>
    </li>
  );
}
