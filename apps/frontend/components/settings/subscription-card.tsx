'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CreditCard, ArrowUpCircle, AlertTriangle, ExternalLink, Users } from 'lucide-react';
import { fetchBillingSummary, type BillingSummary } from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/** Highest plan needs no upsell; everyone else gets an upgrade path. */
const TOP_PLAN = 'ENTERPRISE';

function money(cents: number, currency = 'ILS') {
  return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 })
    .format(cents / 100);
}

/**
 * Plan, seats, invoices and the upgrade path for the signed-in organization.
 *
 * Sits above the usage-meter card, which already renders the monthly metrics —
 * this deliberately does not repeat them.
 */
export function SubscriptionCard() {
  const { t } = useT();
  const [data, setData] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchBillingSummary()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-xs text-muted-foreground">
          {t('جاري التحميل...')}
        </CardContent>
      </Card>
    );
  }
  if (!data) return null;

  const { plan, seats, subscription, invoices, quotaDrift, organization } = data;
  const canUpgrade = plan.code !== TOP_PLAN;
  const periodEnd = subscription?.currentPeriodEnd
    ? new Date(subscription.currentPeriodEnd).toLocaleDateString('ar')
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CreditCard className="h-4 w-4 text-primary" />
          {t('الاشتراك')}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Plan + price */}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">
                {plan.name}
              </span>
              {subscription?.status && (
                <span className="text-[11px] text-muted-foreground">{subscription.status}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {plan.monthlyPriceCents === 0
                ? t('مجاني')
                : `${money(plan.monthlyPriceCents)} / ${t('شهرياً')}`}
              {periodEnd && ` · ${t('يتجدد')} ${periodEnd}`}
            </p>
          </div>
          {canUpgrade && (
            <Button size="sm" asChild>
              <Link href="/pricing">
                <ArrowUpCircle className="h-3.5 w-3.5" />
                {t('ترقية الباقة')}
              </Link>
            </Button>
          )}
        </div>

        {/* Seats — the one entitlement not shown by the usage meters */}
        <div className={cn(
          'rounded-md border px-3 py-2',
          seats.atLimit ? 'border-warning/40 bg-warning/10' : 'border-border',
        )}>
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <Users className="h-3.5 w-3.5" />
              {t('المقاعد')}
            </span>
            <span className="font-mono font-semibold">
              {seats.used} / {seats.limit ?? '∞'}
            </span>
          </div>
          {seats.atLimit && (
            <p className="mt-1 text-[11px] text-warning">
              {t('وصلت للحد الأقصى — رقّي الباقة لإضافة أعضاء')}
            </p>
          )}
        </div>

        {/*
          Enforced quotas no longer match the named plan. This is invisible
          everywhere else and means the tenant is running on limits they may not
          be paying for, so it is surfaced rather than swallowed.
        */}
        {quotaDrift.length > 0 && (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('الحصص المطبّقة لا تطابق الباقة — تواصل مع الدعم')}
            </p>
            <ul className="mt-1 space-y-0.5">
              {quotaDrift.map((d) => (
                <li key={d.metric} className="font-mono text-[10px] text-muted-foreground" dir="ltr">
                  {d.metric}: plan {d.planAllows ?? '∞'} · enforced {d.enforced ?? '∞'}
                </li>
              ))}
            </ul>
          </div>
        )}

        {organization.downgradeGraceEndsAt && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            {organization.downgradeGraceReason || t('باقتك قيد المراجعة')}
          </p>
        )}

        {/* Invoices */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t('الفواتير')}
          </p>
          {invoices.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-[11px] text-muted-foreground">
              {t('لا توجد فواتير بعد')}
            </p>
          ) : (
            <div className="space-y-1">
              {invoices.slice(0, 6).map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-[11px]"
                >
                  <span className="font-mono text-muted-foreground" dir="ltr">
                    {new Date(inv.createdAt).toISOString().slice(0, 10)}
                  </span>
                  <span className="font-semibold" dir="ltr">
                    {money(inv.amountDueCents, inv.currency)}
                  </span>
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[10px]',
                    inv.status === 'PAID'
                      ? 'bg-success/15 text-success'
                      : 'bg-warning/15 text-warning',
                  )}>
                    {inv.status}
                  </span>
                  {inv.hostedInvoiceUrl && (
                    <a
                      href={inv.hostedInvoiceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
