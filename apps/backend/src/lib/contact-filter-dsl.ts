import { Prisma } from '@prisma/client';

/**
 * The contact filter DSL: what a user builds in the segment builder, what gets
 * stored on `Campaign.audienceFilter`, and what compiles to a Prisma `where`.
 *
 * Three constraints shape this file, and breaking any of them breaks something
 * that has already shipped:
 *
 * 1. **Stored filters must keep compiling.** `Campaign.audienceFilter` persists
 *    this JSON with no version field, and old campaigns are re-read whenever
 *    someone opens a report. The original shape — `{ $and: [rule, ...] }` with
 *    six string operators — has to go on meaning exactly what it meant before.
 *    Every addition here is additive for that reason.
 * 2. **Fields are an allow-list, never interpolation.** A field name reaches
 *    Prisma only after matching a key in the registry below. That is the whole
 *    reason widening the vocabulary is safe.
 * 3. **The compiler is synchronous.** Anything needing a database lookup
 *    mid-compilation (notably "hasn't replied *since campaign X was sent*",
 *    which needs `Campaign.sentAt`) is deliberately out of scope; adding it
 *    means making this async and changing every caller.
 */

export type FilterFieldType = 'text' | 'date' | 'number' | 'enum';

export type ContactFilterRule = {
  category: 'contactField' | 'tag' | 'customField' | 'activity' | 'broadcast';
  field: string;
  operator: string;
  value?: unknown;
  /** Second operand, for range operators (`between`). */
  value2?: unknown;
};

/** A group nests another set of rules under its own AND/OR. */
export type ContactFilterGroup = {
  $and?: ContactFilterNode[];
  $or?: ContactFilterNode[];
};

export type ContactFilterNode = ContactFilterRule | ContactFilterGroup;

export type ContactFilterDsl = ContactFilterGroup;

/**
 * Nesting cap. Three levels is what the product spec allows and what a person
 * can still read back; deeper trees are also how a filter builder turns into an
 * accidental query language with no query planner behind it.
 */
export const MAX_FILTER_DEPTH = 3;

function isGroup(node: ContactFilterNode): node is ContactFilterGroup {
  return node != null && (Array.isArray((node as ContactFilterGroup).$and) || Array.isArray((node as ContactFilterGroup).$or));
}

// ---------------------------------------------------------------------------
// Field registry
// ---------------------------------------------------------------------------

type FieldSpec = {
  type: FilterFieldType;
  /** Nullable in the database. Drives how emptiness and negation are compiled. */
  nullable: boolean;
  /** Closed value set, for enum fields. Validated so a typo cannot match nothing silently. */
  values?: readonly string[];
  /** Set when the column has no index and the filter is therefore a scan. */
  unindexed?: boolean;
};

const CONTACT_FIELDS: Record<string, FieldSpec> = {
  id: { type: 'text', nullable: false },
  phone: { type: 'text', nullable: false },
  name: { type: 'text', nullable: true },
  firstName: { type: 'text', nullable: true },
  lastName: { type: 'text', nullable: true },
  email: { type: 'text', nullable: true },
  language: { type: 'text', nullable: true },
  countryCode: { type: 'text', nullable: true },
  lifecycleStage: { type: 'text', nullable: true },
  assigneeId: { type: 'text', nullable: true },
  notes: { type: 'text', nullable: true, unindexed: true },
  marketingConsent: { type: 'enum', nullable: false, values: ['UNKNOWN', 'OPTED_IN', 'OPTED_OUT'] },
  consentSource: { type: 'text', nullable: true },
  consentUpdatedAt: { type: 'date', nullable: true, unindexed: true },
  createdAt: { type: 'date', nullable: false, unindexed: true },
  updatedAt: { type: 'date', nullable: false, unindexed: true },
};

const OPERATORS_BY_TYPE: Record<FilterFieldType, readonly string[]> = {
  text: [
    'isEqualTo', 'isNotEqualTo', 'contains', 'notContains',
    'startsWith', 'endsWith',
    'isOneOf', 'isNoneOf', 'isEmpty', 'isNotEmpty',
  ],
  enum: ['isEqualTo', 'isNotEqualTo', 'isOneOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'],
  date: ['withinLastDays', 'moreThanDaysAgo', 'before', 'after', 'between', 'isEmpty', 'isNotEmpty'],
  number: ['isEqualTo', 'gt', 'gte', 'lt', 'lte', 'between'],
};

/** Operators complete without a value. */
const VALUELESS = new Set(['isEmpty', 'isNotEmpty', 'hasNoBroadcasts']);

export function operatorsForType(type: FilterFieldType): readonly string[] {
  return OPERATORS_BY_TYPE[type];
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function textValue(value: unknown): string {
  return String(value ?? '').trim();
}

function listValue(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : textValue(value).split(',');
  const list = raw.map((entry) => textValue(entry)).filter(Boolean);
  if (!list.length) throw new Error('يتطلب هذا الشرط قيمة واحدة على الأقل');
  return list;
}

function numberValue(value: unknown, label = 'القيمة'): number {
  const parsed = Number(textValue(value));
  if (!Number.isFinite(parsed)) throw new Error(`${label} يجب أن تكون رقمًا`);
  return parsed;
}

function dateValue(value: unknown, label = 'التاريخ'): Date {
  const text = textValue(value);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} غير صالح`);
  return parsed;
}

/**
 * A day count converted to an absolute cutoff. Matches the rolling-window idiom
 * used across the analytics module so "last 30 days" means the same thing in a
 * filter as it does in a report.
 */
function daysAgo(value: unknown): Date {
  const days = numberValue(value, 'عدد الأيام');
  if (days < 0) throw new Error('عدد الأيام لا يمكن أن يكون سالبًا');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - Math.floor(days));
  return cutoff;
}

// ---------------------------------------------------------------------------
// Scalar predicates
// ---------------------------------------------------------------------------

/**
 * "Empty" means NULL *or* the empty string.
 *
 * The original implementation compiled `isEmpty` to `IS NULL` alone, which
 * quietly missed every row holding `''` — and on a non-nullable column like
 * `phone` it produced an invalid query rather than a wrong answer. Both are
 * failures a user reads as "the filter is broken".
 */
function emptyPredicate(spec: FieldSpec, field: string, negate: boolean): Prisma.ContactWhereInput {
  const blank: Prisma.ContactWhereInput[] = [{ [field]: '' } as Prisma.ContactWhereInput];
  if (spec.nullable) blank.push({ [field]: null } as Prisma.ContactWhereInput);
  return negate ? { NOT: { OR: blank } } : { OR: blank };
}

/**
 * Negation that keeps NULL rows.
 *
 * In SQL `stage <> 'lead'` is NULL — and therefore false — for a row whose
 * stage is unset, so "stage is not lead" used to silently exclude every contact
 * with no stage at all. Users mean "not lead, including the ones with nothing
 * set", so nullable fields get an explicit `OR field IS NULL`.
 */
function negatePredicate(
  spec: FieldSpec,
  field: string,
  inner: Prisma.ContactWhereInput,
): Prisma.ContactWhereInput {
  const negated: Prisma.ContactWhereInput = { NOT: inner };
  if (!spec.nullable) return negated;
  return { OR: [negated, { [field]: null } as Prisma.ContactWhereInput] };
}

function textPredicate(spec: FieldSpec, field: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const eq = (v: string): Prisma.ContactWhereInput => ({ [field]: v } as Prisma.ContactWhereInput);
  switch (rule.operator) {
    case 'isEqualTo':
      return eq(textValue(rule.value));
    case 'isNotEqualTo':
      return negatePredicate(spec, field, eq(textValue(rule.value)));
    case 'contains':
      return { [field]: { contains: textValue(rule.value), mode: 'insensitive' } } as Prisma.ContactWhereInput;
    case 'notContains':
      return negatePredicate(spec, field, {
        [field]: { contains: textValue(rule.value), mode: 'insensitive' },
      } as Prisma.ContactWhereInput);
    case 'startsWith':
      return { [field]: { startsWith: textValue(rule.value), mode: 'insensitive' } } as Prisma.ContactWhereInput;
    case 'endsWith':
      return { [field]: { endsWith: textValue(rule.value), mode: 'insensitive' } } as Prisma.ContactWhereInput;
    case 'isOneOf':
      return { [field]: { in: listValue(rule.value) } } as Prisma.ContactWhereInput;
    case 'isNoneOf':
      return negatePredicate(spec, field, { [field]: { in: listValue(rule.value) } } as Prisma.ContactWhereInput);
    case 'isEmpty':
      return emptyPredicate(spec, field, false);
    case 'isNotEmpty':
      return emptyPredicate(spec, field, true);
    default:
      throw new Error(`عامل غير مدعوم: ${rule.operator}`);
  }
}

function enumPredicate(spec: FieldSpec, field: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const check = (v: string) => {
    if (spec.values && !spec.values.includes(v)) {
      throw new Error(`قيمة غير صالحة للحقل ${field}: ${v}`);
    }
    return v;
  };
  if (rule.operator === 'isOneOf' || rule.operator === 'isNoneOf') {
    const list = listValue(rule.value).map(check);
    const inner = { [field]: { in: list } } as Prisma.ContactWhereInput;
    return rule.operator === 'isOneOf' ? inner : negatePredicate(spec, field, inner);
  }
  if (rule.operator === 'isEqualTo' || rule.operator === 'isNotEqualTo') {
    const inner = { [field]: check(textValue(rule.value)) } as Prisma.ContactWhereInput;
    return rule.operator === 'isEqualTo' ? inner : negatePredicate(spec, field, inner);
  }
  if (rule.operator === 'isEmpty') return emptyPredicate(spec, field, false);
  if (rule.operator === 'isNotEmpty') return emptyPredicate(spec, field, true);
  throw new Error(`عامل غير مدعوم: ${rule.operator}`);
}

function datePredicate(spec: FieldSpec, field: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const at = (filter: Prisma.DateTimeFilter): Prisma.ContactWhereInput =>
    ({ [field]: filter } as Prisma.ContactWhereInput);
  switch (rule.operator) {
    case 'withinLastDays':
      return at({ gte: daysAgo(rule.value) });
    case 'moreThanDaysAgo':
      return at({ lt: daysAgo(rule.value) });
    case 'before':
      return at({ lt: dateValue(rule.value) });
    case 'after':
      return at({ gte: dateValue(rule.value) });
    case 'between': {
      // Half-open, matching the convention the usage module uses throughout:
      // an inclusive upper bound on a timestamp silently drops the last day.
      const from = dateValue(rule.value, 'تاريخ البداية');
      const to = dateValue(rule.value2, 'تاريخ النهاية');
      if (to < from) throw new Error('تاريخ النهاية قبل تاريخ البداية');
      return at({ gte: from, lt: to });
    }
    case 'isEmpty':
      if (!spec.nullable) throw new Error(`الحقل ${field} لا يكون فارغًا أبدًا`);
      return { [field]: null } as Prisma.ContactWhereInput;
    case 'isNotEmpty':
      if (!spec.nullable) return {};
      return { [field]: { not: null } } as Prisma.ContactWhereInput;
    default:
      throw new Error(`عامل غير مدعوم: ${rule.operator}`);
  }
}

function numberPredicate(field: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const at = (filter: Prisma.IntFilter): Prisma.ContactWhereInput =>
    ({ [field]: filter } as Prisma.ContactWhereInput);
  switch (rule.operator) {
    case 'isEqualTo': return at({ equals: numberValue(rule.value) });
    case 'gt': return at({ gt: numberValue(rule.value) });
    case 'gte': return at({ gte: numberValue(rule.value) });
    case 'lt': return at({ lt: numberValue(rule.value) });
    case 'lte': return at({ lte: numberValue(rule.value) });
    case 'between': {
      const from = numberValue(rule.value, 'الحد الأدنى');
      const to = numberValue(rule.value2, 'الحد الأعلى');
      if (to < from) throw new Error('الحد الأعلى أقل من الحد الأدنى');
      return at({ gte: from, lte: to });
    }
    default: throw new Error(`عامل غير مدعوم: ${rule.operator}`);
  }
}

// ---------------------------------------------------------------------------
// Relation-derived predicates
// ---------------------------------------------------------------------------

/**
 * Activity dimensions — derived from conversations and messages rather than
 * stored on the contact.
 *
 * Every relation traversed here is declared over a composite foreign key that
 * carries `organizationId` on both sides, so the join itself is tenant-local.
 * `organizationId` is still written explicitly: the tenancy Prisma extension
 * injects it at the *top level* of `where` only and does not descend into
 * nested relation filters, so anything nested is protected by the schema alone.
 * Stating it twice costs nothing and removes the reliance.
 */
function activityPredicate(organizationId: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const scope = { organizationId };
  switch (rule.field) {
    case 'hasEverReplied': {
      const replied: Prisma.ContactWhereInput = {
        conversations: {
          some: { ...scope, messages: { some: { ...scope, direction: 'INBOUND' } } },
        },
      };
      return rule.operator === 'isFalse' ? { NOT: replied } : replied;
    }
    case 'lastInboundAt': {
      // Uses Message.timestamp rather than Conversation.lastMessageAt: the
      // latter also moves when *we* send, so "hasn't been in touch for 90 days"
      // would be silently reset by our own outbound message. The precise
      // two-level `some` is the slower query and the correct answer.
      const inner: Prisma.MessageWhereInput = { ...scope, direction: 'INBOUND' };
      switch (rule.operator) {
        case 'withinLastDays':
          inner.timestamp = { gte: daysAgo(rule.value) };
          return { conversations: { some: { ...scope, messages: { some: inner } } } };
        case 'moreThanDaysAgo':
          // "No inbound message newer than the cutoff" — expressed as a `none`,
          // because a `some` with `lt` matches anyone who has *ever* been quiet
          // for that long, including people who replied yesterday.
          inner.timestamp = { gte: daysAgo(rule.value) };
          return { conversations: { none: { ...scope, messages: { some: inner } } } };
        case 'before':
          inner.timestamp = { gte: dateValue(rule.value) };
          return { conversations: { none: { ...scope, messages: { some: inner } } } };
        case 'after':
          inner.timestamp = { gte: dateValue(rule.value) };
          return { conversations: { some: { ...scope, messages: { some: inner } } } };
        default:
          throw new Error(`عامل غير مدعوم: ${rule.operator}`);
      }
    }
    case 'hasOpenConversation': {
      const open: Prisma.ContactWhereInput = {
        conversations: { some: { ...scope, status: { in: ['OPEN', 'PENDING'] }, isArchived: false } },
      };
      return rule.operator === 'isFalse' ? { NOT: open } : open;
    }
    case 'conversationStatus':
      return { conversations: { some: { ...scope, status: textValue(rule.value) as never, isArchived: false } } };
    case 'teamId':
      // Ambiguous by nature — a Contact has no team. This means "has a
      // conversation currently routed to that team", which is the question an
      // agent actually asks; the assignee's own team membership is a different
      // question and deliberately not this one.
      return { conversations: { some: { ...scope, teamId: textValue(rule.value) } } };
    default:
      throw new Error(`حقل نشاط غير مدعوم: ${rule.field}`);
  }
}

/**
 * Broadcast history, read off `CampaignRecipient`.
 *
 * `campaignId` is validated against the caller's organization *before* it
 * reaches here — see `assertCampaignInOrg` in the campaigns module. Left
 * unvalidated it fails safe (matches nothing), but "0 recipients" is itself an
 * answer, and answering it for another tenant's campaign id is a probe.
 */
function broadcastPredicate(organizationId: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  const scope = { organizationId };
  switch (rule.field) {
    case 'receivedCampaign':
      return {
        campaignRecipients: {
          some: { ...scope, campaignId: textValue(rule.value), status: { in: ['sent', 'delivered', 'read'] } },
        },
      };
    case 'readCampaign':
      return { campaignRecipients: { some: { ...scope, campaignId: textValue(rule.value), readAt: { not: null } } } };
    case 'receivedAnyWithinDays':
      return { campaignRecipients: { some: { ...scope, sentAt: { gte: daysAgo(rule.value) } } } };
    case 'hasNoBroadcasts':
      return { campaignRecipients: { none: { ...scope, sentAt: { not: null } } } };
    default:
      throw new Error(`حقل بث غير مدعوم: ${rule.field}`);
  }
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/*
 * Deliberately absent: `matchesRegex`.
 *
 * Prisma exposes no regex predicate for PostgreSQL, so the only way to offer it
 * is `$queryRaw` — which bypasses the tenancy extension entirely and would be
 * the first unscoped query in this path. A regex operator is not worth being
 * the hole every other filter avoided. `contains` / `startsWith` / `endsWith`
 * cover what people actually reach for.
 */

function compileRule(organizationId: string, rule: ContactFilterRule): Prisma.ContactWhereInput {
  if (rule.category === 'activity') return activityPredicate(organizationId, rule);
  if (rule.category === 'broadcast') return broadcastPredicate(organizationId, rule);

  if (rule.category === 'contactField') {
    const spec = CONTACT_FIELDS[rule.field];
    if (!spec) throw new Error(`حقل غير مدعوم: ${rule.field}`);
    if (!OPERATORS_BY_TYPE[spec.type].includes(rule.operator)) {
      throw new Error(`العامل ${rule.operator} لا ينطبق على الحقل ${rule.field}`);
    }
    switch (spec.type) {
      case 'text': return textPredicate(spec, rule.field, rule);
      case 'enum': return enumPredicate(spec, rule.field, rule);
      case 'date': return datePredicate(spec, rule.field, rule);
      case 'number': return numberPredicate(rule.field, rule);
      default: throw new Error(`نوع حقل غير مدعوم`);
    }
  }

  if (rule.category === 'tag') {
    const name = textValue(rule.value || rule.field);
    if (rule.operator === 'isEmpty') return { contactTags: { none: { organizationId } } };
    if (rule.operator === 'isNotEmpty') return { contactTags: { some: { organizationId } } };
    if (rule.operator === 'isOneOf' || rule.operator === 'isNoneOf') {
      const inner: Prisma.ContactWhereInput = {
        contactTags: { some: { organizationId, tag: { name: { in: listValue(rule.value) } } } },
      };
      return rule.operator === 'isOneOf' ? inner : { NOT: inner };
    }
    if (!name) throw new Error('فلتر الوسم يتطلب اسمًا');
    if (rule.operator === 'isNotEqualTo') {
      return { NOT: { contactTags: { some: { organizationId, tag: { name } } } } };
    }
    return { contactTags: { some: { organizationId, tag: { name } } } };
  }

  if (rule.category === 'customField') {
    const slug = rule.field;
    if (!slug) throw new Error('فلتر الحقل المخصص يتطلب معرفًا');
    if (rule.operator === 'isEmpty') {
      return { customFieldValues: { none: { organizationId, fieldDefinition: { slug } } } };
    }
    if (rule.operator === 'isNotEmpty') {
      return { customFieldValues: { some: { organizationId, fieldDefinition: { slug }, value: { not: null } } } };
    }
    // Custom-field values are stored as text regardless of their declared type,
    // so they keep the text vocabulary rather than gaining typed operators.
    const spec: FieldSpec = { type: 'text', nullable: true };
    const inner = textPredicate(spec, 'value', rule) as Record<string, unknown>;
    return {
      customFieldValues: { some: { organizationId, fieldDefinition: { slug }, ...inner } },
    } as Prisma.ContactWhereInput;
  }

  throw new Error(`فئة فلتر غير مدعومة: ${(rule as ContactFilterRule).category}`);
}

function compileNode(organizationId: string, node: ContactFilterNode, depth: number): Prisma.ContactWhereInput {
  if (depth > MAX_FILTER_DEPTH) throw new Error(`تجاوز الحد الأقصى لتداخل المجموعات (${MAX_FILTER_DEPTH})`);
  if (isGroup(node)) return compileGroup(organizationId, node, depth);
  return compileRule(organizationId, node);
}

function compileGroup(organizationId: string, group: ContactFilterGroup, depth: number): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {};
  if (group.$and?.length) where.AND = group.$and.map((child) => compileNode(organizationId, child, depth + 1));
  if (group.$or?.length) where.OR = group.$or.map((child) => compileNode(organizationId, child, depth + 1));
  return where;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type FilterValidationResult = {
  valid: boolean;
  /** Human-readable, each prefixed with its path, e.g. "$and[0]: حقل غير مدعوم: foo". */
  errors: string[];
};

/** Whether a node tree contains at least one actual rule. */
function hasAnyRule(node: ContactFilterNode | null | undefined): boolean {
  if (!node) return false;
  if (!isGroup(node)) return true;
  return [...(node.$and || []), ...(node.$or || [])].some(hasAnyRule);
}

function collectNodeErrors(
  organizationId: string,
  node: ContactFilterNode,
  depth: number,
  path: string,
  errors: string[],
): void {
  if (depth > MAX_FILTER_DEPTH) {
    errors.push(`${path}: تجاوز الحد الأقصى لتداخل المجموعات (${MAX_FILTER_DEPTH})`);
    return;
  }
  if (isGroup(node)) {
    const key = node.$or ? '$or' : '$and';
    const children = (node.$or || node.$and || []) as ContactFilterNode[];
    children.forEach((child, index) =>
      collectNodeErrors(organizationId, child, depth + 1, `${path}.${key}[${index}]`, errors));
    return;
  }
  try {
    // The real compiler, not a re-implementation. That is what makes
    // "validation matches the vocabulary exactly" true rather than aspirational:
    // a filter that validates has already compiled.
    compileRule(organizationId, node as ContactFilterRule);
  } catch (error) {
    errors.push(`${path}: ${(error as Error).message}`);
  }
}

/**
 * Check a filter without throwing, collecting **every** problem rather than
 * stopping at the first.
 *
 * `contactWhereFromFilterDsl` throws on the first failure, which is right for a
 * request and wrong for a save dialog — someone fixing four broken rules one
 * round-trip at a time gives up.
 */
export function validateContactFilter(
  filter: unknown,
  organizationId: string,
): FilterValidationResult {
  const errors: string[] = [];

  if (filter === null || filter === undefined || typeof filter !== 'object' || Array.isArray(filter)) {
    return { valid: false, errors: ['الفلتر غير صالح'] };
  }

  const group = filter as ContactFilterGroup;
  if (!Array.isArray(group.$and) && !Array.isArray(group.$or)) {
    return { valid: false, errors: ['الفلتر غير صالح'] };
  }

  // An empty filter compiles perfectly and matches EVERYONE. Saved under a name
  // like "VIP customers" and pointed at a broadcast, it is the most dangerous
  // thing this DSL can store, so it is rejected rather than silently accepted.
  if (!hasAnyRule(group)) {
    return { valid: false, errors: ['الفلتر فارغ — الشريحة ستشمل كل جهات الاتصال'] };
  }

  collectNodeErrors(organizationId, group, 0, '$', errors);
  return { valid: errors.length === 0, errors };
}

export function parseContactFilterDsl(value: unknown): ContactFilterDsl | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    try {
      return JSON.parse(text) as ContactFilterDsl;
    } catch {
      throw new Error('صيغة الفلتر غير صالحة');
    }
  }
  return value as ContactFilterDsl;
}

/**
 * Compile a filter to a Prisma `where`.
 *
 * `organizationId` is required rather than optional: every relation-derived
 * predicate writes it into its nested filter, and a compiler that could be
 * called without it would make that protection accidental.
 */
export function contactWhereFromFilterDsl(
  filter: ContactFilterDsl | null | undefined,
  organizationId: string,
): Prisma.ContactWhereInput {
  if (!filter) return {};
  if (!organizationId) throw new Error('contactWhereFromFilterDsl requires an organizationId');
  return compileGroup(organizationId, filter, 0);
}

/** Every campaign id referenced anywhere in a filter, for org validation. */
export function campaignIdsInFilter(filter: ContactFilterDsl | null | undefined): string[] {
  const found = new Set<string>();
  const walk = (node: ContactFilterNode | null | undefined) => {
    if (!node) return;
    if (isGroup(node)) {
      [...(node.$and || []), ...(node.$or || [])].forEach(walk);
      return;
    }
    const rule = node as ContactFilterRule;
    if (rule.category === 'broadcast' && (rule.field === 'receivedCampaign' || rule.field === 'readCampaign')) {
      const id = textValue(rule.value);
      if (id) found.add(id);
    }
  };
  walk(filter);
  return [...found];
}

/** Vocabulary served to the builder so the UI never hardcodes its own copy. */
export function filterVocabulary() {
  return {
    maxDepth: MAX_FILTER_DEPTH,
    valuelessOperators: [...VALUELESS],
    contactFields: Object.entries(CONTACT_FIELDS).map(([field, spec]) => ({
      field,
      type: spec.type,
      values: spec.values ?? null,
      operators: OPERATORS_BY_TYPE[spec.type],
    })),
    activityFields: [
      { field: 'hasEverReplied', type: 'boolean', operators: ['isTrue', 'isFalse'] },
      { field: 'lastInboundAt', type: 'date', operators: ['withinLastDays', 'moreThanDaysAgo', 'before', 'after'] },
      { field: 'hasOpenConversation', type: 'boolean', operators: ['isTrue', 'isFalse'] },
      { field: 'conversationStatus', type: 'enum', values: ['OPEN', 'PENDING', 'RESOLVED'], operators: ['isEqualTo'] },
      { field: 'teamId', type: 'reference', operators: ['isEqualTo'] },
    ],
    broadcastFields: [
      { field: 'receivedCampaign', type: 'campaign', operators: ['isEqualTo'] },
      { field: 'readCampaign', type: 'campaign', operators: ['isEqualTo'] },
      { field: 'receivedAnyWithinDays', type: 'number', operators: ['withinLastDays'] },
      { field: 'hasNoBroadcasts', type: 'boolean', operators: ['hasNoBroadcasts'] },
    ],
  };
}

export function normalizeContactLimit(value: unknown): number {
  const parsed = Number(value || 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(100, Math.floor(parsed));
}

export function normalizeCursor(value: unknown): string | undefined {
  const text = textValue(value);
  return text || undefined;
}
