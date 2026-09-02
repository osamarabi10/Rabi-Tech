'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShieldOff, Undo2 } from 'lucide-react';
import { fetchBlockedContacts, unblockContact, type BlockedContact } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/ui/operational-state';

/**
 * The Blocked inbox.
 *
 * Blocking already worked and there was nowhere to see the result. A moderation
 * control whose outcome is invisible is one an operator cannot audit, cannot
 * undo, and stops trusting — and this one is reachable by a stranger, since the
 * thing being blocked is usually a number that will not stop writing.
 *
 * **Contacts, not conversations.** The existing `blocked` scope filtered the
 * conversation list by `contact.blockedAt`, so it could only ever show someone
 * who already had a thread. A number blocked before it ever wrote — the
 * ordinary case — appeared nowhere. This reads the contact table instead, so a
 * blocked number is listed whether or not there is history behind it, and the
 * row says which.
 *
 * Unblock is on the row because that is where the question is asked. Sending
 * somebody to Contacts, finding the same person again and unblocking there is
 * three steps to undo a one-step action.
 */
export function BlockedContactsList() {
  const { t } = useT();
  const [rows, setRows] = useState<BlockedContact[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setRows(await fetchBlockedContacts());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const unblock = async (id: string) => {
    setBusy(id);
    try {
      await unblockContact(id);
      // Removed locally rather than refetched: the row is gone by definition,
      // and a refetch would blank the list for a moment on a surface where the
      // operator is usually working through several in a row.
      setRows((current) => (current ?? []).filter((row) => row.id !== id));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  if (failed) {
    return <ErrorState compact title={t('تعذر تحميل المحظورين')} retryLabel={t('إعادة المحاولة')} onRetry={load} />;
  }
  if (rows === null) {
    return (
      <div className="space-y-2 p-3" aria-label={t('جاري التحميل...')}>
        {Array.from({ length: 4 }).map((_, index) => <SkeletonBlock key={index} className="h-14" />)}
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState compact icon={ShieldOff} title={t('لا يوجد محظورون')} />;
  }

  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.id} className="flex items-start gap-2 px-3 py-2.5">
          <ShieldOff className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate text-caption font-semibold text-fg">
              {row.name || t('بدون اسم')}
            </p>
            {/* A phone number is Latin digits inside RTL text; without isolation
                the surrounding words reorder around it. */}
            <bdi className="block truncate text-micro text-muted-foreground" dir="ltr">{row.phone}</bdi>
            <p className="mt-0.5 text-micro text-muted-foreground">
              {row.blockedReason || t('بدون سبب مسجّل')}
              {row.blockedByName ? ` — ${row.blockedByName}` : ''}
            </p>
            {/*
              Said explicitly, because it changes what unblocking means: there is
              no thread behind this number, so unblocking restores nothing — it
              only lets them write again.
            */}
            {row.conversationCount === 0 && (
              <p className="mt-0.5 text-micro text-muted-foreground/80">
                {t('حُظر قبل أن يراسل')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => unblock(row.id)}
            disabled={busy === row.id}
            className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-micro font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <Undo2 className="size-3.5 rtl:-scale-x-100" aria-hidden />
            {busy === row.id ? t('جارٍ الرفع…') : t('رفع الحظر')}
          </button>
        </li>
      ))}
    </ul>
  );
}
