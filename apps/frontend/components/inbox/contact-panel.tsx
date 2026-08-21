'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { ExternalLink, Tag, User, X } from 'lucide-react';
import { updateContact, type Agent, type Conv, type MarketingConsent } from '@/lib/data';
import { avatarColor } from '@/lib/constants';
import { useT } from '@/lib/i18n';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Pane 3 of the three-pane inbox: contact context.
 *
 * The point of this pane in Respond.io is that an agent never has to leave the
 * conversation to know who they are talking to or to act on it. Ours previously
 * showed a read-only card and a link that pointed back at /inbox — a no-op.
 */
export interface ContactPanelProps {
  conversation: Conv;
  agents: Agent[];
  onAssign: (agentId: string | null) => void | Promise<void>;
  assigning?: boolean;
  onClose: () => void;
  currentUserId?: string;
  /** Lets the parent keep its Conv copy in step after a consent change. */
  onConsentChange?: (consent: MarketingConsent) => void;
}

export function ContactPanel({
  conversation,
  agents,
  onAssign,
  assigning,
  onClose,
  currentUserId,
  onConsentChange,
}: ContactPanelProps) {
  const { t } = useT();
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  const saveConsent = async (consent: MarketingConsent) => {
    setSavingConsent(true);
    try {
      await updateContact(conversation.contactId, { marketingConsent: consent });
      toast.success(t('تم تحديث حالة التسويق'));
      onConsentChange?.(consent);
    } catch {
      toast.error(t('فشل التحديث'));
    } finally {
      setSavingConsent(false);
    }
  };

  const color = avatarColor(conversation.phone);
  const visibleAgents = showAllAgents ? agents : agents.slice(0, 5);

  return (
    // Third pane only earns its space on a wide screen; below xl the thread needs it.
    <aside className="hidden w-[280px] shrink-0 flex-col overflow-y-auto border-s border-border bg-[hsl(var(--surface-1))] xl:flex">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t('معلومات جهة الاتصال')}
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          title={t('إخفاء')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Identity */}
      <div className="border-b border-border p-4">
        <div className="mb-3 flex items-center gap-3">
          <Avatar className="h-11 w-11">
            <AvatarFallback
              className="text-base font-bold"
              style={{ backgroundColor: color, color: '#fff' }}
            >
              {conversation.avatar}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold">{conversation.name}</p>
            <p className="numeric font-mono text-[11px] text-muted-foreground" dir="ltr">
              {conversation.phone}
            </p>
          </div>
        </div>

        <dl className="space-y-1.5 text-[12px]">
          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('الفريق')}</dt>
            <dd className="truncate font-medium">{conversation.teamName || t('عام')}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('المحادثة')}</dt>
            <dd className="font-mono text-muted-foreground">#{conversation.displayId}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('أول تواصل')}</dt>
            <dd className="font-mono text-muted-foreground">{conversation.sessionDate}</dd>
          </div>
          {/*
            Consent is shown to every agent, not just admins: whoever is in the
            conversation is the person who will be told "stop sending me these",
            and they need to be able to honour it immediately.
          */}
          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('التسويق')}</dt>
            <dd className="min-w-0 flex-1">
              <select
                value={conversation.marketingConsent}
                disabled={savingConsent}
                onChange={(e) => saveConsent(e.target.value as MarketingConsent)}
                className={cn(
                  'w-full rounded border border-border bg-card px-1.5 py-0.5 text-[11px]',
                  'disabled:opacity-50',
                  conversation.marketingConsent === 'OPTED_OUT' && 'border-warning/40 text-warning',
                )}
              >
                <option value="UNKNOWN">{t('غير محدد')}</option>
                <option value="OPTED_IN">{t('موافق')}</option>
                <option value="OPTED_OUT">{t('ملغى الاشتراك')}</option>
              </select>
            </dd>
          </div>
        </dl>

        {conversation.marketingConsent === 'OPTED_OUT' && (
          <p className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[10px] text-warning">
            {t('مستبعد من كل الحملات')}
          </p>
        )}

        {conversation.contactTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {conversation.contactTags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                <Tag className="h-2.5 w-2.5" />
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Assignment */}
      <div className="border-b border-border p-4">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('المسؤول')}
        </p>

        <div className="space-y-1">
          <button
            type="button"
            disabled={assigning}
            onClick={() => onAssign(null)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs transition-colors',
              !conversation.assigneeId
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            <User className="h-3.5 w-3.5 shrink-0 opacity-60" />
            {t('غير مسندة')}
          </button>

          {visibleAgents.map((agent) => {
            const active = conversation.assigneeId === agent.id;
            return (
              <button
                key={agent.id}
                type="button"
                disabled={assigning}
                onClick={() => onAssign(agent.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs transition-colors',
                  active ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    agent.avail ? 'bg-success-vivid' : 'bg-muted-foreground/40',
                  )}
                />
                <span className="truncate">{agent.name}</span>
                {agent.id === currentUserId && (
                  <span className="ms-auto shrink-0 text-[10px] opacity-60">{t('أنا')}</span>
                )}
              </button>
            );
          })}

          {agents.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAllAgents((v) => !v)}
              className="w-full rounded-md px-2 py-1 text-start text-[11px] text-muted-foreground hover:text-foreground"
            >
              {showAllAgents ? t('عرض أقل') : `${t('عرض الكل')} (${agents.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Notes */}
      {conversation.contactNotes && (
        <div className="border-b border-border p-4">
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t('ملاحظات')}
          </p>
          <p className="whitespace-pre-wrap text-[12px] text-muted-foreground">
            {conversation.contactNotes}
          </p>
        </div>
      )}

      <div className="p-4">
        <Button asChild variant="outline" size="sm" className="w-full gap-2">
          <Link href={`/contacts?id=${conversation.contactId}`}>
            <ExternalLink className="h-3.5 w-3.5" />
            {t('فتح ملف جهة الاتصال')}
          </Link>
        </Button>
      </div>
    </aside>
  );
}
