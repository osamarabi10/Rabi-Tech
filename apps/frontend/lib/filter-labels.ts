/**
 * Display labels for the filter vocabulary.
 *
 * The *vocabulary* comes from the server (`/api/contacts/filter-schema`) — this
 * file only decides how each token reads to a human. Labels are Arabic source
 * strings passed through `t()`, never "English / عربي" baked into one literal:
 * a bilingual literal bypasses translation entirely and shows both languages at
 * once whichever locale the user picked.
 *
 * An unmapped token falls back to itself rather than rendering blank, so a
 * field added on the server appears — ugly but usable — instead of vanishing.
 */

export const FIELD_LABELS: Record<string, string> = {
  // Contact columns
  id: 'المعرّف',
  name: 'الاسم',
  phone: 'الهاتف',
  firstName: 'الاسم الأول',
  lastName: 'اسم العائلة',
  email: 'البريد الإلكتروني',
  language: 'اللغة',
  countryCode: 'الدولة',
  lifecycleStage: 'المرحلة',
  assigneeId: 'المسؤول',
  notes: 'الملاحظات',
  marketingConsent: 'موافقة التسويق',
  consentSource: 'مصدر الموافقة',
  consentUpdatedAt: 'تاريخ تحديث الموافقة',
  createdAt: 'تاريخ الإضافة',
  updatedAt: 'آخر تحديث',
  // Activity
  hasEverReplied: 'سبق أن رد',
  lastInboundAt: 'آخر رسالة واردة',
  hasOpenConversation: 'لديه محادثة مفتوحة',
  conversationStatus: 'حالة المحادثة',
  teamId: 'الفريق',
  // Broadcast history
  receivedCampaign: 'استلم حملة',
  readCampaign: 'قرأ حملة',
  receivedAnyWithinDays: 'استلم أي حملة خلال',
  hasNoBroadcasts: 'لم يستلم أي حملة',
};

export const OPERATOR_LABELS: Record<string, string> = {
  isEqualTo: 'يساوي',
  isNotEqualTo: 'لا يساوي',
  contains: 'يحتوي',
  notContains: 'لا يحتوي',
  startsWith: 'يبدأ بـ',
  endsWith: 'ينتهي بـ',
  isOneOf: 'واحد من',
  isNoneOf: 'ليس أيًا من',
  isEmpty: 'فارغ',
  isNotEmpty: 'غير فارغ',
  withinLastDays: 'خلال آخر (أيام)',
  moreThanDaysAgo: 'قبل أكثر من (أيام)',
  before: 'قبل تاريخ',
  after: 'بعد تاريخ',
  between: 'بين',
  gt: 'أكبر من',
  gte: 'أكبر من أو يساوي',
  lt: 'أصغر من',
  lte: 'أصغر من أو يساوي',
  isTrue: 'نعم',
  isFalse: 'لا',
  hasNoBroadcasts: 'صحيح',
};

export const CATEGORY_LABELS: Record<string, string> = {
  contactField: 'حقل جهة الاتصال',
  tag: 'وسم',
  customField: 'حقل مخصص',
  activity: 'النشاط',
  broadcast: 'سجل الحملات',
};

export const ENUM_VALUE_LABELS: Record<string, string> = {
  UNKNOWN: 'غير محدد',
  OPTED_IN: 'موافق',
  OPTED_OUT: 'ملغى الاشتراك',
  OPEN: 'مفتوحة',
  PENDING: 'قيد الانتظار',
  RESOLVED: 'محلولة',
};

export const fieldLabel = (field: string) => FIELD_LABELS[field] || field;
export const operatorLabel = (operator: string) => OPERATOR_LABELS[operator] || operator;
export const categoryLabel = (category: string) => CATEGORY_LABELS[category] || category;
export const enumValueLabel = (value: string) => ENUM_VALUE_LABELS[value] || value;
