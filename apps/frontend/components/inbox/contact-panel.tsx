'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { ExternalLink, Tag, User, X } from 'lucide-react';
import {
  updateContact,
  type Agent,
  type Conv,
  type MarketingConsent,
  type Msg,
} from '@/lib/data';
import { avatarColor } from '@/lib/constants';
import { useT } from '@/lib/i18n';
import { LifecycleSelect, useLifecycleStages } from './lifecycle-select';
import {
  ActivityTab,
  ContactTabStrip,
  FilesTab,
  type ContactTab,
} from './contact-context-tabs';
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
  /**
   * The thread's messages, for the Files tab.
   *
   * Passed down rather than fetched again: the parent already holds them, and
   * a second fetch would show a different set from the thread beside it the
   * moment a new attachment arrives.
   */
  messages: Msg[];
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
  messages,
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
  const [tab, setTab] = useState<ContactTab>('details');

  // Back to Details when the agent switches conversation. Staying on Activity
  // would briefly show the previous contact's timeline, which reads as the new
  // contact's history.
  useEffect(() => {
    setTab('details');
  }, [conversation.contactId]);
  const stages = useLifecycleStages();
  const [stage, setStage] = useState<string | null>(conversation.lifecycleStage);
  const [savingStage, setSavingStage] = useState(false);

  // The panel is reused as the selection changes rather than remounted, so
  // without this the previous contact’s stage stays on screen.
  useEffect(() => {
    setStage(conversation.lifecycleStage);
  }, [conversation.contactId, conversation.lifecycleStage]);

  const saveStage = async (next: string | null) => {
    const previous = stage;
    setStage(next);
    setSavingStage(true);
    try {
      await updateContact(conversation.contactId, { lifecycleStage: next });
      toast.success(t('تم تحديث المرحلة'));
    } catch {
      // Put the old value back rather than leaving the control showing a
      // change that never reached the server.
      setStage(previous);
      toast.error(t('فشل التحديث'));
    } finally {
      setSavingStage(false);
    }
  };

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
    // Scrolling moved off the pane and onto each tab body, so the tab strip
    // stays fixed while a long Activity timeline scrolls beneath it.
    <aside className="hidden w-[320px] shrink-0 flex-col overflow-hidden border-s border-border bg-[hsl(var(--surface-1))] xl:flex">
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

      <ContactTabStrip
        active={tab}
        onChange={setTab}
        fileCount={messages.filter(message => message.mediaUrl).length}
      />

      {tab === 'files' && (
        <div className="flex-1 overflow-y-auto">
          <FilesTab messages={messages} />
        </div>
      )}

      {tab === 'activity' && (
        <div className="flex-1 overflow-y-auto">
          <ActivityTab conversationId={conversation.id} />
        </div>
      )}

      {tab === 'details' && (
      <div className="flex-1 overflow-y-auto">

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
            <p className="numeric font-mono text-caption text-muted-foreground" dir="ltr">
              {conversation.phone}
            </p>
          </div>
        </div>

        <dl className="space-y-1.5 text-small">
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
            <dt className="w-20 shrink-0 text-muted-foreground">{t('مرحلة العميل')}</dt>
            <dd className="min-w-0 flex-1">
              <LifecycleSelect
                value={stage}
                stages={stages}
                onChange={saveStage}
                disabled={savingStage}
              />
            </dd>
          </div>

          <div className="flex items-center gap-2">
            <dt className="w-20 shrink-0 text-muted-foreground">{t('التسويق')}</dt>
            <dd className="min-w-0 flex-1">
              <select
                value={conversation.marketingConsent}
                disabled={savingConsent}
                onChange={(e) => saveConsent(e.target.value as MarketingConsent)}
                className={cn(
                  'w-full rounded border border-border bg-card px-1.5 py-0.5 text-caption',
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
          <p className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-micro text-warning">
            {t('مستبعد من كل الحملات')}
          </p>
        )}

        {conversation.contactTags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {conversation.contactTags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-micro text-muted-foreground"
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
        <p className="mb-2 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
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
                  <span className="ms-auto shrink-0 text-micro opacity-60">{t('أنا')}</span>
                )}
              </button>
            );
          })}

          {agents.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAllAgents((v) => !v)}
              className="w-full rounded-md px-2 py-1 text-start text-caption text-muted-foreground hover:text-foreground"
            >
              {showAllAgents ? t('عرض أقل') : `${t('عرض الكل')} (${agents.length})`}
            </button>
          )}
        </div>
      </div>

      {/* Notes */}
      {conversation.contactNotes && (
        <div className="border-b border-border p-4">
          <p className="mb-1.5 text-micro font-semibold uppercase tracking-wider text-muted-foreground">
            {t('ملاحظات')}
          </p>
          <p className="whitespace-pre-wrap text-small text-muted-foreground">
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
      </div>
      )}
    </aside>
  );
}
