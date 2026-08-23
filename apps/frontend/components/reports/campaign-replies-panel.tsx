'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, MessageSquare, X } from 'lucide-react';
import { fetchCampaignReplies, type CampaignReplies } from '@/lib/data';
import { useT } from '@/lib/i18n';

/**
 * What a broadcast actually came back as.
 *
 * The campaign table has always shown a reply count and a percentage and
 * stopped there. "Three of your five VIPs answered" is the less useful half of
 * that sentence — the reason anyone broadcasts is to hear what people say back,
 * and until now those threads were reachable only by remembering names and
 * searching the inbox one at a time.
 *
 * Each row leads to the conversation, because reading the answer is the point
 * and replying to it is what happens next.
 */
export function CampaignRepliesPanel({
  campaignId,
  onClose,
}: {
  campaignId: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [data, setData] = useState<CampaignReplies | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetchCampaignReplies(campaignId)
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-md flex-col border-s border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t('ردود الحملة')}
      >
        <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border p-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{t('ردود الحملة')}</p>
            {data && (
              <p className="truncate text-caption text-muted-foreground">{data.campaign.title}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={t('إغلاق')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {!data && !failed && (
            <div className="flex items-center gap-2 p-4 text-caption text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('جارٍ التحميل...')}
            </div>
          )}

          {failed && (
            <p className="p-4 text-caption text-destructive">{t('تعذّر جلب الردود')}</p>
          )}

          {/* Never sent is not the same as sent-and-ignored, and the difference
              is the whole story for whoever is looking. */}
          {data && !data.sent && (
            <p className="p-4 text-caption text-muted-foreground">
              {t('هالحملة لسا ما انبعتت')}
            </p>
          )}

          {data && data.sent && data.replies.length === 0 && (
            <p className="p-4 text-caption text-muted-foreground">
              {t('ما في حدا رد على هالحملة لهلق')}
            </p>
          )}

          {data && data.replies.length > 0 && (
            <ul className="divide-y divide-border">
              {data.replies.map((reply) => (
                <li key={reply.contactId}>
                  <Link
                    href={`/inbox?conversation=${reply.conversationId}`}
                    className="block px-4 py-3 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center gap-2">
                      <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-caption font-medium">
                        {reply.name || reply.phone}
                      </span>
                      <span className="numeric shrink-0 font-mono text-micro tabular-nums text-muted-foreground" dir="ltr">
                        #{reply.displayId}
                      </span>
                    </div>

                    {/* Their first line since the send. Usually the requirement
                        — the reason they answered at all. */}
                    {reply.body && (
                      <p className="mt-1 line-clamp-2 ps-5 text-caption text-muted-foreground">
                        {reply.body}
                      </p>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-x-2 ps-5 text-micro text-muted-foreground">
                      {reply.at && (
                        <span className="numeric font-mono tabular-nums" dir="ltr">
                          {reply.at.slice(0, 10)}
                        </span>
                      )}
                      {reply.assigneeName && <span>· {reply.assigneeName}</span>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {data && data.sent && data.total > data.returned && (
          <footer className="shrink-0 border-t border-border px-4 py-2 text-micro text-muted-foreground">
            {/* Said out loud rather than truncating in silence. */}
            {t('عرض')} {data.returned} {t('من')} {data.total}
          </footer>
        )}
      </aside>
    </div>
  );
}
