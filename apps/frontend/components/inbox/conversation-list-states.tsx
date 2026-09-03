'use client';

import Link from 'next/link';
import { Inbox, SearchX, WifiOff } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { useT } from '@/lib/i18n';

/**
 * What the conversation list shows when it is not showing conversations.
 *
 * There was one message for every case: "no conversations". That is the same
 * sentence whether the organization has never been connected to WhatsApp, whether
 * it is connected and simply quiet, or whether the agent has a filter applied
 * that happens to match nothing. Three very different situations, three
 * different next actions, and the UI told them apart from none of it.
 */

/**
 * Loading placeholder shaped like the rows it replaces.
 *
 * A centred spinner tells the user to wait; a skeleton tells them what is
 * coming, and the list does not jump when it arrives because the placeholder
 * already occupied the right height.
 */
export function ConversationListSkeleton({ rows = 7 }: { rows?: number }) {
  const { t } = useT();

  return (
    <div
      className="space-y-px"
      role="status"
      aria-busy="true"
      aria-label={t('جاري التحميل...')}
    >
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="flex items-start gap-2.5 border-b border-border/40 px-3 py-3"
          // Staggered so the block reads as loading rather than as a frozen
          // pattern, and slow enough not to strobe.
          style={{ animationDelay: `${index * 90}ms` }}
        >
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
          <div className="min-w-0 flex-1 space-y-1.5 py-0.5">
            <div className="flex items-center justify-between gap-2">
              <div className="h-2.5 w-24 animate-pulse rounded bg-muted" />
              <div className="h-2 w-8 animate-pulse rounded bg-muted/70" />
            </div>
            <div className="h-2 w-16 animate-pulse rounded bg-muted/70" />
            <div className="h-2 w-full animate-pulse rounded bg-muted/50" />
          </div>
        </div>
      ))}
    </div>
  );
}

export type EmptyReason =
  | { kind: 'no-channel' }
  | { kind: 'no-conversations' }
  | { kind: 'no-match'; onClear: () => void };

/**
 * Work out *why* the list is empty, in order of how fundamental the cause is.
 *
 * Order matters, and it took two wrong orders to find the right one:
 *
 * - The filter is checked first, because it is the only cause the agent
 *   created themselves. Server-side search *replaces* the loaded list, so a
 *   search matching nothing empties it entirely; ranking any other cause above
 *   the filter told an agent staring at their own search term that their
 *   organization had no conversations, or no channel. Clearing the filter then
 *   reveals whatever the real state underneath is.
 * - A missing channel is only asked about once no filter is involved. A
 *   organization with existing conversations plainly has a working number, and a
 *   gateway that is down right now is already reported by the composer strip
 *   and the header chip — not by the conversation list.
 */
export function emptyReason({
  hasChannel,
  isFiltered,
  onClear,
}: {
  hasChannel: boolean;
  isFiltered: boolean;
  onClear: () => void;
}): EmptyReason {
  if (isFiltered) return { kind: 'no-match', onClear };
  if (!hasChannel) return { kind: 'no-channel' };
  return { kind: 'no-conversations' };
}

export function ConversationListEmpty({ reason }: { reason: EmptyReason }) {
  const { t } = useT();

  if (reason.kind === 'no-channel') {
    return (
      <EmptyState
        compact
        icon={WifiOff}
        title={t('لا توجد قناة متصلة')}
        hint={t('اربط رقم واتساب لتبدأ المحادثات بالوصول')}
        action={
          <Link
            href="/settings/general#channels"
            className="text-caption font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('ربط رقم')}
          </Link>
        }
      />
    );
  }

  if (reason.kind === 'no-match') {
    return (
      <EmptyState
        compact
        icon={SearchX}
        title={t('لا توجد نتائج مطابقة')}
        hint={t('جرّب توسيع التصفية أو البحث')}
        action={
          <button
            type="button"
            onClick={reason.onClear}
            className="text-caption font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('مسح التصفية')}
          </button>
        }
      />
    );
  }

  return (
    <EmptyState
      compact
      icon={Inbox}
      title={t('لا توجد محادثات بعد')}
      hint={t('ستظهر المحادثات هنا فور وصول أول رسالة')}
    />
  );
}

