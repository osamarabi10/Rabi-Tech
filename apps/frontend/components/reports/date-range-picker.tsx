'use client';

import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useT } from '@/lib/i18n';

export type ReportPreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'last_30_days'
  | 'last_90_days'
  | 'this_month'
  | 'last_month';

export const REPORT_PRESETS: Array<{ value: ReportPreset; label: string }> = [
  { value: 'today', label: 'اليوم' },
  { value: 'yesterday', label: 'أمس' },
  { value: 'last_7_days', label: 'آخر ٧ أيام' },
  { value: 'last_30_days', label: 'آخر ٣٠ يوم' },
  { value: 'last_90_days', label: 'آخر ٩٠ يوم' },
  { value: 'this_month', label: 'هذا الشهر' },
  { value: 'last_month', label: 'الشهر الماضي' },
];

export type ResolvedReportRange = {
  from: string;
  to: string;
  days: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(value: Date): Date {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

function startOfMonth(value: Date): Date {
  const result = startOfDay(value);
  result.setDate(1);
  return result;
}

export function resolveReportPreset(preset: ReportPreset, now = new Date()): ResolvedReportRange {
  const today = startOfDay(now);
  let from: Date;
  let to = now;

  switch (preset) {
    case 'today':
      from = today;
      break;
    case 'yesterday':
      from = new Date(today.getTime() - DAY_MS);
      to = today;
      break;
    case 'last_7_days':
      from = new Date(now.getTime() - 7 * DAY_MS);
      break;
    case 'last_30_days':
      from = new Date(now.getTime() - 30 * DAY_MS);
      break;
    case 'last_90_days':
      from = new Date(now.getTime() - 90 * DAY_MS);
      break;
    case 'this_month':
      from = startOfMonth(now);
      break;
    case 'last_month':
      to = startOfMonth(now);
      from = new Date(to);
      from.setMonth(from.getMonth() - 1);
      break;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    days: Math.max(1, Math.ceil((to.getTime() - from.getTime()) / DAY_MS)),
  };
}

export function DateRangePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ReportPreset;
  onChange: (value: ReportPreset) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const selected = REPORT_PRESETS.find((preset) => preset.value === value) ?? REPORT_PRESETS[2];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={t('الفترة الزمنية')}
          className="gap-2"
        >
          <CalendarDays className="size-3.5" aria-hidden />
          <span>{t(selected.label)}</span>
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {REPORT_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.value} onSelect={() => onChange(preset.value)}>
            <Check className={preset.value === value ? 'size-4 opacity-100' : 'size-4 opacity-0'} aria-hidden />
            {t(preset.label)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
