'use client';

import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Clock, Mail } from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * Where the manual provider sends a customer who has chosen to pay.
 *
 * This URL has been constructed by `manual.provider.ts` since the provider was
 * written, and the page did not exist: choosing a paid edition took the
 * customer to a 404. That is the last screen in the only path to revenue.
 *
 * It deliberately claims nothing about money. No payment has been taken, no
 * card has been charged, and nothing here can confirm either — the manual
 * provider means a person activates the subscription by hand. The page says
 * what will happen, shows the reference to quote, and stops. A "thank you for
 * your payment" here would be the same defect family as the rest of this
 * week's: a screen asserting a property nothing measured.
 */
export default function ContactUsToActivatePage() {
  const { t } = useT();
  const params = useSearchParams();
  const externalRef = params.get('externalRef') || '';
  const plan = params.get('plan') || '';

  return (
    <PublicShell>
      <div className="mx-auto w-full max-w-2xl px-6 py-16">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-start gap-3">
            <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <div>
              <h1 className="text-xl font-semibold">{t('طلبك وصلنا، وبنفعّله يدوياً')}</h1>
              <p className="mt-2 text-caption leading-6 text-muted-foreground">
                {t('لسا ما انسحب أي مبلغ. بنتواصل معك لترتيب الدفع، وبعدها منفعّل الباقة على نفس حسابك — شغلك ومحادثاتك بتضل زي ما هي.')}
              </p>
            </div>
          </div>

          {plan && (
            <p className="mt-5 text-caption text-muted-foreground">
              {t('الباقة المطلوبة')}: <span className="font-semibold text-foreground">{plan}</span>
            </p>
          )}

          {externalRef && (
            <div className="mt-3">
              <p className="text-caption text-muted-foreground">{t('رقم الطلب — احتفظ فيه لما تحكي معنا')}</p>
              {/*
                The reference is an identifier, so it reads left-to-right in
                every language, like a phone number or a price.
              */}
              <p dir="ltr" className="mt-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-caption">
                {externalRef}
              </p>
            </div>
          )}

          <div className="mt-6 flex flex-wrap gap-3">
            <Button asChild>
              <a href="mailto:support@rabitech.example">
                <Mail className="me-2 h-4 w-4" aria-hidden />
                {t('احكي معنا')}
              </a>
            </Button>
            <Button asChild variant="outline">
              <Link href="/pricing">{t('رجوع للباقات')}</Link>
            </Button>
          </div>
        </div>
      </div>
    </PublicShell>
  );
}
