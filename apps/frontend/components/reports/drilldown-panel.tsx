'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, X } from 'lucide-react';
import {
  fetchDrilldown,
  type DrilldownMetric,
  type DrilldownResult,
  type ReportRange,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';

/**
 * The conversations behind a number.
 *
 * "A manager who cannot click a number to see what it is made of will not
 * believe it" — so every headline tile opens this, and every row links into the
 * inbox thread it describes. The panel exists to make an aggregate falsifiable,
 * which means it must show the *total* alongside what it returned: a list
 * capped at 50 under a tile reading 4,000 is only trustworthy if it says so.
 */

const METRIC_LABEL: Record<DrilldownMetric, string> = {
  started: 'محادثات بدأت',
  resolved: 'محادثات حُلّت',
  answered: 'محادثات تم الرد عليها',
  unanswered: 'محادثات بلا رد',
  open: 'محادثات ما زالت مفتوحة',
};

export function DrilldownPanel({
  range,
  metric,
  agentId,
  onClose,
}: {
  range: ReportRange;
  metric: DrilldownMetric;
  agentId?: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [result, setResult] = useState<DrilldownResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(false);
    fetchDrilldown(range, metric, agentId ? { agentId } : undefined)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [range, metric, agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-s border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t(METRIC_LABEL[metric])}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{t(METRIC_LABEL[metric])}</h2>
            {result && (
              <p className="mt-0.5 text-caption text-muted-foreground">
                {result.returned < result.total
                  ? `${t('عرض')} ${result.returned} ${t('من')} ${result.total}`
                  : `${result.total} ${t('نتيجة')}`}
              </p>
            )}
          </div>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="p-6 text-center text-xs text-destructive">{t('تعذّر جلب التفاصيل')}</p>
          ) : !result ? (
            <p className="p-6 text-center text-xs text-muted-foreground">{t('جاري التحميل...')}</p>
          ) : result.conversations.length === 0 ? (
            <p className="p-6 text-center text-xs text-muted-foreground">
              {t('لا توجد بيانات في هذه الفترة')}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {result.conversations.map((conv) => (
                <li key={conv.id}>
                  <Link
                    href={`/inbox?conversation=${conv.id}`}
                    className="flex items-center justify-between gap-2 px-4 py-2.5 text-xs transition-colors hover:bg-accent/40"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {conv.contact?.name || conv.contact?.phone || t('غير معروف')}
                      </span>
                      <span className="mt-0.5 block text-caption text-muted-foreground">
                        <span className="numeric" dir="ltr">
                          #{conv.displayId}
                        </span>
                        {conv.assignee && <> · {conv.assignee.name}</>}
                      </span>
                    </span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
