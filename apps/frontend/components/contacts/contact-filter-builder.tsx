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
import type { ContactFilterDsl, ContactFilterRule } from '@/lib/data';

const FIELD_OPTIONS = [
  { value: 'name', label: 'Name / الاسم' },
  { value: 'phone', label: 'Phone / الهاتف' },
  { value: 'email', label: 'Email / البريد' },
  { value: 'lifecycleStage', label: 'Lifecycle / المرحلة' },
  { value: 'countryCode', label: 'Country / الدولة' },
  { value: 'assigneeId', label: 'Assignee ID / المسؤول' },
];

const OPERATOR_OPTIONS = [
  { value: 'contains', label: 'Contains / يحتوي' },
  { value: 'isEqualTo', label: 'Equals / يساوي' },
  { value: 'startsWith', label: 'Starts with / يبدأ' },
  { value: 'isNotEqualTo', label: 'Not equals / لا يساوي' },
  { value: 'isEmpty', label: 'Empty / فارغ' },
  { value: 'isNotEmpty', label: 'Not empty / غير فارغ' },
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
  const rules = value.$and || [];

  const updateRule = (index: number, next: ContactFilterRule) => {
    onChange({ $and: rules.map((rule, i) => (i === index ? next : rule)) });
  };

  const addRule = () => onChange({ $and: [...rules, emptyRule()] });
  const removeRule = (index: number) => onChange({ $and: rules.filter((_, i) => i !== index) });

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">Filters / الفلاتر</p>
        <Button type="button" size="sm" variant="outline" onClick={addRule}>
          <Plus className="h-4 w-4" />
          Add
        </Button>
      </div>
      {rules.length === 0 && <p className="text-xs text-muted-foreground">No filters / بدون فلاتر</p>}
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
              <SelectItem value="contactField">Contact</SelectItem>
              <SelectItem value="tag">Tag</SelectItem>
              <SelectItem value="customField">Custom field</SelectItem>
            </SelectContent>
          </Select>

          {rule.category === 'contactField' ? (
            <Select value={rule.field} onValueChange={(field) => updateRule(index, { ...rule, field })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {FIELD_OPTIONS.map((field) => (
                  <SelectItem key={field.value} value={field.value}>{field.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              placeholder={rule.category === 'tag' ? 'Tag name / اسم الوسم' : 'Field slug / رمز الحقل'}
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
                <SelectItem key={operator.value} value={operator.value}>{operator.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            value={rule.value || ''}
            disabled={rule.operator === 'isEmpty' || rule.operator === 'isNotEmpty'}
            onChange={(event) => updateRule(index, { ...rule, value: event.target.value })}
            placeholder="Value / القيمة"
          />

          <Button type="button" size="icon" variant="ghost" onClick={() => removeRule(index)}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
