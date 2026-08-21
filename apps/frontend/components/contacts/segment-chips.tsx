'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { deleteSegment, fetchSegmentCount, renameSegment, type Segment } from '@/lib/data';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Saved segments as clickable chips.
 *
 * Counts are fetched **lazily, one chip at a time**, not eagerly for all of
 * them. Each count is a `COUNT(*)` over Contact, and these filters can traverse
 * relations (`hasEverReplied`, broadcast history), so counting ten segments on
 * every page load would make the contacts page pay for segments nobody clicked.
 * A chip is useful without a number; it is not useful if the page is slow.
 */
export function SegmentChips({
  segments,
  activeId,
  onSelect,
  onChanged,
}: {
  segments: Segment[];
  activeId: string | null;
  onSelect: (segment: Segment | null) => void;
  onChanged: () => void;
}) {
  const { t } = useT();
  const [counts, setCounts] = useState<Record<string, number | 'error'>>({});
  const requested = useRef<Set<string>>(new Set());

  const loadCount = useCallback(async (id: string) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    try {
      const count = await fetchSegmentCount(id);
      setCounts((prev) => ({ ...prev, [id]: count }));
    } catch {
      // A filter can outlive the campaign it references. Mark it rather than
      // showing a zero, which would read as "empty" instead of "broken".
      setCounts((prev) => ({ ...prev, [id]: 'error' }));
    }
  }, []);

  useEffect(() => {
    // Reset when the list itself changes, so a renamed or deleted segment does
    // not keep a stale number.
    requested.current = new Set();
    setCounts({});
  }, [segments.map((segment) => segment.id).join(',')]);

  const rename = async (segment: Segment) => {
    const next = window.prompt(t('اسم الشريحة'), segment.name);
    if (!next || next.trim() === segment.name) return;
    try {
      await renameSegment(segment.id, next.trim());
      toast.success(t('تم تحديث الشريحة'));
      onChanged();
    } catch (err) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('تعذّر تحديث الشريحة'));
    }
  };

  const remove = async (segment: Segment) => {
    try {
      await deleteSegment(segment.id);
      toast.success(t('تم حذف الشريحة'));
      if (activeId === segment.id) onSelect(null);
      onChanged();
    } catch {
      toast.error(t('تعذّر حذف الشريحة'));
    }
  };

  if (!segments.length) return <div />;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      {segments.map((segment) => {
        const active = segment.id === activeId;
        const count = counts[segment.id];
        return (
          <span
            key={segment.id}
            className={cn(
              'flex items-center gap-1 rounded-full border ps-2.5 pe-1 py-0.5 text-[11px] transition-colors',
              active
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground',
            )}
          >
            <button
              type="button"
              // Clicking the active chip clears it. Without that there is no way
              // back to "all contacts" except deleting every rule by hand.
              onClick={() => onSelect(active ? null : segment)}
              onMouseEnter={() => loadCount(segment.id)}
              onFocus={() => loadCount(segment.id)}
              className="max-w-[180px] truncate"
            >
              {segment.name}
              {count === 'error' ? (
                <span className="ms-1 text-warning">!</span>
              ) : count !== undefined ? (
                // Its own background, not just a margin: a segment named "Phone has 9"
                // followed by a count of 0 reads as "Phone has 90" when the only
                // separation is whitespace.
                <span className="numeric ms-1.5 rounded-full bg-foreground/10 px-1.5 font-mono text-[10px]">
                  {count}
                </span>
              ) : null}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="rounded p-0.5 opacity-60 hover:opacity-100" title={t('خيارات')}>
                  <MoreHorizontal className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => rename(segment)}>
                  <Pencil /> {t('إعادة تسمية')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => remove(segment)}>
                  <Trash2 /> {t('حذف')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        );
      })}
    </div>
  );
}
