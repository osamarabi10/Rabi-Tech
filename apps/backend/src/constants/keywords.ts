import { getTenantCache } from '../lib/tenant-context';

export type Priority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type LeadCategory = 'sales' | 'installation' | 'upgrade' | 'inquiry' | null;

// Categories that can be extended with user-managed keywords (see Keyword model).
export const KEYWORD_CATEGORIES = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'LEAD_SALES',
  'LEAD_INSTALL',
  'LEAD_UPGRADE',
  'LEAD_INQUIRY',
] as const;
export type KeywordCategory = (typeof KEYWORD_CATEGORIES)[number];

// Phrases added by users via the Settings â†’ Keywords page, merged into the
// built-in lists below at lookup time. Populated by refreshCustomKeywords().
const CUSTOM_KEYWORDS_CACHE_KEY = 'custom-keywords';

async function loadCustomKeywords(): Promise<Partial<Record<KeywordCategory, string[]>>> {
  const cache = getTenantCache();
  const cached = cache.get(CUSTOM_KEYWORDS_CACHE_KEY) as
    | Partial<Record<KeywordCategory, string[]>>
    | undefined;
  if (cached) return cached;

  const { prisma } = await import('../prisma');
  const rows = await prisma.keyword.findMany();
  const keywords: Partial<Record<KeywordCategory, string[]>> = {};
  for (const row of rows) {
    const cat = row.category as KeywordCategory;
    const list = keywords[cat] || [];
    list.push(row.phrase);
    keywords[cat] = list;
  }
  cache.set(CUSTOM_KEYWORDS_CACHE_KEY, keywords);
  return keywords;
}

export async function refreshCustomKeywords(): Promise<void> {
  invalidateCustomKeywords();
  await loadCustomKeywords();
}

export function invalidateCustomKeywords(): void {
  getTenantCache().delete(CUSTOM_KEYWORDS_CACHE_KEY);
}

async function withCustom(category: KeywordCategory, base: string[]): Promise<string[]> {
  const extra = (await loadCustomKeywords())[category];
  return extra && extra.length ? [...base, ...extra] : base;
}

// CRITICAL - notify on-call tech immediately
export const KEYWORDS_CRITICAL = [
  'عاجل', 'ضروري', 'حالًا', 'هلا', 'مستعجل', 'شكوى', 'زعلان', 'مش راضي',
  'ما حدا برد', 'صارلي فترة', 'مشكلة كبيرة', 'خسارة', 'تعطل الشغل',
  'דחוף', 'בהול', 'תקלה גדולה', 'תלונה',
  'urgent', 'emergency', 'critical', 'asap', 'complaint', 'nothing works',
];

// HIGH - assign tech within 2 hours
export const KEYWORDS_HIGH = [
  'مشكلة', 'مش شغال', 'واقف', 'تعطل', 'لا يعمل', 'ما بزبط', 'في خلل',
  'بحاجة مساعدة', 'بدنا حل', 'تواصلوا معي',
  'תקלה', 'לא עובד', 'בעיה', 'צריך עזרה',
  'problem', 'broken', 'not working', 'need help', 'issue', 'fault',
];

// MEDIUM - respond within 4 hours
export const KEYWORDS_MEDIUM = [
  'سؤال', 'استفسار', 'مساعدة', 'توضيح', 'كيف', 'متى', 'وين', 'ممكن',
  'بدي أعرف', 'شو الخطوات',
  'שאלה', 'בירור', 'עזרה', 'איך', 'מתי',
  'question', 'how do i', 'when can', 'where can', 'clarify',
];

// LOW - respond within 24 hours
export const KEYWORDS_LOW = [
  'شكرًا', 'تمام', 'وصلت', 'ممتاز', 'يعطيكم العافية', 'ملاحظة', 'اقتراح',
  'תודה', 'מצוין', 'קיבלתי', 'הערה',
  'thanks', 'thank you', 'received', 'great', 'suggestion',
];

// Customer says they already tried basic troubleshooting (restart, etc.)
export const KEYWORDS_ALREADY_TRIED = [
  'جربت', 'عملت', 'سويت', 'راجعت', 'لسا', 'برضه', 'ما زبط', 'نفس الشي',
];

// MARKETING: Sales/lead inquiries \u2014 pricing, packages, offers, discounts
export const KEYWORDS_LEAD_SALES = [
  'سعر', 'أسعار', 'بكام', 'تكلفة', 'عرض', 'خصم', 'اشتراك', 'شراء',
  'بدي أشترك', 'مهتم',
];

// MARKETING: Installation/new service requests
export const KEYWORDS_LEAD_INSTALL = [
  'طلب خدمة', 'خدمة جديدة', 'تفعيل', 'تركيب', 'موعد', 'بدنا نبدأ',
];

// MARKETING: Upgrade/package change for existing customers
export const KEYWORDS_LEAD_UPGRADE = [
  'ترقية', 'توسيع', 'تغيير الخطة', 'خطة أعلى', 'باقة أكبر', 'أبغى أكثر',
];

// MARKETING: General inquiries \u2014 explicit info requests, not generic chit-chat
export const KEYWORDS_LEAD_INQUIRY = [
  'معلومات', 'بدي أعرف', 'شو الشروط', 'كيف بقدر', 'استفسار', 'سؤال',
];

export interface DetectionResult {
  priority: Priority | null;
  matchedKeyword: string | null;
  category: string | null;
  alreadyTried: boolean;
}

export interface MarketingLeadDetectionResult {
  leadCategory: LeadCategory;
  matchedKeyword: string | null;
}

/**
 * Strip punctuation, keep language.
 *
 * This used to be `replace(/[^\u0600-\u06FF\s]/g, '')` \u2014 keep Arabic and
 * whitespace, discard everything else. On a platform serving Arabic, Hebrew and
 * English that meant **a Hebrew or English message normalised to whitespace and
 * matched nothing**: no priority, no category, no CRITICAL routing. Not a
 * near-miss \u2014 total, for two of the three languages.
 *
 * It also silently broke the tenant-extensible `Keyword` model, which is the
 * worse half. A subscriber could add "urgent" or "\u05D3\u05D7\u05D5\u05E3" through
 * Settings \u2192 Keywords, see it saved, and never have it match anything, because
 * the normaliser ran before their list was consulted.
 *
 * Latin is lowercased so "URGENT" and "urgent" match alike. Arabic and Hebrew
 * are caseless, so this is a no-op for them.
 *
 * Arabic behaviour is deliberately unchanged beyond the widening: diacritics
 * (U+064B\u2013U+065F) sit inside the Arabic block and are still kept, because
 * stripping them would alter which existing keywords match and this change is
 * meant to add languages, not to re-tune the language that already worked.
 */
function normalizeForKeywords(text: string): string {
  return text
    .replace(/[^\u0600-\u06FF\u0590-\u05FFa-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Does this keyword appear in this message?
 *
 * Substring for Arabic and Hebrew, whole-word for Latin \u2014 and the asymmetry is
 * the point, not an inconsistency.
 *
 * Arabic and Hebrew attach prefixes and suffixes directly to the stem: "\u0645\u0634\u0643\u0644\u0629"
 * has to match inside "\u0627\u0644\u0645\u0634\u0643\u0644\u0629", and "\u05EA\u05E7\u05DC\u05D4" inside "\u05D4\u05EA\u05E7\u05DC\u05D4". Substring matching
 * is what makes the existing Arabic lists work at all, and requiring word
 * boundaries there would break keywords that match today.
 *
 * Latin has the opposite problem. A three-letter English keyword under
 * substring matching is a false-positive generator: "how" matches "however"
 * and "shower", "urgent" is safe but "asap" inside a URL is not. Every English
 * keyword added to the lists below would have quietly widened what routes as
 * CRITICAL.
 *
 * So the script decides the rule. Nothing about a keyword's language has to be
 * declared \u2014 it is read off the characters.
 */
function keywordMatches(haystack: string, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return false;

  // Any Arabic or Hebrew character means substring semantics.
  if (/[\u0600-\u06FF\u0590-\u05FF]/.test(needle)) return haystack.includes(needle);

  // Pure Latin/digits: whole word, with the keyword escaped so a phrase
  // containing regex metacharacters cannot alter the pattern. Custom keywords
  // come from a tenant-editable table, so this is untrusted input.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

export async function detectPriority(text: string): Promise<DetectionResult> {
  const normalized = normalizeForKeywords(text);

  const check = (list: string[]): string | null => {
    for (const kw of list) {
      if (keywordMatches(normalized, kw)) return kw;
    }
    return null;
  };

  const alreadyTried = !!check(KEYWORDS_ALREADY_TRIED);

  let matched = check(await withCustom('CRITICAL', KEYWORDS_CRITICAL));
  if (matched) return { priority: 'CRITICAL', matchedKeyword: matched, category: detectCategory(normalized), alreadyTried };

  matched = check(await withCustom('HIGH', KEYWORDS_HIGH));
  if (matched) return { priority: 'HIGH', matchedKeyword: matched, category: detectCategory(normalized), alreadyTried };

  matched = check(await withCustom('MEDIUM', KEYWORDS_MEDIUM));
  if (matched) {
    // Customer already tried the basics and it's still broken \u2014 escalate.
    const priority: Priority = alreadyTried ? 'HIGH' : 'MEDIUM';
    return { priority, matchedKeyword: matched, category: detectCategory(normalized), alreadyTried };
  }

  matched = check(await withCustom('LOW', KEYWORDS_LOW));
  if (matched) return { priority: 'LOW', matchedKeyword: matched, category: detectCategory(normalized), alreadyTried };

  return { priority: null, matchedKeyword: null, category: null, alreadyTried };
}

function detectCategory(text: string): string {
  if (['شكوى', 'مش راضي', 'زعلان'].some(k => text.includes(k))) return 'complaint';
  if (['سعر', 'عرض', 'اشتراك', 'شراء'].some(k => text.includes(k))) return 'sales-intent';
  if (['سؤال', 'استفسار', 'معلومات', 'كيف'].some(k => text.includes(k))) return 'question';
  if (['عاجل', 'ضروري', 'مستعجل'].some(k => text.includes(k))) return 'urgent';
  return 'other';
}

/**
 * Detect if a marketing message is a sales lead or general inquiry.
 * Used to categorize marketing conversations without escalating to IT.
 */
export async function detectMarketingLead(text: string): Promise<MarketingLeadDetectionResult> {
  // The same normaliser as detectPriority, not a second copy of it. This
  // carried an identical Arabic-only strip, so lead detection was blind to
  // Hebrew and English for exactly the same reason \u2014 and two copies of a rule
  // is how one of them gets fixed and the other does not.
  const normalized = normalizeForKeywords(text);

  const check = (list: string[]): string | null => {
    for (const kw of list) {
      if (keywordMatches(normalized, kw)) return kw;
    }
    return null;
  };

  let matched = check(await withCustom('LEAD_SALES', KEYWORDS_LEAD_SALES));
  if (matched) return { leadCategory: 'sales', matchedKeyword: matched };

  matched = check(await withCustom('LEAD_INSTALL', KEYWORDS_LEAD_INSTALL));
  if (matched) return { leadCategory: 'installation', matchedKeyword: matched };

  matched = check(await withCustom('LEAD_UPGRADE', KEYWORDS_LEAD_UPGRADE));
  if (matched) return { leadCategory: 'upgrade', matchedKeyword: matched };

  matched = check(await withCustom('LEAD_INQUIRY', KEYWORDS_LEAD_INQUIRY));
  if (matched) return { leadCategory: 'inquiry', matchedKeyword: matched };

  return { leadCategory: null, matchedKeyword: null };
}

