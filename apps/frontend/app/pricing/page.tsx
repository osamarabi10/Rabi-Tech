'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Loader2 } from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * The plans, read from the server that enforces them.
 *
 * This page used to hold its own hardcoded copy of the catalogue — four cards
 * with prices and limits typed by hand. It had already drifted: it advertised
 * "2,500 MAC" for Growth while the entitlement table was the thing actually
 * deciding what a subscriber got. A price list that disagrees with the system
 * charging the customer is the worst possible page to keep by hand.
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
        <h1 className="text-3xl font-bold">{t('اختار الباقة اللي بتناسبك')}</h1>
        <p className="mt-3 max-w-2xl text-caption leading-6 text-muted-foreground">
          {t('كل الباقات بتشمل صندوق الوارد المشترك والردود التلقائية والتقارير. الفرق بالحدود الشهرية وعدد المستخدمين.')}
        </p>

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

                <ul className="mt-5 space-y-2 text-caption">
                  <Row label={t('جهة اتصال نشطة')} value={limit(plan.monthlyActiveContactsLimit, t)} />
                  <Row label={t('رسالة صادرة')} value={limit(plan.monthlyOutboundMessagesLimit, t)} />
                  <Row label={t('رسالة حملات')} value={limit(plan.monthlyCampaignSendsLimit, t)} />
                  <Row label={t('مستخدم')} value={limit(plan.usersLimit, t)} />
                  {plan.customDomain && <Row label={t('نطاق مخصص')} value="✓" />}
                  {plan.whiteLabel && <Row label={t('علامة بيضاء')} value="✓" />}
                </ul>

                {/*
                  Said on the card rather than discovered at the QR screen: a
                  plan that does not provision a gateway is a dashboard, and the
                  customer should know which one they are buying.
                */}
                <p className="mt-4 min-h-10 text-micro leading-5 text-muted-foreground">
                  {plan.autoProvisionGateway
                    ? t('بيتفعّل رقم واتساب تلقائياً بعد الاشتراك.')
                    : t('لوحة التحكم بس — ربط رقم واتساب بيحتاج ترقية أو تفعيل يدوي.')}
                </p>

                <Button asChild className="mt-4 w-full">
                  <Link href={`/signup?plan=${plan.code}`}>{t('ابدأ بهالباقة')}</Link>
                </Button>
              </div>
            ))}
          </div>
        )}
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
