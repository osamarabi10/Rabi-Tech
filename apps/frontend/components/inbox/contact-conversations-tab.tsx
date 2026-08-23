'use client';

import { useEffect, useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { STATUS_CONFIG } from '@/lib/constants';
import { fetchContactConversations, type ContactConversation } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Every thread this contact has had.
 *
 * The panel could show the conversation you were standing in and nothing about
 * the four before it. On a support desk that history is most of the context:
 * whether this is a first complaint or the fourth about the same line, and how
 * the previous ones ended.
 *
 * Resolved threads are the point, not an afterthought — they hold the answers,
 * and the inbox's default filter hides them, which is precisely why they were
 * unreachable from anywhere else.
 */

/*
 * Status label and colour come from STATUS_CONFIG, the same source the rest
 * of the product reads.
 *
 * The first draft of this file invented `text-status-open` and friends, which
 * are not classes Tailwind generates — the status colours live as CSS custom
 * properties and are applied as inline colour. It would have rendered every
 * status in the inherited grey and looked deliberate.
 */

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

export function ContactConversationsTab({
  contactId,
  currentConversationId,
  onOpen,
  onCount,
}: {
  contactId: string;
  /** The thread already on screen, marked rather than hidden. */
  currentConversationId: string | null;
  onOpen: (conversationId: string) => void;
  /** Reports the count back so the tab strip can badge it. */
  onCount?: (count: number) => void;
}) {
  const { t } = useT();
  const [conversations, setConversations] = useState<ContactConversation[] | null>(null);

  useEffect(() => {
    if (!contactId) return;
    let cancelled = false;
    setConversations(null);
    fetchContactConversations(contactId)
      .then((next) => {
        if (cancelled) return;
        setConversations(next);
        onCount?.(next.length);
      })
      .catch(() => {
        if (!cancelled) setConversations([]);
      });
    return () => {
      cancelled = true;
    };
    // onCount is a callback the parent recreates each render; depending on it
    // would refetch this list on every keystroke elsewhere in the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  if (conversations === null) {
    return (
      <div className="flex items-center gap-2 p-3 text-micro text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('جارٍ التحميل...')}
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <p className="p-3 text-micro text-muted-foreground">
        {t('ما في محادثات ثانية لهالجهة')}
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {conversations.map((conversation) => {
        const isCurrent = conversation.id === currentConversationId;

        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onOpen(conversation.id)}
              disabled={isCurrent}
              className={cn(
                'flex w-full flex-col gap-0.5 px-3 py-2 text-start transition-colors',
                isCurrent ? 'bg-primary/5' : 'hover:bg-accent',
              )}
            >
              <div className="flex items-center gap-2">
                <MessageSquare className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="numeric font-mono text-caption tabular-nums" dir="ltr">
                  #{conversation.displayId}
                </span>
                <span
                  className="text-micro font-medium"
                  style={{ color: STATUS_CONFIG[conversation.status]?.color }}
                >
                  {t(STATUS_CONFIG[conversation.status]?.label ?? conversation.status)}
                </span>
                {isCurrent && (
                  <span className="ms-auto shrink-0 text-micro text-primary">
                    {t('المعروضة الآن')}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-2 ps-5 text-micro text-muted-foreground">
                <span className="numeric font-mono tabular-nums" dir="ltr">
                  {day(conversation.lastMessageAt ?? conversation.createdAt)}
                </span>
                <span>
                  {conversation._count.messages} {t('رسائل')}
                </span>
                {conversation.team && <span>· {conversation.team.name}</span>}
                {conversation.assignee && <span>· {conversation.assignee.name}</span>}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
