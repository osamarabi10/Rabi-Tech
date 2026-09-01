/**
 * Display labels for the automation vocabulary.
 *
 * The *vocabulary* comes from `GET /api/workflows/schema` — this only decides
 * how each token reads. Arabic source strings through `t()`, never a bilingual
 * literal, which would bypass translation and show both languages at once.
 *
 * An unmapped token falls back to itself, so a step added on the server appears
 * (ugly but usable) rather than rendering blank.
 */

export const TRIGGER_LABELS: Record<string, string> = {
  CONVERSATION_CREATED: 'رسالة واردة جديدة',
  KEYWORD_MATCHED: 'كلمة مفتاحية مطابقة',
  TAG_ADDED: 'إضافة وسم',
  TAG_REMOVED: 'إزالة وسم',
  OUT_OF_HOURS: 'خارج ساعات العمل',
};

export const CONDITION_LABELS: Record<string, string> = {
  WITHIN_BUSINESS_HOURS: 'ضمن ساعات العمل',
  CONTACT_HAS_TAG: 'لجهة الاتصال وسم',
  CONTACT_LACKS_TAG: 'ليس لجهة الاتصال وسم',
  CONVERSATION_TEAM_IS: 'الفريق المسؤول هو',
  CONTACT_FIELD_EQUALS: 'حقل مخصص يساوي',
  CONTACT_LIFECYCLE_IS: 'مرحلة جهة الاتصال',
};

export const ACTION_LABELS: Record<string, string> = {
  ASSIGN_TEAM: 'إسناد لفريق',
  ASSIGN_USER: 'إسناد لموظف',
  SEND_MESSAGE: 'إرسال رسالة',
  SEND_TEMPLATE: 'إرسال قالب',
  ADD_TAG: 'إضافة وسم',
  REMOVE_TAG: 'إزالة وسم',
  UPDATE_CONTACT_FIELD: 'تحديث حقل مخصص',
  SET_LIFECYCLE_STAGE: 'نقل لمرحلة',
  HTTP_WEBHOOK: 'استدعاء رابط خارجي',
  WAIT_DELAY: 'انتظار',
  IF_ELSE: 'إذا / وإلا',
  CLOSE_CONVERSATION: 'إغلاق المحادثة',
  ASK_QUESTION: 'طرح سؤال',
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  RUNNING: 'قيد التنفيذ',
  WAITING: 'بانتظار المهلة',
  COMPLETED: 'اكتملت',
  FAILED: 'فشلت',
  SKIPPED: 'تم تخطيها',
  // A run holding for the contact to answer an ASK_QUESTION step. Distinct from
  // WAITING, which is holding for a clock — the two look identical in a list and
  // mean different things to whoever is reading it.
  AWAITING_REPLY: 'بانتظار رد العميل',
  TIMED_OUT: 'انتهت المهلة بدون رد',
};

/** Which extra input each action needs. Drives the builder's fields. */
export const ACTION_FIELDS: Record<string, 'team' | 'user' | 'text' | 'template' | 'tag' | 'customField' | 'url' | 'minutes' | 'branch' | 'question' | 'lifecycleStage' | 'none'> = {
  ASSIGN_TEAM: 'team',
  ASSIGN_USER: 'user',
  SEND_MESSAGE: 'text',
  SEND_TEMPLATE: 'template',
  ADD_TAG: 'tag',
  REMOVE_TAG: 'tag',
  UPDATE_CONTACT_FIELD: 'customField',
  // A picker over the tenant's own stages. Free text would let a workflow write
  // a stage that does not exist — invisible in the builder, and a phantom entry
  // in the funnel. See D-31 for the same shape on Contact columns.
  SET_LIFECYCLE_STAGE: 'lifecycleStage',
  HTTP_WEBHOOK: 'url',
  WAIT_DELAY: 'minutes',
  IF_ELSE: 'branch',
  // Nothing to configure: what the customer receives is the
  // CONVERSATION_CLOSED auto-reply the subscriber already edits in settings.
  CLOSE_CONVERSATION: 'none',
  // Its own kind: a prompt, the answer type, the field to store it in, and the
  // two limits. Reusing 'customField' would give it the field picker and drop
  // the question, which is the part the customer actually sees.
  ASK_QUESTION: 'question',
};

export const triggerLabel = (value: string) => TRIGGER_LABELS[value] || value;
export const conditionLabel = (value: string) => CONDITION_LABELS[value] || value;
export const actionLabel = (value: string) => ACTION_LABELS[value] || value;
export const runStatusLabel = (value: string) => RUN_STATUS_LABELS[value] || value;

/**
 * What an ASK_QUESTION step will accept, in the author's language.
 *
 * Mirrors ANSWER_KINDS on the server. The values are the contract and are not
 * translated; only the labels are.
 */
export const ANSWER_KIND_LABELS: Record<string, string> = {
  text: 'أي جواب',
  email: 'إيميل',
  phone: 'رقم تلفون',
  // Not 'رقم': that key already means '#' elsewhere, and an Arabic source
  // string is the dictionary key, so one word cannot carry two meanings.
  number: 'رقم فقط',
};
