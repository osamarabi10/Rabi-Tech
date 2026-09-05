'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, Check, Loader2, MailCheck } from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import api from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Signing up: choose a plan, give your details, then activate.
 *
 * It used to be one form with the plan shown as a read-only chip and a "change
 * plan" link that threw you back to pricing and lost everything you had typed.
 * A visitor arriving straight at /signup — which is what the landing page's own
 * button does — could not see the plans at all.
 *
 * The steps are real steps: the plan is chosen here, so nobody is sent away
 * mid-form.
 */

type Plan = {
  code: string;
  name: string;
  monthlyPriceCents: number;
  currency?: string;
  monthlyActiveContactsLimit: number | null;
  usersLimit: number | null;
  autoProvisionGateway?: boolean;
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

function SignupFlow() {
  const { t } = useT();
  const params = useSearchParams();

  // A plan in the URL means they came from pricing and have already chosen.
  const preselected = params.get('plan');
  const [step, setStep] = useState<'plan' | 'details'>(preselected ? 'details' : 'plan');
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [planCode, setPlanCode] = useState(preselected || 'FREE');

  const [form, setForm] = useState({
    organizationName: '',
    adminName: '',
    adminEmail: '',
    adminPassword: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    api
      .get('/api/billing/plans')
      .then((response) => setPlans(response.data))
      .catch(() => setPlans([]));
  }, []);

  const chosen = plans?.find((plan) => plan.code === planCode) ?? null;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data } = await api.post('/api/billing/signup', { ...form, planCode });
      setResult(data);
    } catch (err: any) {
      /*
        A machine code wins over the server's prose when there is one.

        The server answers in English so it does not compose a sentence in one
        of three languages; PLAN_CHANNEL_UNAVAILABLE is the case where the
        edition asked for needs a channel this platform cannot operate yet, and
        it is rendered here where the reader's language is known. Everything
        else keeps the server's message, which names the actual problem - an
        email already in use, a throttled network - and is the only part that
        tells them what to change.
      */
      const code = err?.response?.data?.code;
      setError(
        code === 'PLAN_CHANNEL_UNAVAILABLE'
          ? t('هاي الباقة بتشتغل على قناة واتساب الرسمية، وهي لسا مش متاحة عندنا. جرّب باقة تانية أو احكي معنا.')
          : err?.response?.data?.error ?? t('تعذّر إنشاء الحساب'),
      );
    } finally {
      setSaving(false);
    }
  };

  if (result) {
    return (
      <section className="mx-auto max-w-xl px-6 py-14">
        <div className="rounded-lg border border-border bg-card p-6">
          <MailCheck className="h-8 w-8 text-primary" />
          <h1 className="mt-4 text-xl font-bold">{t('فعّل بريدك الإلكتروني')}</h1>
          <p className="mt-2 text-caption leading-6 text-muted-foreground">
            {/*
              This used to say the email had to be verified before any WhatsApp
              number would be linked. That stopped being true when provisioning
              was decoupled from verification (docs/DECISIONS.md D-8), and a
              sentence describing a gate that no longer exists is worse than no
              sentence -- it tells the customer to wait for nothing.
            */}
            {t('Your account is ready. Confirm your address so you can recover the account later.')}
          </p>

          <div className="mt-5 space-y-2">
            {result.verificationUrl && (
              <Button asChild variant="outline" className="w-full">
                <a href={result.verificationUrl}>{t('افتح رابط التفعيل')}</a>
              </Button>
            )}

            {/*
              Only when the provider actually gave us somewhere to go. With no
              payment provider configured there is no checkout, and a button
              that leads nowhere is worse than no button.
            */}
            {result.checkoutUrl && (
              <Button asChild className="w-full">
                <a href={result.checkoutUrl}>{t('أكمل الدفع')}</a>
              </Button>
            )}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="text-2xl font-bold">{t('أنشئ حساب شركتك')}</h1>

      {/* Two steps, numbered, so the length of the thing is visible up front. */}
      <ol className="mt-5 flex items-center gap-3 text-caption">
        {(['plan', 'details'] as const).map((key, index) => (
          <li
            key={key}
            className={cn(
              'flex items-center gap-1.5',
              step === key ? 'font-semibold text-primary' : 'text-muted-foreground',
            )}
          >
            <span className="numeric font-mono">{String(index + 1).padStart(2, '0')}</span>
            {key === 'plan' ? t('الباقة') : t('بياناتك')}
          </li>
        ))}
      </ol>

      {step === 'plan' && (
        <div className="mt-6 space-y-3">
          {!plans && (
            <div className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('جارٍ التحميل...')}
            </div>
          )}

          {plans?.map((plan) => (
            <button
              key={plan.code}
              type="button"
              onClick={() => setPlanCode(plan.code)}
              className={cn(
                'flex w-full items-center gap-3 rounded-lg border p-4 text-start transition-colors',
                planCode === plan.code
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-accent',
              )}
            >
              <Check
                className={cn(
                  'h-4 w-4 shrink-0',
                  planCode === plan.code ? 'text-primary' : 'opacity-0',
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">{plan.name}</span>
                <span className="block text-caption text-muted-foreground">
                  {plan.monthlyActiveContactsLimit === null
                    ? t('بلا حد')
                    : plan.monthlyActiveContactsLimit.toLocaleString('en-US')}{' '}
                  {t('جهة اتصال نشطة')}
                  {plan.autoProvisionGateway ? ` · ${t('رقم واتساب تلقائي')}` : ''}
                </span>
              </span>
              <span className="numeric shrink-0 font-mono font-semibold" dir="ltr">
                {priceLabel(plan, t)}
              </span>
            </button>
          ))}

          <Button className="w-full" onClick={() => setStep('details')} disabled={!plans?.length}>
            {t('متابعة')}
            <ArrowRight className="ms-1.5 h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>
      )}

      {step === 'details' && (
        <div className="mt-6 space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
            <span className="text-caption">
              {t('الباقة')}: <strong>{chosen?.name ?? planCode}</strong>
            </span>
            {/* Back to the step, not out of the form — nothing typed is lost. */}
            <button
              type="button"
              onClick={() => setStep('plan')}
              className="text-caption font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('غيّر الباقة')}
            </button>
          </div>

          <Field
            label={t('اسم الشركة')}
            value={form.organizationName}
            onChange={(value) => setForm({ ...form, organizationName: value })}
          />
          <Field
            label={t('اسمك')}
            value={form.adminName}
            onChange={(value) => setForm({ ...form, adminName: value })}
          />
          <Field
            label={t('البريد الإلكتروني')}
            type="email"
            ltr
            value={form.adminEmail}
            onChange={(value) => setForm({ ...form, adminEmail: value })}
          />
          <Field
            label={t('كلمة المرور')}
            type="password"
            ltr
            hint={t('8 أحرف على الأقل')}
            value={form.adminPassword}
            onChange={(value) => setForm({ ...form, adminPassword: value })}
          />

          {error && <p className="text-caption text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep('plan')}>
              <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
            </Button>
            <Button className="flex-1" disabled={saving} onClick={submit}>
              {saving && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              {t('أنشئ الحساب')}
            </Button>
          </div>

          <p className="text-micro text-muted-foreground">
            {t('عندك حساب؟')}{' '}
            <Link href="/login" className="text-primary underline-offset-2 hover:underline">
              {t('دخول')}
            </Link>
          </p>
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  ltr,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  ltr?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      <Input
        type={type}
        // Emails and passwords are typed left-to-right in every language.
        dir={ltr ? 'ltr' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && <p className="text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function SignupPage() {
  return (
    <PublicShell>
      {/* useSearchParams needs a boundary for the static build. */}
      <Suspense fallback={null}>
        <SignupFlow />
      </Suspense>
    </PublicShell>
  );
}
