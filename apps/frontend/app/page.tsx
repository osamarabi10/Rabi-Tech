'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleCheck,
  Clock,
  FileCheck2,
  GitBranch,
  Globe,
  Globe2,
  Menu,
  MessageSquareText,
  ShieldCheck,
  UsersRound,
  X,
  Zap,
} from 'lucide-react';
import { LOCALES, useT } from '@/lib/i18n';
import './landing.css';

/**
 * The landing page.
 *
 * Ported from a supplied design. Three things changed in the porting, each
 * because the design was built without knowing something about this product:
 *
 * 1. **It had no language switch.** RabiTech ships in Arabic, Hebrew and
 *    English, and two of those read right to left. A landing page that cannot
 *    change language advertises the product in the one language its reader may
 *    not use — which is the exact failure the public shell was built to fix.
 *
 * 2. **Its calls to action said "request access".** That describes a gated
 *    beta. Signup is self-serve and opens a three-hour trial, so the button now
 *    says what actually happens when you press it.
 *
 * 3. **One link pointed at `/contacts`**, which is inside the product. A
 *    logged-out visitor clicking it lands on a login redirect from a marketing
 *    page.
 *
 * The layout is left alone otherwise. It was already written on logical
 * properties throughout — `inset-inline-start`, `border-inline-end` — so it
 * mirrors correctly without being rebuilt, which is why it survived contact
 * with an RTL product at all.
 */

/** In-page anchors. Kept as data because the mobile menu renders them twice. */
const SECTIONS = [
  { id: 'product', label: 'المنتج' },
  { id: 'operations', label: 'طريقة الشغل' },
  { id: 'security', label: 'الفصل والصلاحيات' },
  { id: 'faq', label: 'أسئلة متكررة' },
] as const;

function RelayRule({ label }: { label: string }) {
  return (
    <span className="lp-relay-rule">
      <i />
      <b />
      {label}
    </span>
  );
}

/**
 * The workspace mock in the hero.
 *
 * The names are deliberately Arabic, Hebrew and Latin together: the product's
 * whole claim is that one queue holds all three, and a screenshot of four
 * English names would quietly contradict the sentence beside it.
 */
function ProductSurface({ t }: { t: (key: string) => string }) {
  const rows: Array<[string, string, string, string, string]> = [
    ['MC', 'Maya Cohen', t('بتقدر تبعتلي الكتالوج الجديد؟'), '2m', 'blue'],
    ['سأ', 'سارة أحمد', t('بدي أعرف أوقات التوصيل'), '8m', 'green'],
    ['NL', 'Noah Levin', t('شكراً — بأكّدلك بعد شوي.'), '21m', 'amber'],
    ['דא', 'דנה אבני', t('ممكن أطلب استلام؟'), '44m', 'green'],
  ];

  return (
    <div className="lp-product-surface" aria-label={t('معاينة مساحة العمل')}>
      <header>
        <span className="lp-surface-brand">
          <b>RabiTech</b>
        </span>
        <span className="lp-surface-health">
          <i /> {t('القناة شغّالة')}
        </span>
        <span className="lp-surface-user">م ع</span>
      </header>
      <div className="lp-surface-content">
        <aside className="lp-surface-selector">
          <small>{t('مساحة العمل')}</small>
          <strong>{t('المحادثات')}</strong>
          <span className="lp-surface-selected">
            <MessageSquareText size={14} /> {t('كل المحادثات')} <b>18</b>
          </span>
          <span>
            <UsersRound size={14} /> {t('مُسندة لي')} <b>6</b>
          </span>
          <span>
            <GitBranch size={14} /> {t('غير مسندة')} <b>4</b>
          </span>
          <small>{t('مراحل العميل')}</small>
          <span>
            <i className="lp-dot-blue" /> {t('عملاء جدد')} <b>7</b>
          </span>
          <span>
            <i className="lp-dot-amber" /> {t('قيد الشغل')} <b>5</b>
          </span>
          <span>
            <i className="lp-dot-slate" /> {t('محلولة')} <b>39</b>
          </span>
        </aside>

        <section className="lp-surface-queue">
          <div className="lp-surface-heading">
            <small>{t('الوارد / ١٨ مفتوحة')}</small>
            <strong>{t('كل المحادثات')}</strong>
          </div>
          <div className="lp-surface-search">{t('دوّر بالمحادثات')}</div>
          {rows.map(([initials, name, text, time, tone]) => (
            <div className="lp-surface-row" key={name}>
              <i className={`lp-row-trace lp-row-${tone}`} />
              <span className="lp-surface-avatar">{initials}</span>
              <p>
                <b>{name}</b>
                <em>{text}</em>
              </p>
              <time>{time}</time>
            </div>
          ))}
        </section>

        <section className="lp-surface-thread">
          <div className="lp-thread-header">
            <span className="lp-surface-avatar">MC</span>
            <p>
              <b>Maya Cohen</b>
              <small>WhatsApp · +972 54 217 1084</small>
            </p>
            <span className="lp-thread-open">{t('مفتوحة')}</span>
            <button type="button">
              {t('حلّها')} <Check size={13} />
            </button>
          </div>
          <div className="lp-thread-messages">
            <span className="lp-event">● {t('سندها إلك رنا حسن')}</span>
            <p className="lp-message lp-message-in">{t('مرحبا، شفت التشكيلة الجديدة. بتقدر تبعتلي الكتالوج؟')}</p>
            <p className="lp-message lp-message-out">{t('أكيد — عم أبعتهولك هلق. في صنف معيّن بتدوّر عليه؟')}</p>
            <span className="lp-event lp-event-green">● {t('تسجّلت الموافقة بعد رد العميل')}</span>
            <p className="lp-message lp-message-out">{t('تمام. بابعتلك كتالوج هدايا الشركات مع أسعار الجملة.')}</p>
          </div>
          <footer>
            <div className="lp-thread-ready">
              <i />
              <span>
                <b>{t('الإرسال جاهز')}</b>
                <small>{t('الجلسة شغّالة · فيك تبعت')}</small>
              </span>
              <em>{t('شغّالة')}</em>
            </div>
            <div className="lp-thread-tabs">
              <b>
                {t('رد')} <small>{t('العميل بيشوفه')}</small>
              </b>
              <span>
                {t('ملاحظة داخلية')} <small>{t('للفريق بس')}</small>
              </span>
            </div>
            <div className="lp-thread-input">
              {t('اكتب رد لواتساب…')}
              <button type="button">
                {t('إرسال')} <ArrowRight size={13} />
              </button>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const { t, locale, setLocale } = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  const faqs: Array<[string, string]> = [
    [
      t('هل RabiTech بديل عن واتساب؟'),
      t('لأ. RabiTech بيعطي فريقك مساحة شغل حوالين قناة واتساب، عشان كل محادثة يكون إلها صاحب ومسؤول وسياق وتاريخ واضح.'),
    ],
    [
      t('فيه المبيعات والدعم يشتغلوا بنفس المساحة؟'),
      t('أيوه. طوابير مشتركة، مراحل للعميل، إسناد، وسياق جهة الاتصال — مع بقاء المسؤولية عن الخطوة الجاية واضحة.'),
    ],
    [
      t('كيف بتتعاملوا مع موافقة العميل؟'),
      t('الموافقة حالة صريحة مخزّنة مع مصدرها. اللي انسحب بيضل ظاهر للفريق بس بينشال من جمهور الحملات.'),
    ],
    [
      t('بيشتغل بالعربي والعبري؟'),
      t('الواجهة بتيجي بالعربي والعبري والإنجليزي، واتجاه الصفحة بيتبع اللغة اللي بتختارها. نص الرسائل بيضل باتجاهه الطبيعي.'),
    ],
  ];

  return (
    <main className="lp-page">
      <nav className="lp-nav" aria-label={t('التنقل الرئيسي')}>
        <Link href="/" className="lp-logo">
          <span>RabiTech</span>
        </Link>

        <div className={`lp-nav-links ${menuOpen ? 'lp-nav-open' : ''}`}>
          {SECTIONS.map((section) => (
            <a href={`#${section.id}`} key={section.id} onClick={() => setMenuOpen(false)}>
              {t(section.label)}
            </a>
          ))}
          <Link href="/login" className="lp-mobile-login">
            {t('تسجيل الدخول')}
          </Link>
        </div>

        <div className="lp-nav-actions">
          {/*
            Not in the imported design, and the one thing it could not have
            known: two of this product's three languages are read right to
            left, and a visitor who cannot switch is being sold a product in a
            language they may not use.
          */}
          <div className="lp-lang" role="group" aria-label={t('اللغة')}>
            <Globe aria-hidden />
            {LOCALES.map((language) => (
              <button
                key={language.code}
                type="button"
                onClick={() => setLocale(language.code)}
                aria-pressed={locale === language.code}
              >
                {language.label}
              </button>
            ))}
          </div>
          <Link href="/login" className="lp-login">
            {t('تسجيل الدخول')}
          </Link>
          <Link href="/signup" className="lp-nav-cta">
            {t('ابدأ التجربة المجانية')} <ArrowRight size={15} />
          </Link>
          <button
            type="button"
            className="lp-menu"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label={menuOpen ? t('إغلاق القائمة') : t('فتح القائمة')}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
      </nav>

      <section className="lp-hero" id="product">
        <div className="lp-hero-copy">
          <RelayRule label={t('شغل واتساب، بمسؤولية واضحة')} />
          <h1>
            {t('كل رسالة من عميلك،')} <em>{t('وإلها صاحب مسؤول.')}</em>
          </h1>
          <p>
            {t('RabiTech بيعطي فريقك مساحة واتساب مشتركة: بيوزّع المحادثات، بيحمي موافقة العميل، وبيخلّي كل تسليمة بين الموظفين مكشوفة وواضحة.')}
          </p>
          <div className="lp-hero-actions">
            <Link href="/signup" className="lp-primary-cta">
              {t('ابدأ التجربة المجانية')} <ArrowRight size={17} />
            </Link>
            <a href="#operations" className="lp-secondary-cta">
              {t('شوف طريقة الشغل')}
            </a>
          </div>
          {/*
            The offer, beside the headline. Three screens down next to the
            prices is where the people most likely to try it stop reading.
          */}
          <p className="lp-trial-note">
            <Clock aria-hidden />
            {t('٣ ساعات على المنصة كاملة، بدون بطاقة دفع.')}
          </p>
          <div className="lp-hero-proof">
            <span>
              <CircleCheck size={17} /> {t('خيط واحد ثابت لكل عميل')}
            </span>
            <span>
              <CircleCheck size={17} /> {t('معمول لفرق بتشتغل بأكثر من لغة')}
            </span>
          </div>
        </div>
        <div className="lp-hero-visual">
          <div className="lp-hero-index">
            <span>01</span>
            <i />
            <span>02</span>
            <i />
            <span>03</span>
          </div>
          <ProductSurface t={t} />
          <p className="lp-visual-caption">
            <b>{t('من داخل المنصة')}</b>
            {t('العميل، وصاحب المحادثة، وحالة الإرسال، والفريق — كلهم على نفس الشاشة.')}
          </p>
        </div>
      </section>

      <section className="lp-proof-band">
        <p>{t('واتساب بيكبر لما الشغل حواليه يكون واضح.')}</p>
        <div>
          <span>
            <b>{t('مساحة وحدة مشتركة')}</b>
            <small>{t('للفريق كله، مش تلفون بيتناقل')}</small>
          </span>
          <span>
            <b>{t('تسليمات مكشوفة')}</b>
            <small>{t('حدا يعرف مين مسؤول، بدون تخمين')}</small>
          </span>
          <span>
            <b>{t('حملات بموافقة أول')}</b>
            <small>{t('واللي انسحب بيضل مستثنى')}</small>
          </span>
        </div>
      </section>

      <section className="lp-story" id="operations">
        <div className="lp-section-lead">
          <RelayRule label={t('طريقة الشغل')} />
          <h2>
            {t('من كثرة الرسائل، إلى')} <em>{t('وضوح بالشغل.')}</em>
          </h2>
          <p>
            {t('RabiTech بيحوّل قناة واتساب لنظام بيقدر فريق المبيعات والدعم والتوصيل يشتغلوا عليه سوا — بدون ما يضيع السياق اللي العميل متوقّعه.')}
          </p>
        </div>
        <div className="lp-story-grid">
          <article className="lp-story-large">
            <span className="lp-story-index">01 / {t('توزيع')}</span>
            <MessageSquareText size={26} />
            <h3>{t('حطّ كل محادثة مكان ما بينشتغل عليها.')}</h3>
            <p>
              {t('صناديق الوارد، مراحل العميل، ملكية الفريق، والإسناد الواضح — كل موظف بيعرف خطوته الجاية بدون ما ينخبّى عنه تاريخ العميل.')}
            </p>
            <div className="lp-mini-list">
              <span>
                <i /> {t('طابور المبيعات')} <b>06</b>
              </span>
              <span>
                <i /> {t('طابور الدعم')} <b>12</b>
              </span>
              <span>
                <i /> {t('طابور التوصيل')} <b>04</b>
              </span>
            </div>
          </article>
          <article>
            <span className="lp-story-index">02 / {t('حماية')}</span>
            <ShieldCheck size={24} />
            <h3>{t('خلّي الموافقة وحالة الإرسال مكشوفين.')}</h3>
            <p>
              {t('بتعرف أي محادثة بتقدر تتحرك فيها، ومين انسحب من الحملات، وإمتى القناة بدها انتباه.')}
            </p>
            <div className="lp-state-stamps">
              <b>{t('موافق')}</b>
              <b>{t('القناة شغّالة')}</b>
            </div>
          </article>
          <article>
            <span className="lp-story-index">03 / {t('قياس')}</span>
            <BarChart3 size={24} />
            <h3>{t('خلّي الصورة قدّامك أول بأول.')}</h3>
            <p>
              {t('أرقام حقيقية عن الطوابير والحملات والحلول — بتوريك وين الشغل ماشي، ووين واقف مستنّي.')}
            </p>
            <div className="lp-bars">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </article>
        </div>
      </section>

      <section className="lp-feature-split">
        <div className="lp-feature-visual">
          <div className="lp-consent-card">
            <small>{t('جهة اتصال / موافقة')}</small>
            <strong>Maya Cohen</strong>
            <span>{t('موافقة صريحة مسجّلة')}</span>
            <p>{t('اليوم ١٠:٤٨ — من رد العميل')}</p>
            <i />
          </div>
          <div className="lp-activity-line">
            <span>{t('انسندت للمبيعات')}</span>
            <i />
            <span>{t('العميل ردّ')}</span>
            <i />
            <b>{t('انحلّت')}</b>
          </div>
        </div>
        <div className="lp-feature-copy">
          <RelayRule label={t('السياق بيمشي مع المحادثة')} />
          <h2>{t('اعطِ الفريق المعلومة قبل ما يتصرّف.')}</h2>
          <p>
            {t('كل محادثة بتحمل معها تفاصيل العميل، ومرحلته، وسجل موافقته، والملفات، وسجل النشاط — كلها على بعد خطوة من الرد.')}
          </p>
          <ul>
            <li>
              <Check size={17} /> {t('سياق العميل بيضل ملزوق بالشغل')}
            </li>
            <li>
              <Check size={17} /> {t('الملاحظات الداخلية منفصلة عن ردود واتساب')}
            </li>
            <li>
              <Check size={17} /> {t('سجل النشاط بيقول شو تغيّر ومين مسؤول عن الخطوة الجاية')}
            </li>
          </ul>
          {/*
            The design pointed this at /contacts, which is inside the product —
            a logged-out visitor would have been bounced to the login screen
            from a marketing page.
          */}
          <a href="#faq" className="lp-text-cta">
            {t('أسئلة متكررة')} <ArrowRight size={16} />
          </a>
        </div>
      </section>

      <section className="lp-audience">
        <div>
          <RelayRule label={t('لفرق بتتحمّل مسؤولية')} />
          <h2>{t('قناة وحدة. تلات زوايا شغل.')}</h2>
        </div>
        <div className="lp-audience-cards">
          <article>
            <UsersRound size={24} />
            <span>{t('المبيعات')}</span>
            <h3>{t('لاحق العميل بدون ما تضيع المحادثة.')}</h3>
            <p>
              {t('مراحل العميل، والملكية، وسياق سريع — بتخلّي المتابعة واضحة من أول سؤال لحد ما تصير فرصة جدّية.')}
            </p>
            <div className="lp-role-state">
              <i className="lp-dot-blue" /> {t('طابور المتابعة')} <b>12</b>
            </div>
          </article>
          <article>
            <Zap size={24} />
            <span>{t('الدعم')}</span>
            <h3>{t('خلّي شغل الردود مكشوف طول الوردية.')}</h3>
            <p>
              {t('الموظف الجاي بيستلم المحادثة كاملة مع حالة الإرسال والتاريخ — مش صورة شاشة متحوّلة.')}
            </p>
            <div className="lp-role-state">
              <i className="lp-dot-amber" /> {t('بانتظار العميل')} <b>04</b>
            </div>
          </article>
          <article>
            <FileCheck2 size={24} />
            <span>{t('العمليات')}</span>
            <h3>{t('خلّي قرارات الحملات والموافقات قابلة للمراجعة.')}</h3>
            <p>
              {t('ابنِ جمهورك من بيانات حقيقية، استثنِ اللي انسحب، وراجع نتائج الإرسال بهدوء.')}
            </p>
            <div className="lp-role-state">
              <i className="lp-dot-slate" /> {t('مستثنى بالموافقة')} <b>17</b>
            </div>
          </article>
        </div>
      </section>

      <section className="lp-security" id="security">
        <div className="lp-security-number">
          <span>{t('سجل')}</span>
          <b>{t('واحد')}</b>
        </div>
        <div>
          <RelayRule label={t('مفصول من الأساس')} />
          <h2>{t('كل مساحة شغل بتضل مساحتها.')}</h2>
          <p>
            {t('RabiTech معمول لفرق بدها فصل نظيف بين المؤسسات والأدوار وسجلات العملاء والصلاحيات — بدون ما يبطّئ الشغل بصندوق الوارد.')}
          </p>
        </div>
        <div className="lp-security-points">
          <span>
            <Globe2 size={19} />
            <b>{t('تلات لغات من الأساس')}</b>
            <small>{t('عربي وعبري وإنجليزي، والاتجاه بيتبع اللغة.')}</small>
          </span>
          <span>
            <ShieldCheck size={19} />
            <b>{t('أدوار إلها معنى')}</b>
            <small>{t('صلاحيات المساحة منفصلة عن صلاحيات المنصة، والعمليات الحسّاسة محميّة بالدور.')}</small>
          </span>
        </div>
        <div className="lp-security-ledger">
          <span>
            <i /> {t('حدود المؤسسة')} <b>{t('مفصولة')}</b>
          </span>
          <span>
            <i /> {t('الوصول للمساحة')} <b>{t('محمي بالدور')}</b>
          </span>
          <span>
            <i /> {t('حالة القناة')} <b>{t('ظاهرة')}</b>
          </span>
        </div>
      </section>

      <section className="lp-faq" id="faq">
        <div>
          <RelayRule label={t('أسئلة متكررة')} />
          <h2>{t('أسئلة بتنسأل قبل ما الفريق يجمع واتساب بمكان واحد.')}</h2>
        </div>
        <div>
          {faqs.map(([question, answer]) => (
            <details key={question}>
              <summary>
                {question}
                <ChevronDown size={17} />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="lp-final-cta">
        <div>
          <RelayRule label={t('جاهز تشتغل بوضوح؟')} />
          <h2>
            {t('بطّل تتشارك تلفون الشركة.')}
            <br />
            <em>{t('شارك الشغل نفسه.')}</em>
          </h2>
        </div>
        <div>
          <p>{t('جيب محادثات واتساب لمساحة شغل وحدة، وكل واحد بيعرف مسؤوليته.')}</p>
          <Link href="/signup" className="lp-primary-cta">
            {t('ابدأ التجربة المجانية')} <ArrowRight size={17} />
          </Link>
        </div>
      </section>

      <footer className="lp-footer">
        <Link href="/" className="lp-logo">
          <span>RabiTech</span>
        </Link>
        <p>{t('شغل واتساب لفرق بدها وضوح.')}</p>
        <div>
          <Link href="/login">{t('تسجيل الدخول')}</Link>
          <Link href="/pricing">{t('الأسعار')}</Link>
          <Link href="/contact-us-to-activate">{t('تواصل معنا')}</Link>
        </div>
      </footer>
    </main>
  );
}
