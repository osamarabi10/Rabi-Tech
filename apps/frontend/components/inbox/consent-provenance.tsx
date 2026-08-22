'use client';

import { History } from 'lucide-react';
import { type ConsentProvenance } from '@/lib/data';
import { useT } from '@/lib/i18n';

/**
 * Where a contact's marketing consent came from.
 *
 * The Details tab had a consent dropdown and nothing beside it. "This customer
 * opted out" is a claim a subscriber may one day have to stand behind in front
 * of someone who is not their customer, and standing behind it means being able
 * to say how it was recorded and by whom.
 *
 * Until now nothing could: `Contact` kept the current value, its source and its
 * date, and each change overwrote the last. The actor was never stored at all.
 * `ConsentEvent` records the history; this renders the most recent entry of it.
 *
 * Three states, and the difference between them matters:
 *
 * - a recorded change, with source, date and actor;
 * - a value set before the history table existed — source and date, no actor,
 *   said plainly rather than dressed up as complete;
 * - never recorded at all, which is different again from either.
 */

const SOURCE_LABEL: Record<string, string> = {
  keyword: 'من رسالة العميل',
  agent: 'من الموظف',
  import: 'من استيراد ملف',
  api: 'عبر الـAPI',
};

function day(iso: string): string {
  return iso.slice(0, 10);
}

export function ConsentProvenanceLine({
  provenance,
}: {
  provenance: ConsentProvenance | null;
}) {
  const { t } = useT();

  // Still loading, or the request failed. Rendering "never recorded" here would
  // be a claim about the data made from the absence of an answer.
  if (!provenance) return null;

  const latest = provenance.history[0];

  if (!latest && !provenance.source) {
    return (
      <p className="mt-1 text-micro text-muted-foreground">
        {t('ما تسجّل مصدر للموافقة')}
      </p>
    );
  }

  const source = latest?.source ?? provenance.source ?? '';
  const at = latest?.at ?? provenance.updatedAt;
  const actor = latest?.actorName;

  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-micro text-muted-foreground">
      <History className="h-3 w-3 shrink-0" aria-hidden />
      <span>{t(SOURCE_LABEL[source] ?? source)}</span>
      {actor && <span className="text-foreground">{actor}</span>}
      {at && (
        <span className="numeric font-mono tabular-nums" dir="ltr">
          {day(at)}
        </span>
      )}
      {/* Only for rows the history table never saw. Saying nothing here would
          let a pre-existing value pass as a recorded one. */}
      {!latest && <span className="opacity-70">· {t('قبل تسجيل السجل')}</span>}
    </p>
  );
}
