'use client';

import Link from 'next/link';
import {
  BarChart3,
  Inbox,
  Megaphone,
  MessagesSquare,
  Users,
  Workflow,
} from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * What RabiTech is, for someone who has never seen it.
 *
 * The previous version was one sentence about "WhatsApp operations for growing
 * local service teams" and two buttons, in English only — advertising a product
 * that ships in Arabic, Hebrew and English to a market where two of those are
 * the working languages.
 *
 * Everything here is claimed only because it is built. A landing page that
 * promises a feature the product does not have is the most expensive kind of
 * lie: the customer discovers it after paying.
 */

const FEATURES = [
  {
    icon: Inbox,
    title: 'صندوق وارد مشترك',
    body: 'كل محادثات واتساب في مكان واحد. الفريق كله بيشوف نفس الخيط، وكل محادثة بتنسند لموظف لحاله.',
  },
  {
    icon: MessagesSquare,
    title: 'ردود تلقائية بتتحكم فيها',
    body: 'ترحيب للعميل الجديد، رد خارج الدوام، رد على الكلمات المفتاحية. كل نص منها بتعدّله إنت، وإذا أوقفته ما بينبعت إشي.',
  },
  {
    icon: Users,
    title: 'ملف كامل للعميل',
    body: 'كل محادثاته السابقة، ملفاته، وسومه، وحقول إنت بتعرّفها. وسجل موافقته على التسويق: مين غيّرها وإيمتى.',
  },
  {
    icon: Megaphone,
    title: 'حملات لمجموعة محددة',
    body: 'اختار جهات الاتصال، احفظهم كمجموعة، وابعتلهم رسالة وحدة. اللي ألغى الاشتراك بينستثنى تلقائياً — دايماً.',
  },
  {
    icon: Workflow,
    title: 'أتمتة بشروط وإجراءات',
    body: 'لما توصل رسالة أو يتغيّر وسم، نفّذ إجراءات بالترتيب: أسند، وسّم، ابعت قالب، ناد على رابط خارجي.',
  },
  {
    icon: BarChart3,
    title: 'تقارير بتقيس الشغل',
    body: 'زمن أول رد، سرعة الحل، أداء كل موظف، ونتيجة كل حملة — مع إمكانية تفتح المحادثات ورا أي رقم.',
  },
];

const STEPS = [
  { title: 'أنشئ حسابك', body: 'اسم المؤسسة، بياناتك، والباقة اللي بتناسبك.' },
  { title: 'اربط رقم واتساب', body: 'امسح رمز QR مرة وحدة، والرقم بيصير صندوق وارد للفريق.' },
  { title: 'ابدأ الشغل', body: 'الرسائل بتوصل، الردود التلقائية بتشتغل، والتقارير بتتعبّى لحالها.' },
];

export default function HomePage() {
  const { t } = useT();

  return (
    <PublicShell>
      {/* ── What it is ──────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <p className="text-caption font-semibold uppercase tracking-wide text-primary">
          {t('واتساب للأعمال')}
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight md:text-5xl">
          {t('كل محادثات واتساب لشركتك، بصندوق وارد واحد لكل الفريق')}
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          {t('عميلك بيبعت على رقم الشركة، والرسالة بتوصل لفريقك بصندوق مشترك: بتتوزّع لحالها، بترد تلقائياً لما تحتاج، وبتتقاس بالتقارير. بالعربي والعبري والإنجليزي.')}
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/signup">{t('ابدأ الآن')}</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/pricing">{t('شوف الأسعار')}</Link>
          </Button>
        </div>
      </section>

      {/* ── What it does ────────────────────────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-bold">{t('شو بتعمل المنصة')}</h2>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="rounded-lg border border-border bg-card p-5">
                <feature.icon className="h-5 w-5 text-primary" aria-hidden />
                <h3 className="mt-3 font-semibold">{t(feature.title)}</h3>
                <p className="mt-2 text-caption leading-6 text-muted-foreground">
                  {t(feature.body)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How you start ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold">{t('كيف بتبدأ')}</h2>
        <ol className="mt-8 grid gap-5 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-lg border border-border p-5">
              <span className="numeric font-mono text-caption font-semibold text-primary">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3 className="mt-2 font-semibold">{t(step.title)}</h3>
              <p className="mt-1.5 text-caption leading-6 text-muted-foreground">{t(step.body)}</p>
            </li>
          ))}
        </ol>

        {/*
          Said here rather than discovered at the QR screen. RabiTech runs on an
          unofficial gateway: that is why it is affordable and why a number has
          to be scanned, and a customer who learns it after paying is right to
          be annoyed.
        */}
        <p className="mt-8 max-w-2xl rounded-lg border border-border bg-muted/40 p-4 text-caption leading-6 text-muted-foreground">
          {t('المنصة بتشتغل عبر ربط رقم واتساب موجود عندك بمسح رمز QR — مش عبر واجهة ميتا الرسمية. يعني بتبدأ بسرعة وبكلفة أقل، والرقم بيضل رقمك.')}
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/signup">{t('أنشئ حسابك')}</Link>
          </Button>
        </div>
      </section>
    </PublicShell>
  );
}
