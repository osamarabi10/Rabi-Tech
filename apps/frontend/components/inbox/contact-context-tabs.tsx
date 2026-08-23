'use client';

import { useEffect, useState } from 'react';
import { FileText, Image as ImageIcon, Loader2, Mic, Paperclip, Video } from 'lucide-react';
import {
  fetchConversationActivity,
  type ActivityEvent,
  type Msg,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * The tab strip for the contact pane, and the two tabs that are not "Details".
 *
 * Respond.io puts Details / Files / Activity here so an agent never leaves the
 * conversation to answer "who is this", "what did they send", "what happened".
 * The third question had no data source at all until this phase — `AuditLog`
 * rows were written and never read.
 *
 * Calls, which their product also tabs here, are absent on purpose: a WhatsApp
 * Web gateway has none, and a tab that opens onto a permanent empty state is
 * worse than one that was never offered.
 */

export type ContactTab = 'details' | 'conversations' | 'files' | 'activity';

export function ContactTabStrip({
  active,
  onChange,
  fileCount,
  conversationCount,
}: {
  active: ContactTab;
  onChange: (next: ContactTab) => void;
  fileCount: number;
  /** How many threads this contact has. Undefined until counted. */
  conversationCount?: number;
}) {
  const { t } = useT();

  const tabs: { key: ContactTab; label: string; badge?: number }[] = [
    { key: 'details', label: t('التفاصيل') },
    { key: 'conversations', label: t('المحادثات'), badge: conversationCount },
    { key: 'files', label: t('الملفات'), badge: fileCount },
    { key: 'activity', label: t('النشاط') },
  ];

  return (
    <div className="flex shrink-0 border-b border-border" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            'flex flex-1 items-center justify-center gap-1 border-b-2 px-2 py-2 text-caption font-medium transition-colors motion-micro',
            active === tab.key
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
          {/* Only shown when there is something to count — a grey zero next to
              every tab label is noise, not information. */}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="numeric text-micro tabular-nums opacity-70">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Attachments already in the thread, newest first. */
export function FilesTab({ messages }: { messages: Msg[] }) {
  const { t } = useT();
  const files = messages.filter((m) => m.mediaUrl).reverse();

  if (files.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-caption text-muted-foreground">
        {t('لا توجد ملفات في هذه المحادثة')}
      </p>
    );
  }

  const iconFor = (type: string | null | undefined) => {
    if (!type) return <Paperclip className="h-4 w-4" />;
    if (type.startsWith('image')) return <ImageIcon className="h-4 w-4" />;
    if (type.startsWith('video')) return <Video className="h-4 w-4" />;
    if (type.startsWith('audio')) return <Mic className="h-4 w-4" />;
    return <FileText className="h-4 w-4" />;
  };

  return (
    <ul className="divide-y divide-border">
      {files.map((file) => (
        <li key={file.id}>
          <a
            href={file.mediaUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-accent/40"
          >
            <span className="shrink-0 text-muted-foreground">{iconFor(file.mediaType)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-caption font-medium">
                {file.body?.trim() || file.mediaType || t('مرفق')}
              </span>
              <span className="numeric block text-micro text-muted-foreground" dir="ltr">
                {file.time}
              </span>
            </span>
            {/* Direction, because "did we send this or did they" is the first
                thing anyone asks of a file in a support thread. */}
            <span className="shrink-0 text-micro text-muted-foreground">
              {file.dir === 'in' ? t('وارد') : t('صادر')}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Human-readable labels for the audit actions the backend emits. */
const ACTION_LABEL: Record<string, string> = {
  created: 'بدأت المحادثة',
  opened: 'فُتحت',
  assigned: 'تم الإسناد',
  resolved: 'تم الإغلاق',
  reopened: 'أُعيد فتحها',
  pending: 'وضعها معلّق',
  updated: 'تم التحديث',
  welcome: 'رسالة ترحيب آلية',
  out_of_hours: 'رد خارج الدوام',
  resolved_reply: 'رسالة إغلاق آلية',
  csat: 'استطلاع الرضا',
  auto_reply: 'رد آلي',
};

export function ActivityTab({ conversationId }: { conversationId: string }) {
  const { t } = useT();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setFailed(false);

    fetchConversationActivity(conversationId)
      .then((next) => {
        if (!cancelled) setEvents(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  if (failed) {
    return (
      <p className="px-4 py-8 text-center text-caption text-destructive">
        {t('تعذّر جلب النشاط')}
      </p>
    );
  }

  if (events === null) {
    return (
      <p className="flex items-center justify-center gap-2 px-4 py-8 text-caption text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('جاري التحميل...')}
      </p>
    );
  }

  if (events.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-caption text-muted-foreground">
        {t('لا يوجد نشاط مسجّل')}
      </p>
    );
  }

  return (
    <ol className="space-y-0 px-4 py-3">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3 pb-3 last:pb-0">
          {/* A rail down the left of the timeline, stopping at the last item so
              the line does not dangle past the final event. */}
          {index < events.length - 1 && (
            <span
              className="absolute top-4 h-full w-px bg-border"
              style={{ insetInlineStart: '3px' }}
              aria-hidden
            />
          )}
          <span
            className={cn(
              'relative mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full',
              // Automated events are hollow. Colour alone would not carry the
              // distinction for anyone who cannot see it, so the shape does.
              event.kind === 'automated'
                ? 'border border-muted-foreground bg-background'
                : 'bg-primary',
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="block text-caption">
              {t(ACTION_LABEL[event.action] ?? event.action)}
              {event.actorName && (
                <span className="text-muted-foreground"> · {event.actorName}</span>
              )}
              {!event.actorName && event.kind === 'automated' && (
                <span className="text-muted-foreground"> · {t('آلي')}</span>
              )}
            </span>
            {event.detail && (
              <span className="mt-0.5 block truncate text-micro text-muted-foreground">
                {event.detail}
              </span>
            )}
            <span className="numeric mt-0.5 block text-micro text-muted-foreground" dir="ltr">
              {new Date(event.at).toLocaleString(undefined, {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
