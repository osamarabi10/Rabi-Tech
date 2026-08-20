'use client';

import { Plus, Trash2 } from 'lucide-react';
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
import type { ContactFilterDsl, ContactFilterRule } from '@/lib/data';

/**
 * Labels are Arabic source strings passed through t() — never "English / عربي"
 * in one literal. A baked-in bilingual label bypasses translation entirely and
 * shows both languages at once whichever locale the user picked.
 */
const FIELD_OPTIONS = [
  { value: 'name', label: 'الاسم' },
  { value: 'phone', label: 'الهاتف' },
  { value: 'email', label: 'البريد الإلكتروني' },
  { value: 'lifecycleStage', label: 'المرحلة' },
  { value: 'countryCode', label: 'الدولة' },
  { value: 'assigneeId', label: 'المسؤول' },
];

const OPERATOR_OPTIONS = [
  { value: 'contains', label: 'يحتوي' },
  { value: 'isEqualTo', label: 'يساوي' },
  { value: 'startsWith', label: 'يبدأ بـ' },
  { value: 'isNotEqualTo', label: 'لا يساوي' },
  { value: 'isEmpty', label: 'فارغ' },
  { value: 'isNotEmpty', label: 'غير فارغ' },
];

const CATEGORY_OPTIONS = [
  { value: 'contactField', label: 'حقل جهة الاتصال' },
  { value: 'tag', label: 'وسم' },
  { value: 'customField', label: 'حقل مخصص' },
];

const emptyRule = (): ContactFilterRule => ({
  category: 'contactField',
  field: 'name',
  operator: 'contains',
  value: '',
});

export function ContactFilterBuilder({
  value,
  onChange,
}: {
  value: ContactFilterDsl;
  onChange: (value: ContactFilterDsl) => void;
}) {
  const { t } = useT();
  const rules = value.$and || [];

  const updateRule = (index: number, next: ContactFilterRule) => {
    onChange({ $and: rules.map((rule, i) => (i === index ? next : rule)) });
  };

  const addRule = () => onChange({ $and: [...rules, emptyRule()] });
  const removeRule = (index: number) => onChange({ $and: rules.filter((_, i) => i !== index) });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">{t('الفلاتر')}</p>
        <Button type="button" size="sm" variant="outline" onClick={addRule}>
          <Plus className="h-4 w-4" />
          {t('إضافة')}
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('بدون فلاتر')}</p>
      )}
      {rules.map((rule, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[140px_180px_180px_1fr_40px]">
          <Select
            value={rule.category}
            onValueChange={(category) =>
              updateRule(index, {
                ...rule,
                category: category as ContactFilterRule['category'],
                field: category === 'tag' ? 'name' : category === 'customField' ? '' : 'name',
              })
            }
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((category) => (
                <SelectItem key={category.value} value={category.value}>
                  {t(category.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {rule.category === 'contactField' ? (
            <Select value={rule.field} onValueChange={(field) => updateRule(index, { ...rule, field })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FIELD_OPTIONS.map((field) => (
                  <SelectItem key={field.value} value={field.value}>{t(field.label)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={rule.category === 'tag' ? t('اسم الوسم') : t('رمز الحقل')}
              value={rule.field}
              onChange={(event) => updateRule(index, { ...rule, field: event.target.value })}
            />
          )}

          <Select
            value={rule.operator}
            onValueChange={(operator) => updateRule(index, { ...rule, operator: operator as ContactFilterRule['operator'] })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {OPERATOR_OPTIONS.map((operator) => (
                <SelectItem key={operator.value} value={operator.value}>{t(operator.label)}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            value={rule.value || ''}
            disabled={rule.operator === 'isEmpty' || rule.operator === 'isNotEmpty'}
            onChange={(event) => updateRule(index, { ...rule, value: event.target.value })}
            placeholder={t('القيمة')}
          />

          <Button type="button" size="icon" variant="ghost" onClick={() => removeRule(index)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
