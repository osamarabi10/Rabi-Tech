'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2, QrCode } from 'lucide-react';
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
  autoProvisionGateway?: boolean;
  customDomain?: boolean;
  whiteLabel?: boolean;
};

/**
 * A price, or the fact that there isn't a published one.
 *
 * Zero means two different things in this catalogue. FREE is genuinely free;
 * ENTERPRISE is zero because its price is negotiated, and rendering that as
 * "0" tells a customer the most expensive plan costs nothing. The plan code
 * is what separates them, because the number cannot.
 */
function priceLabel(plan: Plan, t: (key: string) => string): string {
  if (plan.monthlyPriceCents > 0) {
    return `${(plan.monthlyPriceCents / 100).toLocaleString('en-US')} ${plan.currency ?? 'USD'}`;
  }
  return plan.code === 'FREE' ? t('مجاني') : t('حسب الاتفاق');
}

/** `null` means no ceiling, which is a promise and not a missing value. */
function limit(value: number | null, t: (k: string) => string): string {
  return value === null ? t('بلا حد') : value.toLocaleString('en-US');
}

/** Enterprise is negotiated, so "start with this plan" is a cheque signup cannot cash. */
function ctaFor(plan: Plan, t: (key: string) => string): string {
  if (plan.code === 'FREE') return t('ابدأ مجاناً');
  if (plan.monthlyPriceCents === 0) return t('احكي معنا');
  return t('ابدأ بهالباقة');
}

export default function PricingPage() {
  const { t } = useT();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get('/api/billing/plans')
      .then((response) => setPlans(response.data))
      .catch(() => setFailed(true));
  }, []);

  return (
    <PublicShell>
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h1 className="text-3xl font-bold">{t('اختار الباقة اللي بتناسب شغلك')}</h1>
        <p className="mt-3 max-w-2xl text-caption leading-6 text-muted-foreground">
          {t('كل الباقات فيها نفس المنصة: صندوق الوارد المشترك، الردود التلقائية، الأتمتة، والتقارير. الفرق بالحدود الشهرية وعدد المستخدمين — مش بالمزايا.')}
        </p>

        {/*
          The pricing model, stated before the numbers.
          Bound to the QR connection every time it appears — the claim is about
          the connection that exists, not a promise about every future one.
        */}
        <div className="mt-6 max-w-2xl rounded-lg border border-border bg-muted/40 p-4">
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
          <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {plans.map((plan) => (
              <div
                key={plan.code}
                className="flex flex-col rounded-lg border border-border bg-card p-5"
              >
                <h2 className="text-lg font-bold">{plan.name}</h2>
                <p className="mt-3 text-3xl font-bold">
                  <span className="numeric" dir="ltr">{priceLabel(plan, t)}</span>
                </p>
                {/* Only a real monthly price is "per month". */}
                {plan.monthlyPriceCents > 0 && (
                  <p className="mt-1 text-caption text-muted-foreground">{t('شهرياً')}</p>
                )}

                {/*
                  Promoted out of the footnote it used to live in. Whether a plan
                  connects a WhatsApp number is the single most important fact on
                  the card, and it was set in 10px underneath everything else —
                  where a customer finds it after paying, at the QR screen.
                */}
                <p className="mt-4 border-t border-border pt-4 text-caption leading-6">
                  {plan.autoProvisionGateway
                    ? t('بتربط رقم واتساب بمسح QR، وبتبدأ بنفس اليوم')
                    : t('لوحة التحكم بس — ما فيه ربط رقم واتساب')}
                </p>

                <ul className="mt-4 space-y-2 text-caption">
                  <Row label={t('جهة اتصال نشطة بالشهر')} value={limit(plan.monthlyActiveContactsLimit, t)} />
                  <Row label={t('رسالة صادرة بالشهر')} value={limit(plan.monthlyOutboundMessagesLimit, t)} />
                  {/*
                    A quota of zero reads as a broken number. Saying broadcasts
                    are not part of this plan reads as a decision.
                  */}
                  {plan.monthlyCampaignSendsLimit === 0 ? (
                    <li className="text-muted-foreground">{t('الحملات مش مشمولة بالمجاني')}</li>
                  ) : (
                    <Row label={t('رسالة حملات بالشهر')} value={limit(plan.monthlyCampaignSendsLimit, t)} />
                  )}
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
            {t('مش متأكد أي باقة؟ ابدأ بالمجاني وارفع لما تحتاج.')}
          </p>
          <Button asChild>
            <Link href="/signup?plan=FREE">{t('ابدأ مجاناً')}</Link>
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
