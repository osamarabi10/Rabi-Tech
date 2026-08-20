'use client';

import { Search, MessageSquarePlus } from 'lucide-react';
import type { Conv } from '@/lib/data';
import { avatarColor, STATUS_CONFIG } from '@/lib/constants';
import { useT } from '@/lib/i18n';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { StatusBadge } from '@/components/status-badge';
import { cn } from '@/lib/utils';

/**
 * Pane 1 of the three-pane inbox: the queue.
 *
 * Respond.io's tabs are Mine / Unassigned / All, in that order — an agent's own
 * work first, then what nobody has claimed, then everything. Ours previously led
 * with status filters, which is a supervisor's view, not an agent's.
 */
export type QueueTab = 'mine' | 'unassigned' | 'all' | 'open' | 'pending' | 'awaiting' | 'resolved';

const TABS: Array<{ key: QueueTab; label: string }> = [
  { key: 'mine',       label: 'لي' },
  { key: 'unassigned', label: 'غير مسندة' },
  { key: 'all',        label: 'الكل' },
];

const STATUS_TABS: Array<{ key: QueueTab; label: string }> = [
  { key: 'open',      label: 'مفتوح' },
  { key: 'pending',   label: 'معلق' },
  { key: 'awaiting',  label: 'انتظار العميل' },
  { key: 'resolved',  label: 'محلول' },
];

export interface ConversationListProps {
  conversations: Conv[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  tab: QueueTab;
  onTabChange: (tab: QueueTab) => void;
  search: string;
  onSearchChange: (value: string) => void;
  onNewChat?: () => void;
  unreadTotal?: number;
}

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  tab,
  onTabChange,
  search,
  onSearchChange,
  onNewChat,
  unreadTotal = 0,
}: ConversationListProps) {
  const { t } = useT();

  return (
    <div className="flex w-[300px] shrink-0 flex-col border-e border-border bg-[hsl(var(--surface-1))]">
      {/* Header */}
      <div className="border-b border-border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold">
            {t('المحادثات')}
            {unreadTotal > 0 && (
              <span className="ms-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] text-primary-foreground">
                {unreadTotal}
              </span>
            )}
          </h2>
          {onNewChat && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onNewChat} title={t('محادثة جديدة')}>
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Primary tabs — an agent's own queue first */}
        <div className="inline-flex w-full rounded-md border border-border bg-secondary/40 p-0.5">
          {TABS.map((tb) => (
            <button
              key={tb.key}
              onClick={() => onTabChange(tb.key)}
              className={cn(
                'flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                tab === tb.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(tb.label)}
            </button>
          ))}
        </div>

        {/* Status filters, secondary */}
        <div className="flex gap-1 overflow-x-auto pb-0.5 [&::-webkit-scrollbar]:hidden">
          {STATUS_TABS.map((tb) => (
            <button
              key={tb.key}
              onClick={() => onTabChange(tab === tb.key ? 'all' : tb.key)}
              className={cn(
                'shrink-0 rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                tab === tb.key
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(tb.label)}
            </button>
          ))}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute inset-inline-start-0 top-1/2 ms-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 ps-8 text-xs"
            placeholder={t('بحث بالاسم أو الرقم...')}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
      </div>

      {/* Queue */}
      <ScrollArea className="flex-1">
        {conversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <MessageSquarePlus className="h-8 w-8 text-muted-foreground/30" />
            <p className="text-xs text-muted-foreground">{t('لا توجد محادثات')}</p>
          </div>
        )}

        {conversations.map((c) => {
          const active = selectedId === c.id;
          const status = STATUS_CONFIG[c.status] || STATUS_CONFIG.OPEN;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onSelect(c.id)}
              className={cn(
                'flex w-full items-start gap-2.5 border-b border-border/40 px-3 py-3 text-start transition-colors',
                active ? 'bg-primary/10' : 'hover:bg-accent/40',
              )}
            >
              <Avatar className="h-9 w-9 shrink-0">
                <AvatarFallback
                  className="text-xs font-bold"
                  style={{
                    backgroundColor: `${avatarColor(c.phone)}22`,
                    color: avatarColor(c.phone),
                  }}
                >
                  {c.avatar}
                </AvatarFallback>
              </Avatar>

              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13px] font-semibold">{c.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{c.lastTime}</span>
                </div>

                <div className="mb-0.5 flex items-center gap-1.5">
                  <StatusBadge label={status.label} color={status.color} className="px-1.5 py-0 text-[9px]" />
                  {c.assigneeName ? (
                    <span className="truncate text-[10px] text-muted-foreground">{c.assigneeName}</span>
                  ) : (
                    <span className="text-[10px] text-warning/80">{t('غير مسندة')}</span>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-[11px] text-muted-foreground">{c.lastMsg}</p>
                  {c.unread > 0 && (
                    <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
                      {c.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </ScrollArea>
    </div>
  );
}
