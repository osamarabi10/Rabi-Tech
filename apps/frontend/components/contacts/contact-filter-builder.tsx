'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, FolderPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  fetchFilterSchema,
  type ContactFilterDsl,
  type ContactFilterRule,
  type FilterFieldSpec,
  type FilterSchema,
} from '@/lib/data';
import { TWO_VALUE_OPERATORS, VALUELESS_OPERATORS } from '@/lib/contact-filter';
import { categoryLabel, enumValueLabel, fieldLabel, operatorLabel } from '@/lib/filter-labels';

/**
 * The segment builder.
 *
 * Two things changed here that are worth knowing before editing:
 *
 * 1. **The vocabulary is fetched, not hardcoded.** Only the server can reject an
 *    unknown field, so a client-side list drifts into offering filters that 400.
 *    Custom fields, tags, teams and sent campaigns are per-organization anyway
 *    and cannot be known at build time.
 * 2. **Operators depend on the field's type.** The old dropdown was
 *    category-independent, so it happily offered "within last N days" on a
 *    name. Now each field declares its type and only its own operators appear.
 *
 * Groups nest to the depth the server allows. A group is just another node in
 * the same list, which is why the tree is rendered recursively rather than as
 * one flat grid.
 */

type Node = ContactFilterRule | ContactFilterDsl;

function isGroup(node: Node): node is ContactFilterDsl {
  return Array.isArray((node as ContactFilterDsl).$and) || Array.isArray((node as ContactFilterDsl).$or);
}

const emptyRule = (): ContactFilterRule => ({
  category: 'contactField',
  field: 'name',
  operator: 'contains',
  value: '',
});

const emptyGroup = (): ContactFilterDsl => ({ $or: [emptyRule()] });

/** A group carries its rules under exactly one of `$and` / `$or`. */
function groupOp(group: ContactFilterDsl): '$and' | '$or' {
  return group.$or ? '$or' : '$and';
}
function groupChildren(group: ContactFilterDsl): Node[] {
  return (group.$or || group.$and || []) as Node[];
}
function withChildren(op: '$and' | '$or', children: Node[]): ContactFilterDsl {
  return { [op]: children } as ContactFilterDsl;
}

export function ContactFilterBuilder({
  value,
  onChange,
}: {
  value: ContactFilterDsl;
  onChange: (value: ContactFilterDsl) => void;
}) {
  const { t } = useT();
  const [schema, setSchema] = useState<FilterSchema | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFilterSchema()
      .then((next) => { if (!cancelled) setSchema(next); })
      .catch(() => { if (!cancelled) setSchema(null); });
    return () => { cancelled = true; };
  }, []);

  const root = useMemo<ContactFilterDsl>(() => (value?.$and || value?.$or ? value : { $and: [] }), [value]);

  if (!schema) {
    return <p className="text-xs text-muted-foreground">{t('جارٍ تحميل الفلاتر')}</p>;
  }

  return (
    <GroupEditor
      schema={schema}
      group={root}
      depth={1}
      onChange={onChange}
      onRemove={null}
      t={t}
    />
  );
}

function GroupEditor({
  schema,
  group,
  depth,
  onChange,
  onRemove,
  t,
}: {
  schema: FilterSchema;
  group: ContactFilterDsl;
  depth: number;
  onChange: (next: ContactFilterDsl) => void;
  onRemove: (() => void) | null;
  t: (key: string) => string;
}) {
  const op = groupOp(group);
  const children = groupChildren(group);
  const isRoot = onRemove === null;
  // Depth is counted the way the compiler counts it, so the button disappears at
  // exactly the point the server would start rejecting the filter — rather than
  // letting someone build a tree that only fails when they hit preview.
  const canNest = depth < schema.maxDepth;

  const replace = (index: number, next: Node) =>
    onChange(withChildren(op, children.map((child, i) => (i === index ? next : child))));
  const remove = (index: number) =>
    onChange(withChildren(op, children.filter((_, i) => i !== index)));
  const add = (node: Node) => onChange(withChildren(op, [...children, node]));

  return (
    <div
      className={cn(
        'space-y-2',
        !isRoot && 'rounded-md border border-border bg-[hsl(var(--surface-1))] p-2',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-muted-foreground">
            {isRoot ? t('الفلاتر') : t('مجموعة')}
          </p>
          {children.length > 1 && (
            <Select value={op} onValueChange={(next) => onChange(withChildren(next as '$and' | '$or', children))}>
              <SelectTrigger className="h-7 w-[104px] text-[11px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="$and">{t('كل الشروط')}</SelectItem>
                <SelectItem value="$or">{t('أي شرط')}</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => add(emptyRule())}>
            <Plus className="h-4 w-4" />
            {t('إضافة')}
          </Button>
          {canNest && (
            <Button type="button" size="sm" variant="ghost" onClick={() => add(emptyGroup())}>
              <FolderPlus className="h-4 w-4" />
              {t('مجموعة')}
            </Button>
          )}
          {onRemove && (
            <Button type="button" size="icon" variant="ghost" onClick={onRemove}>
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {children.length === 0 && <p className="text-xs text-muted-foreground">{t('بدون فلاتر')}</p>}

      {children.map((child, index) =>
        isGroup(child) ? (
          <GroupEditor
            key={index}
            schema={schema}
            group={child}
            depth={depth + 1}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
            t={t}
          />
        ) : (
          <RuleEditor
            key={index}
            schema={schema}
            rule={child}
            onChange={(next) => replace(index, next)}
            onRemove={() => remove(index)}
            t={t}
          />
        ),
      )}
    </div>
  );
}

function RuleEditor({
  schema,
  rule,
  onChange,
  onRemove,
  t,
}: {
  schema: FilterSchema;
  rule: ContactFilterRule;
  onChange: (next: ContactFilterRule) => void;
  onRemove: () => void;
  t: (key: string) => string;
}) {
  const fields = fieldsForCategory(schema, rule.category);
  const spec = fields.find((f) => f.field === rule.field) || null;
  const operators = spec?.operators || [];
  const valueless = VALUELESS_OPERATORS.has(rule.operator) || schema.valuelessOperators.includes(rule.operator);
  const twoValues = TWO_VALUE_OPERATORS.has(rule.operator);

  // Changing category or field can strip the operator's meaning — "contains" on
  // a date is nonsense. Snap to the first operator the new field actually
  // supports rather than leaving a combination the server will reject.
  const pickCategory = (category: string) => {
    const next = fieldsForCategory(schema, category);
    const field = category === 'tag' ? '' : next[0]?.field || '';
    onChange({
      category: category as ContactFilterRule['category'],
      field,
      operator: category === 'tag' ? 'isEqualTo' : next[0]?.operators[0] || 'isEqualTo',
      value: '',
    });
  };
  const pickField = (field: string) => {
    const nextSpec = fields.find((f) => f.field === field);
    const keep = nextSpec?.operators.includes(rule.operator);
    onChange({
      ...rule,
      field,
      operator: keep ? rule.operator : nextSpec?.operators[0] || 'isEqualTo',
      value: keep ? rule.value : '',
      value2: undefined,
    });
  };

  return (
    <div
      className={cn(
        'grid gap-2',
        // Two value inputs do not fit the old fixed five-column grid, so the row
        // widens only when the operator actually needs a second operand.
        twoValues
          ? 'md:grid-cols-[130px_170px_170px_1fr_1fr_40px]'
          : 'md:grid-cols-[130px_170px_170px_1fr_40px]',
      )}
    >
      <Select value={rule.category} onValueChange={pickCategory}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {['contactField', 'tag', 'customField', 'activity', 'broadcast'].map((category) => (
            <SelectItem key={category} value={category}>{t(categoryLabel(category))}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {rule.category === 'tag' ? (
        <TagPicker schema={schema} rule={rule} onChange={onChange} t={t} />
      ) : (
        <Select value={rule.field} onValueChange={pickField}>
          <SelectTrigger><SelectValue placeholder={t('الحقل')} /></SelectTrigger>
          <SelectContent>
            {fields.map((field) => (
              <SelectItem key={field.field} value={field.field}>
                {t(fieldLabel(field.field))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Select
        value={rule.operator}
        onValueChange={(operator) => onChange({ ...rule, operator, value2: undefined })}
      >
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {(rule.category === 'tag' ? TAG_OPERATORS : operators).map((operator) => (
            <SelectItem key={operator} value={operator}>{t(operatorLabel(operator))}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {valueless ? (
        <div className="hidden md:block" />
      ) : (
        <ValueInput schema={schema} rule={rule} spec={spec} onChange={onChange} t={t} slot={1} />
      )}
      {twoValues && <ValueInput schema={schema} rule={rule} spec={spec} onChange={onChange} t={t} slot={2} />}

      <Button type="button" size="icon" variant="ghost" onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}

const TAG_OPERATORS = ['isEqualTo', 'isNotEqualTo', 'isOneOf', 'isNoneOf', 'isEmpty', 'isNotEmpty'];

function fieldsForCategory(schema: FilterSchema, category: string): FilterFieldSpec[] {
  if (category === 'contactField') return schema.contactFields;
  if (category === 'activity') return schema.activityFields;
  if (category === 'broadcast') return schema.broadcastFields;
  if (category === 'customField') {
    // Custom-field values are stored as text whatever their declared type, so
    // they get the text vocabulary rather than typed operators they cannot honour.
    return schema.customFields.map((definition) => ({
      field: definition.slug,
      type: 'text',
      values: definition.allowedValues?.length ? definition.allowedValues : null,
      operators: schema.contactFields.find((f) => f.type === 'text')?.operators || [],
    }));
  }
  return [];
}

/**
 * The value input, chosen from the field's declared type.
 *
 * A date field gets a date picker, an enum gets its own closed list, a campaign
 * gets the list of campaigns that actually went out. Typing a raw campaign id
 * into a text box was never a real option.
 */
function ValueInput({
  schema,
  rule,
  spec,
  onChange,
  t,
  slot,
}: {
  schema: FilterSchema;
  rule: ContactFilterRule;
  spec: FilterFieldSpec | null;
  onChange: (next: ContactFilterRule) => void;
  t: (key: string) => string;
  slot: 1 | 2;
}) {
  const key = slot === 1 ? 'value' : 'value2';
  const current = String((slot === 1 ? rule.value : rule.value2) ?? '');
  const set = (next: unknown) => onChange({ ...rule, [key]: next });

  const dayOperators = ['withinLastDays', 'moreThanDaysAgo'];
  if (dayOperators.includes(rule.operator)) {
    return (
      <Input
        type="number"
        min={0}
        value={current}
        onChange={(event) => set(event.target.value)}
        placeholder={t('عدد الأيام')}
      />
    );
  }

  if (rule.field === 'teamId') {
    return (
      <Select value={current} onValueChange={set}>
        <SelectTrigger><SelectValue placeholder={t('اختر الفريق')} /></SelectTrigger>
        <SelectContent>
          {schema.teams.map((team) => (
            <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (spec?.type === 'campaign') {
    if (!schema.campaigns.length) {
      return <p className="self-center text-[11px] text-muted-foreground">{t('لا توجد حملات مُرسلة بعد')}</p>;
    }
    return (
      <Select value={current} onValueChange={set}>
        <SelectTrigger><SelectValue placeholder={t('اختر الحملة')} /></SelectTrigger>
        <SelectContent>
          {schema.campaigns.map((campaign) => (
            <SelectItem key={campaign.id} value={campaign.id}>{campaign.title}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (spec?.values?.length && (rule.operator === 'isEqualTo' || rule.operator === 'isNotEqualTo')) {
    return (
      <Select value={current} onValueChange={set}>
        <SelectTrigger><SelectValue placeholder={t('القيمة')} /></SelectTrigger>
        <SelectContent>
          {spec.values.map((option) => (
            <SelectItem key={option} value={option}>{t(enumValueLabel(option))}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (spec?.type === 'date') {
    return <Input type="date" value={current} onChange={(event) => set(event.target.value)} />;
  }

  if (spec?.type === 'number') {
    return (
      <Input
        type="number"
        value={current}
        onChange={(event) => set(event.target.value)}
        placeholder={t('القيمة')}
      />
    );
  }

  if (rule.operator === 'isOneOf' || rule.operator === 'isNoneOf') {
    return (
      <Input
        value={current}
        onChange={(event) => set(event.target.value)}
        placeholder={t('قيم مفصولة بفاصلة')}
      />
    );
  }

  return (
    <Input
      value={current}
      onChange={(event) => set(event.target.value)}
      placeholder={t('القيمة')}
    />
  );
}

/**
 * Tags are picked from the ones that exist. A free-text tag name silently
 * matched nothing whenever it was misspelled, which reads as "the filter is
 * broken" rather than "that tag does not exist".
 */
function TagPicker({
  schema,
  rule,
  onChange,
  t,
}: {
  schema: FilterSchema;
  rule: ContactFilterRule;
  onChange: (next: ContactFilterRule) => void;
  t: (key: string) => string;
}) {
  if (!schema.tags.length) {
    return <p className="self-center text-[11px] text-muted-foreground">{t('لا توجد وسوم')}</p>;
  }
  return (
    <Select value={String(rule.value ?? '')} onValueChange={(name) => onChange({ ...rule, field: 'name', value: name })}>
      <SelectTrigger><SelectValue placeholder={t('اسم الوسم')} /></SelectTrigger>
      <SelectContent>
        {schema.tags.map((tag) => (
          <SelectItem key={tag.name} value={tag.name}>{tag.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
