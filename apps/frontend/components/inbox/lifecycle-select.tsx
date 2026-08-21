'use client';

import { useEffect, useState } from 'react';
import { fetchLifecycleStages, type LifecycleStage } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Contact lifecycle stage selector.
 *
 * The options come from the tenant's own configured pipeline, never from a
 * constant here — a hardcoded "Lead / Customer / …" would be vocabulary the
 * subscriber could not rename into their own language.
 *
 * One case shapes the rest of this component: **a contact can hold a stage that
 * is no longer in the list.** `Contact.lifecycleStage` is free text, written by
 * hand and by CSV import long before this list existed, and deleting a stage
 * does not rewrite the contacts in it. A plain `<select>` silently shows the
 * first option when its value matches nothing, which would misreport where that
 * contact stands and overwrite it the moment anyone touched the control. So an
 * unknown value is kept as an explicit option, marked as no longer configured.
 */

/** Stages change rarely; fetched once per mount and shared by both selectors. */
export function useLifecycleStages(): LifecycleStage[] {
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  useEffect(() => {
    fetchLifecycleStages()
      .then(setStages)
      .catch(() => {});
  }, []);
  return stages;
}

export function LifecycleSelect({
  value,
  stages,
  onChange,
  disabled,
  className,
}: {
  value: string | null;
  stages: LifecycleStage[];
  onChange: (next: string | null) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useT();
  const known = stages.some((stage) => stage.name === value);
  const orphaned = Boolean(value) && !known && stages.length > 0;

  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className={cn('select-field-sm w-full', className)}
      aria-label={t('مرحلة العميل')}
    >
      <option value="">{t('غير محدد')}</option>
      {stages.map((stage) => (
        <option key={stage.id} value={stage.name}>
          {stage.name}
        </option>
      ))}
      {orphaned && (
        // Kept selectable so opening the dropdown does not silently reassign the
        // contact, and labelled so the discrepancy is visible rather than
        // looking like an ordinary stage.
        <option value={value as string}>{`${value} — ${t('مرحلة محذوفة')}`}</option>
      )}
    </select>
  );
}

/** The read-only chip used in the thread header, where space is tight. */
export function LifecycleChip({
  value,
  stages,
}: {
  value: string | null;
  stages: LifecycleStage[];
}) {
  const { t } = useT();
  if (!value) return null;

  const stage = stages.find((s) => s.name === value);
  const color = stage?.color || 'hsl(var(--muted-foreground))';

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0 text-micro font-medium"
      style={{
        // color-mix, never an alpha suffix: the fallback here is a token, and
        // `hsl(var(--muted-foreground))20` is invalid CSS that fails silently.
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
        color,
      }}
      title={stage ? value : `${value} — ${t('مرحلة محذوفة')}`}
    >
      {value}
      {!stage && stages.length > 0 && <span aria-hidden>·</span>}
    </span>
  );
}
