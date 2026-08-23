'use client';

import Link from 'next/link';
import {
  BarChart3,
  LayoutGrid,
  Languages,
  Megaphone,
  MessagesSquare,
  Palette,
  QrCode,
  ShieldCheck,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import { PublicShell } from '@/components/public/public-shell';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';

/**
 * What RabiTech is, for someone who has never seen it.
 *
 * Every claim on this page maps to something that runs. A landing page that
 * promises a feature the product does not have is the most expensive kind of
 * lie: the customer discovers it after paying, and the first thing they lose is
 * trust in everything else the page said.
 *
 * Deliberately absent, having been considered and rejected: Telegram, web chat,
 * "omnichannel" (there is one channel), a drag-and-drop workflow canvas (the
 * engine is real, the canvas is not), typing-collision prevention, SLA tracking,
 * and anything involving AI. The Meta Cloud API appears once, in a roadmap block
 * at the foot, labelled as roadmap.
 */

/** The four things that separate this from the category, all shipped. */
const DIFFERENTIATORS = [
  {
    icon: QrCode,
    title: 'رقمك الحالي، بمسح رمز واحد',
    body: 'بتربط رقم واتساب موجود عندك بمسح رمز QR مرة وحدة. مش عبر واجهة ميتا الرسمية: يعني بتبدأ بنفس اليوم، بدون طلبات موافقة ولا رسوم لكل رسالة، والرقم بيضل رقمك.',
  },
  {
    icon: LayoutGrid,
    title: 'صندوق وارد بأربع لوحات، مبني لدوام كامل',
    body: 'صناديق الوارد، قائمة المحادثات، الخيط، وملف العميل — أربع لوحات بشاشة وحدة. بدون تنقّل بين صفحات، وبثلاث كثافات عرض حسب شغلك.',
  },
  {
    icon: ShieldCheck,
    title: 'عزل بين المؤسسات بالتصميم',
    body: 'كل مؤسسة معزولة عن الثانية على مستوى قاعدة البيانات نفسها، مش بشرط بالكود. الفصل مفحوص بـ ٦٧ اختبار آلي قبل أي إصدار.',
  },
  {
    icon: Languages,
    title: 'من اليمين لليسار كنمط تخطيط، مش كترجمة',
    body: 'الواجهة كلها مبنية بخصائص اتجاهية منطقية. الأرقام والمبالغ والتواريخ بتضل من اليسار لليمين جوّا نص عربي. وكل نص بالواجهة مترجم فعلياً — مش مرآة للإنجليزي.',
  },
];

const FEATURES = [
  {
    icon: MessagesSquare,
    title: 'ردود تلقائية بتتحكم فيها',
    body: 'ترحيب للعميل الجديد، رد خارج الدوام، ورد على كلمات مفتاحية تحددها إنت. كل نص بتعدّله، وإذا أوقفته — ما بينبعت إشي. ولا رسالة تلقائية بتطلع من غير ما تكون كتبتها.',
  },
  {
    icon: Workflow,
    title: 'قواعد أتمتة',
    body: 'لما توصل رسالة أو يتغيّر وسم: أسند لموظف، ضيف وسم، ابعت قالب، أو ناد على رابط خارجي — بالترتيب اللي بتحدده، وبشروط بتتحقق كلها قبل التنفيذ.',
  },
  {
    icon: Users,
    title: 'شغل جماعي',
    body: 'ملاحظات داخلية العميل ما بيشوفها، إشارة لزميل بـ @ مع صندوق خاص للإشارات، توزيع تلقائي بالدور أو للأقل انشغالاً، وتأجيل محادثة لوقت محدد — وبترجع لحالها إذا رد العميل.',
  },
  {
    icon: UserRound,
    title: 'جهات اتصال بتحمل السياق',
    body: 'كل محادثات العميل السابقة، ملفاته، وسومه، وحقول إنت بتعرّفها وبتعبّيها من نفس الشاشة. وسجل موافقته على التسويق: مين غيّرها، إيمتى، ومن وين إجت.',
  },
  {
    icon: Megaphone,
    title: 'حملات بموافقة مفروضة',
    body: 'اختار جهات الاتصال أو احفظهم كمجموعة، وابعتلهم رسالة وحدة بإيقاع آمن. اللي ألغى الاشتراك بينستثنى تلقائياً — دايماً، وبدون خيار تتجاوزه. وبعد الإرسال بتشوف مين استلم، مين قرأ، ومين رد — وشو قال.',
  },
  {
    icon: BarChart3,
    title: 'تقارير بتقيس الشغل',
    body: 'زمن أول رد، سرعة الحل، أداء كل موظف، تقييم العملاء، ونتيجة كل حملة. وكل رقم بتقدر تفتحه وتشوف المحادثات اللي وراه.',
  },
  {
    icon: Palette,
    title: 'علامتك ونطاقك',
    body: 'شعارك، ألوانك، أيقونتك، ونطاقك الخاص. فريقك وعملاؤك بيشوفوا علامتك التجارية، مش علامتنا.',
  },
];

const STEPS = [
  { title: 'أنشئ حسابك واختار باقتك', body: 'اسم الشركة، بياناتك، والباقة اللي بتناسبك.' },
  { title: 'اربط رقم واتساب بمسح QR', body: 'مسح واحد، والرقم بيصير صندوق وارد للفريق.' },
  {
    title: 'ابدأ الشغل',
    body: 'الرسائل بتوصل، الردود التلقائية بتشتغل، والتقارير بتتعبّى لحالها.',
  },
];

export default function HomePage() {
  const { t } = useT();

  return (
    <PublicShell>
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16 md:py-24">
        <p className="text-caption font-semibold uppercase tracking-wide text-primary">
          {t('واتساب للأعمال')}
        </p>
        <h1 className="mt-3 max-w-3xl text-3xl font-bold leading-tight md:text-5xl">
          {t('كل محادثات واتساب لشركتك، بصندوق وارد واحد لكل الفريق')}
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground">
          {t('عميلك بيبعت على رقم شركتك — والرسالة بتوصل لفريقك بصندوق مشترك: بتتوزّع لحالها، بترد تلقائياً لما تحتاج، وبتتقاس بالتقارير. بالعربي والعبري والإنجليزي، وبواجهة مبنية من اليمين لليسار من الأساس.')}
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

      {/* ── The four differentiators ────────────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid gap-5 sm:grid-cols-2">
            {DIFFERENTIATORS.map((item) => (
              <div key={item.title} className="rounded-lg border border-border bg-card p-5">
                <item.icon className="h-5 w-5 text-primary" aria-hidden />
                <h2 className="mt-3 font-semibold">{t(item.title)}</h2>
                <p className="mt-2 text-caption leading-6 text-muted-foreground">
                  {t(item.body)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── What it does ────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
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
      </section>

      {/* ── How you start ───────────────────────────────────────────────── */}
      <section className="border-t border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-2xl font-bold">{t('كيف بتبدأ')}</h2>
          <ol className="mt-8 grid gap-5 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li key={step.title} className="rounded-lg border border-border bg-card p-5">
                <span className="numeric font-mono text-caption font-semibold text-primary">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-2 font-semibold">{t(step.title)}</h3>
                <p className="mt-1.5 text-caption leading-6 text-muted-foreground">
                  {t(step.body)}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Roadmap ─────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        {/*
          One quiet block, visually separated from the feature grid and labelled
          as roadmap. Not a card among the features — a plan presented beside
          shipped work reads as shipped, which is how a roadmap becomes a lie
          nobody meant to tell.
        */}
        <div className="max-w-2xl rounded-lg border border-dashed border-border p-5">
          <p className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            {t('قريباً')}
          </p>
          <h2 className="mt-2 font-semibold">{t('واجهة واتساب الرسمية من ميتا')}</h2>
          <p className="mt-2 text-caption leading-6 text-muted-foreground">
            {t('عم نشتغل عليها كخيار إضافي جنب الربط الحالي — لمين بده الاعتماد الرسمي وحدود إرسال أعلى. الربط بمسح QR رح يضل مدعوم.')}
          </p>
        </div>
      </section>

      {/* ── Closing ─────────────────────────────────────────────────────── */}
      <section className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-12">
          <p className="text-lg font-semibold">
            {t('جاهز تبدأ؟ اربط رقمك واشتغل بنفس اليوم.')}
          </p>
          <Button asChild size="lg">
            <Link href="/signup">{t('أنشئ حسابك')}</Link>
          </Button>
        </div>
      </section>
    </PublicShell>
  );
}
