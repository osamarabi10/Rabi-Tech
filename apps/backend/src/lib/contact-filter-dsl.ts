import { Prisma } from '@prisma/client';

export type ContactFilterRule = {
  category: 'contactField' | 'tag' | 'customField';
  field: string;
  operator: 'isEqualTo' | 'isNotEqualTo' | 'contains' | 'startsWith' | 'isEmpty' | 'isNotEmpty';
  value?: unknown;
};

export type ContactFilterDsl = {
  $and?: ContactFilterRule[];
  $or?: ContactFilterRule[];
};

const CONTACT_STRING_FIELDS = new Set([
  'id',
  'name',
  'phone',
  'firstName',
  'lastName',
  'email',
  'language',
  'countryCode',
  'lifecycleStage',
  'assigneeId',
]);

function textValue(value: unknown): string {
  return String(value ?? '').trim();
}

function stringPredicate(rule: ContactFilterRule): Prisma.StringNullableFilter | string | null {
  const value = textValue(rule.value);
  switch (rule.operator) {
    case 'isEqualTo':
      return value;
    case 'isNotEqualTo':
      return { not: value };
    case 'contains':
      return { contains: value, mode: 'insensitive' };
    case 'startsWith':
      return { startsWith: value, mode: 'insensitive' };
    case 'isEmpty':
      return null;
    case 'isNotEmpty':
      return { not: null };
    default:
      throw new Error(`Unsupported operator ${rule.operator}`);
  }
}

function compileRule(rule: ContactFilterRule): Prisma.ContactWhereInput {
  if (rule.category === 'contactField') {
    if (!CONTACT_STRING_FIELDS.has(rule.field)) throw new Error(`Unsupported contact field ${rule.field}`);
    return { [rule.field]: stringPredicate(rule) } as Prisma.ContactWhereInput;
  }

  if (rule.category === 'tag') {
    const name = textValue(rule.value || rule.field);
    if (!name) throw new Error('Tag filter requires a name');
    if (rule.operator === 'isNotEqualTo') {
      return { NOT: { contactTags: { some: { tag: { name } } } } };
    }
    if (rule.operator === 'isEmpty') return { contactTags: { none: {} } };
    if (rule.operator === 'isNotEmpty') return { contactTags: { some: {} } };
    return { contactTags: { some: { tag: { name } } } };
  }

  if (rule.category === 'customField') {
    const value = stringPredicate(rule);
    const slug = rule.field;
    if (!slug) throw new Error('Custom field filter requires a slug');
    if (rule.operator === 'isEmpty') {
      return { customFieldValues: { none: { fieldDefinition: { slug } } } };
    }
    if (rule.operator === 'isNotEmpty') {
      return { customFieldValues: { some: { fieldDefinition: { slug }, value: { not: null } } } };
    }
    return {
      customFieldValues: {
        some: {
          fieldDefinition: { slug },
          value,
        },
      },
    };
  }

  throw new Error(`Unsupported filter category ${(rule as ContactFilterRule).category}`);
}

export function parseContactFilterDsl(value: unknown): ContactFilterDsl | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return JSON.parse(text) as ContactFilterDsl;
  }
  return value as ContactFilterDsl;
}

export function contactWhereFromFilterDsl(filter: ContactFilterDsl | null | undefined): Prisma.ContactWhereInput {
  if (!filter) return {};
  const where: Prisma.ContactWhereInput = {};
  if (filter.$and?.length) where.AND = filter.$and.map(compileRule);
  if (filter.$or?.length) where.OR = filter.$or.map(compileRule);
  return where;
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
