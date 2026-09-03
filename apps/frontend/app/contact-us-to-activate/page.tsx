import Link from 'next/link';
import { CheckCircle2, Clock } from 'lucide-react';

/**
 * Landing page for a signup on a paid plan while online payment is not yet live.
 *
 * The previous copy said an activation "request" was received and left the
 * customer with a reference and no idea what happens next. Until a payment
 * provider is wired, a person activates the organization — so say that plainly,
 * say roughly when, and make clear the account already exists.
 */
export default function ContactUsToActivatePage({
  searchParams,
}: {
  searchParams: { externalRef?: string; plan?: string };
}) {
  const steps = [
    { done: true,  text: 'أنشأنا مساحة العمل الخاصة فيك' },
    { done: false, text: 'رح نتواصل معك لترتيب الدفع وتفعيل الباقة' },
    { done: false, text: 'بعد التفعيل بينفتح ربط واتساب مباشرة — بدون أي خطوة إضافية' },
  ];

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground" dir="rtl">
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-card">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10">
          <Clock className="h-5 w-5 text-primary" />
        </div>

        <h1 className="mt-4 text-2xl font-bold">حسابك جاهز — بضل خطوة الدفع</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          الدفع الإلكتروني لسا مش مفعّل عنا، فبنفعّل الباقات يدوياً حالياً. رح نتواصل
          معك خلال يوم عمل واحد لترتيب الدفع.
        </p>

        <ol className="mt-5 space-y-2.5">
          {steps.map((step) => (
            <li key={step.text} className="flex items-start gap-2.5 text-sm">
              <CheckCircle2
                className={`mt-0.5 h-4 w-4 shrink-0 ${step.done ? 'text-success' : 'text-muted-foreground/40'}`}
              />
              <span className={step.done ? 'text-foreground' : 'text-muted-foreground'}>{step.text}</span>
            </li>
          ))}
        </ol>

        <dl className="mt-5 space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-xs">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">الباقة</dt>
            <dd className="font-mono font-semibold" dir="ltr">{searchParams.plan || '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">رقم المرجع</dt>
            <dd className="max-w-[260px] truncate font-mono" dir="ltr">{searchParams.externalRef || '—'}</dd>
          </div>
        </dl>
        <p className="mt-2 text-caption text-muted-foreground">
          احتفظ برقم المرجع — بيساعدنا نلاقي طلبك بسرعة.
        </p>

        <div className="mt-5 flex gap-2">
          <Link
            href="/login"
            className="flex-1 rounded-md bg-primary px-4 py-2 text-center text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            تسجيل الدخول
          </Link>
          <Link
            href="/pricing"
            className="flex-1 rounded-md border border-border px-4 py-2 text-center text-sm font-medium transition-colors hover:bg-accent"
          >
            الباقات
          </Link>
        </div>
      </section>
    </main>
  );
}
