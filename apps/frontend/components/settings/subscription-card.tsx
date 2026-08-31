'use client';

import Link from 'next/link';
import { CreditCard, ArrowUpCircle, AlertTriangle, ExternalLink, ReceiptText, Users } from 'lucide-react';
import { fetchBillingSummary, type BillingSummary } from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/format-time';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { useResource } from '@/lib/async-resource';

/** Highest plan needs no upsell; everyone else gets an upgrade path. */
const TOP_PLAN = 'ENTERPRISE';

/**
 * Cents to a display string, or null when the currency is unknown.
 *
 * There is deliberately no default. There used to be one — ILS — applied to
 * every amount whose currency the payload did not carry, which was three of
 * the four amounts on this card. A subscriber priced in USD saw a shekel sign
 * and nothing indicating a problem.
 *
 * A number in the wrong currency is not a smaller error than no number. It is
 * a larger one, because it is believable: the figure is well-formed, the
 * symbol is real, and only the exchange rate is missing. Callers render the
 * unavailable state instead.
 */
function money(cents: number, currency: string | null | undefined): string | null {
  if (!currency) return null;
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
  /*
    The first consumer of the four-state resource hook — see
    docs/FETCH-STATE-PATTERN.md. The rest of the app stays on the manual
    loading/loadError pattern until migrated deliberately.

    What this fixes here: the previous version swallowed the error
    (`.catch(() => {})`) and then returned null, so a failed load and an
    organization with no billing summary rendered identically — nothing at all.
    A tenant seeing a blank space where their plan should be had no way to tell
    whether to retry or to call support.
  */
  const resource = useResource<BillingSummary>(() => fetchBillingSummary(), []);

  if (resource.status === 'loading') {
    return (
      <Card>
        <CardContent className="py-4">
          <LayoutSkeleton label={t('جاري التحميل...')} rows={3} />
        </CardContent>
      </Card>
    );
  }

  if (resource.status === 'error') {
    return (
      <Card>
        <CardContent className="py-4">
          <ErrorState
            compact
            title={t('تعذر تحميل الاشتراك')}
            description={t('تعذر تحميل تفاصيل الاشتراك. تحقق من الاتصال وحاول مرة أخرى.')}
            retryLabel={t('إعادة المحاولة')}
            onRetry={resource.retry}
          />
        </CardContent>
      </Card>
    );
  }

  if (resource.status === 'empty') {
    return (
      <Card>
        <CardContent className="py-4">
          <EmptyState
            compact
            icon={CreditCard}
            title={t('لا يوجد اشتراك')}
            description={t('لا توجد تفاصيل اشتراك لهذه المؤسسة بعد.')}
          />
        </CardContent>
      </Card>
    );
  }

  const { plan, seats, subscription, invoices, quotaDrift, organization, commercial } = resource.data;
  const canUpgrade = plan.code !== TOP_PLAN;
  const discounted = commercial.isOverridden
    && commercial.discountPercent !== null
    && commercial.effectivePriceCents !== commercial.listPriceCents;
  const periodEnd = subscription?.currentPeriodEnd
    ? formatDate(subscription.currentPeriodEnd)
    : null;
  // Null when the server did not name a currency. Every amount below is
  // suppressed in that case rather than shown in a guessed one.
  const listPrice = money(commercial.listPriceCents, commercial.currency);
  const effectivePrice = money(commercial.effectivePriceCents, commercial.currency);
  const credit = money(commercial.creditCents, commercial.currency);

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
              <span className="rounded-md bg-primary px-2 py-0.5 text-caption font-bold text-primary-foreground">
                {plan.name}
              </span>
              {/*
                Shown whenever terms differ from the published plan, so a tenant
                on negotiated terms is never confused by a price list that does
                not match what they pay.
              */}
              {commercial.isOverridden && (
                <span className="rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-caption font-bold text-primary">
                  {t('عرض خاص')}
                </span>
              )}
              {subscription?.status && (
                <span className="text-caption text-muted-foreground">{subscription.status}</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {commercial.effectivePriceCents === 0
                ? t('مجاني')
                : effectivePrice === null
                  ? t('العملة غير متوفرة')
                  : (
                    <>
                      {discounted && listPrice && (
                        <span className="me-1 line-through opacity-60">{listPrice}</span>
                      )}
                      {`${effectivePrice} / ${t('شهرياً')}`}
                    </>
                  )}
              {periodEnd && ` · ${t('يتجدد')} ${periodEnd}`}
            </p>
            {discounted && (
              <p className="mt-0.5 text-caption text-success-vivid">
                {`${t('الخصم')} ${commercial.discountPercent}%`}
                {commercial.expiresAt
                  && ` · ${t('حتى')} ${formatDate(commercial.expiresAt)}`}
              </p>
            )}
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

        {commercial.creditCents > 0 && (
          <div className="flex items-center justify-between rounded-md border border-success-vivid/30 bg-success-vivid/10 px-3 py-2 text-xs">
            <span className="font-medium">{t('رصيد متاح')}</span>
            <span
              className={cn('font-semibold', credit && 'numeric font-mono')}
              dir={credit ? 'ltr' : undefined}
            >
              {credit ?? t('العملة غير متوفرة')}
            </span>
          </div>
        )}

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
            <p className="mt-1 text-caption text-warning">
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
            <p className="flex items-center gap-1.5 text-caption font-semibold text-danger">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('الحصص المطبّقة لا تطابق الباقة — تواصل مع الدعم')}
            </p>
            <ul className="mt-1 space-y-0.5">
              {quotaDrift.map((d) => (
                <li key={d.metric} className="font-mono text-micro text-muted-foreground" dir="ltr">
                  {d.metric}: plan {d.planAllows ?? '∞'} · enforced {d.enforced ?? '∞'}
                </li>
              ))}
            </ul>
          </div>
        )}

        {organization.downgradeGraceEndsAt && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning">
            {organization.downgradeGraceReason || t('باقتك قيد المراجعة')}
          </p>
        )}

        {/* Invoices */}
        <div>
          <p className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            {t('الفواتير')}
          </p>
          {invoices.length === 0 ? (
            <EmptyState icon={ReceiptText} title={t('لا توجد فواتير بعد')} compact className="border-y border-border" />
          ) : (
            <div className="space-y-1">
              {invoices.slice(0, 6).map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-caption"
                >
                  <span className="font-mono text-muted-foreground" dir="ltr">
                    {new Date(inv.createdAt).toISOString().slice(0, 10)}
                  </span>
                  <span
                    className="font-semibold"
                    dir={inv.currency ? 'ltr' : undefined}
                  >
                    {money(inv.amountDueCents, inv.currency) ?? t('العملة غير متوفرة')}
                  </span>
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-micro',
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
