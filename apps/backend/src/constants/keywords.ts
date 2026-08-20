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

// ðŸ”´ CRITICAL â€” notify on-call tech immediately
export const KEYWORDS_CRITICAL = [
  'عاجل', 'ضروري', 'حالًا', 'هلا', 'مستعجل', 'شكوى', 'زعلان', 'مش راضي',
  'ما حدا برد', 'صارلي فترة', 'مشكلة كبيرة', 'خسارة', 'تعطل الشغل',
];

// ðŸŸ  HIGH â€” assign tech within 2 hours
export const KEYWORDS_HIGH = [
  'مشكلة', 'مش شغال', 'واقف', 'تعطل', 'لا يعمل', 'ما بزبط', 'في خلل',
  'بحاجة مساعدة', 'بدنا حل', 'تواصلوا معي',
];

// ðŸŸ¡ MEDIUM â€” respond within 4 hours
export const KEYWORDS_MEDIUM = [
  'سؤال', 'استفسار', 'مساعدة', 'توضيح', 'كيف', 'متى', 'وين', 'ممكن',
  'بدي أعرف', 'شو الخطوات',
];

// ðŸ”µ LOW â€” respond within 24 hours
export const KEYWORDS_LOW = [
  'شكرًا', 'تمام', 'وصلت', 'ممتاز', 'يعطيكم العافية', 'ملاحظة', 'اقتراح',
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

export async function detectPriority(text: string): Promise<DetectionResult> {
  const normalized = text
    .replace(/[^\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const check = (list: string[]): string | null => {
    for (const kw of list) {
      if (normalized.includes(kw)) return kw;
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
  const normalized = text
    .replace(/[^\u0600-\u06FF\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const check = (list: string[]): string | null => {
    for (const kw of list) {
      if (normalized.includes(kw)) return kw;
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

