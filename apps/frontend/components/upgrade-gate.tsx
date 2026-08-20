'use client';

import Link from 'next/link';
import { Lock, ArrowUpCircle } from 'lucide-react';
import { useEntitlements, type GatedFeature } from '@/lib/entitlements';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * Shows a locked feature instead of hiding it.
 *
 * A missing menu item reads as a broken product; a visible feature with a
 * price attached reads as something worth buying. So the nav entry stays, the
 * page still loads, and this explains what unlocks it.
 *
 * Purely presentational — the server still refuses the underlying calls.
 */
export function UpgradeGate({
  feature,
  title,
  description,
  children,
}: {
  feature: GatedFeature;
  /** What is locked, e.g. 'البث'. */
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const { t } = useT();
  const { loading, can, requiredPlanFor, plan } = useEntitlements();

  // Never flash the upsell before entitlements load.
  if (loading || can(feature)) return <>{children}</>;

  const required = requiredPlanFor(feature);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-card">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-5 w-5 text-primary" />
        </div>

        <h2 className="mt-4 text-base font-bold">
          {t(title)}
          {required && (
            <span className="text-muted-foreground">
              {' — '}{t('متوفر في باقة')} {required}
            </span>
          )}
        </h2>

        {description && (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t(description)}</p>
        )}

        {plan && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t('باقتك الحالية')}: <span className="font-semibold">{plan.name}</span>
          </p>
        )}

        <Button className="mt-4 w-full" asChild>
          <Link href="/pricing">
            <ArrowUpCircle className="h-4 w-4" />
            {t('ترقية الباقة')}
          </Link>
        </Button>
      </div>
    </div>
  );
}
