import type { AutoReplyKind } from '@prisma/client';

/**
 * Starter auto-replies written into a NEW organization's MessageTemplate rows at
 * provisioning time.
 *
 * These are seed data, not runtime fallbacks. Once written they belong to the
 * organization: the admin edits the wording, deactivates what they do not want,
 * or deletes a row entirely to stop that auto-reply from ever being sent.
 *
 * Nothing here is ever read at send time. If an organization has no row for a
 * kind, no message is sent for that event -- see utils/auto-reply.ts.
 *
 * Rules for anything added here:
 *  - No phone numbers, addresses, prices, or business specifics. Those are the
 *    subscriber's, and belong in their own edits.
 *  - No platform branding. A subscriber's customers must never see "RabiTech".
 *  - Palestinian/Arab48 colloquial register ("أهلين" not "مرحباً", "شو" not "ماذا").
 *  - Deliberately minimal. A subscriber should feel they need to personalise these,
 *    not that the platform already spoke for them.
 */
export interface DefaultAutoReply {
  kind: AutoReplyKind;
  title: string;
  body: string;
  /** Seeded inactive when an organization should opt in deliberately. */
  isActive: boolean;
}

export const DEFAULT_AUTO_REPLIES: DefaultAutoReply[] = [
  {
    kind: 'WELCOME',
    title: 'ترحيب أول رسالة',
    body: 'أهلين وسهلين! 👋\nشكراً لتواصلك معنا، كيف بقدر أساعدك؟',
    isActive: true,
  },
  {
    kind: 'OUT_OF_HOURS',
    title: 'خارج أوقات العمل',
    body: 'أهلين! 🌙\nإحنا خارج أوقات العمل حالياً، بس رسالتك وصلتنا.\nفريقنا رح يرد عليك بأول وقت عمل.',
    isActive: true,
  },
  {
    kind: 'CONVERSATION_CLOSED',
    title: 'إغلاق المحادثة',
    body: 'تم إغلاق المحادثة ✅\nإذا احتجت أي شي تاني، ما تتردد تراسلنا.',
    isActive: false,
  },
  {
    kind: 'CSAT_PROMPT',
    title: 'طلب تقييم',
    body: 'شو رأيك بخدمتنا؟ ابعتلنا رقم من 1 لـ 5 ⭐',
    isActive: false,
  },
  {
    kind: 'CSAT_THANKS',
    title: 'شكر بعد التقييم',
    body: 'شكراً على تقييمك! 🙏',
    isActive: false,
  },
  {
    kind: 'AWAITING_CLIENT',
    title: 'بانتظار رد العميل',
    body: 'بحاجة لبعض المعلومات الإضافية لنقدر نساعدك أكتر.\nلما تبعتلنا رح نكمل معك.',
    isActive: false,
  },
  {
    kind: 'KEYWORD_CRITICAL',
    title: 'رد تلقائي — عاجل',
    body: 'أهلين، استلمنا رسالتك وهي عندنا كأولوية عاجلة 🚨\nفريقنا رح يتواصل معك بأسرع وقت.',
    isActive: false,
  },
  {
    kind: 'KEYWORD_HIGH',
    title: 'رد تلقائي — أولوية عالية',
    body: 'أهلين 👋 استلمنا رسالتك وفريقنا رح يتواصل معك قريباً.',
    isActive: false,
  },
  {
    kind: 'KEYWORD_MEDIUM',
    title: 'رد تلقائي — أولوية متوسطة',
    body: 'أهلين فيك 👋 سجلنا طلبك وفريقنا رح يرد عليك.',
    isActive: false,
  },
  {
    kind: 'KEYWORD_LOW',
    title: 'رد تلقائي — أولوية عادية',
    body: 'أهلين 😊 وصلنا طلبك، رح نرد عليك بأقرب وقت.',
    isActive: false,
  },
  {
    kind: 'OPT_OUT_CONFIRM',
    title: 'تأكيد إلغاء الاشتراك',
    // Seeded ACTIVE, unlike the other opt-in replies. A customer who asks to
    // stop should be told it worked; silence reads as being ignored, and is
    // what makes people repeat STOP or report the number.
    body: 'تمام، وقفنا الرسائل الترويجية 🙏\nإذا احتجت أي شي فينا نساعدك، راسلنا وقت ما بدك.',
    isActive: true,
  },
  {
    kind: 'OPT_IN_CONFIRM',
    title: 'تأكيد إعادة الاشتراك',
    body: 'أهلين فيك من جديد! 🎉\nرجعنا نبعتلك آخر عروضنا وأخبارنا.',
    isActive: true,
  },
];
