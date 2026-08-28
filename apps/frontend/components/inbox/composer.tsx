'use client';

import { useEffect, useRef, useState } from 'react';
import { AtSign, Loader2, Paperclip, Send, Smile, Zap } from 'lucide-react';
import type { SnippetAttachment, Template } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The message composer.
 *
 * Replaces a 28x36px padlock icon that was the only affordance for internal notes
 * — easy to miss, meaning conveyed solely by a `title` attribute. Respond.io makes
 * this a first-class mode switch, because posting an internal note to the customer
 * by mistake is the worst error an agent can make in this screen.
 *
 * Comment mode visibly recolours the whole composer and swaps the send button, so
 * the current mode is unmissable at a glance.
 */
/**
 * Emoji offered in the composer.
 *
 * A curated row rather than a full picker. A complete picker means a search
 * index, skin-tone variants and a dependency, and none of that earns its
 * place on a support desk where the same dozen glyphs cover almost every
 * message: acknowledgement, thanks, apology, and the handful that soften a
 * refusal. An agent who needs something else can paste it — the field is a
 * plain textarea.
 */
const EMOJI = [
  '👍', '🙏', '✅', '❌', '⏳', '📞', '📶', '🔧', '💰', '📄',
  '😊', '😅', '🙌', '❤️', '🎉', '⚠️', '🔴', '🟢', '⭐', '📌',
];

/** A teammate who can be mentioned. Id-based, never matched by name. */
export type MentionCandidate = { id: string; name: string };

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  isInternal: boolean;
  onInternalChange: (internal: boolean) => void;
  onSend: () => void | Promise<void>;
  disabled?: boolean;
  sending?: boolean;
  error?: string | null;
  /** Snippet suggestions for the `:shortcode` popover. */
  shortCodeMatches?: Template[];
  onShortCodeQuery?: (query: string | null) => void;
  onShortCodePick?: (template: Template) => void;
  /**
   * Teammate suggestions for the `@mention` popover.
   *
   * Only ever populated while `isInternal` is true. A mention on a
   * customer-facing reply would either leak a colleague’s name into the
   * WhatsApp message or notify someone the customer never saw named.
   */
  mentionMatches?: MentionCandidate[];
  onMentionQuery?: (query: string | null) => void;
  onMentionPick?: (user: MentionCandidate) => void;
  /** Quick-reply chips shown above the input. */
  quickTemplates?: Template[];
  onQuickTemplate?: (template: Template) => void;
  attachments?: SnippetAttachment[];
  onRemoveAttachment?: (attachmentId: string) => void;
  onAttach?: (file: File) => void;
  maxLength?: number;
}

export function Composer({
  value,
  onChange,
  isInternal,
  onInternalChange,
  onSend,
  disabled,
  sending,
  error,
  shortCodeMatches = [],
  onShortCodeQuery,
  onShortCodePick,
  mentionMatches = [],
  onMentionQuery,
  onMentionPick,
  quickTemplates = [],
  onQuickTemplate,
  attachments = [],
  onRemoveAttachment,
  onAttach,
  maxLength = 3000,
}: ComposerProps) {
  const { t } = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);

  /**
   * Insert at the caret, not at the end.
   *
   * An agent adding a 👍 to the front of a sentence they have already written
   * should not have it land after the full stop. The caret is restored after
   * the update so the next character typed continues where they were.
   */
  const insertEmoji = (emoji: string) => {
    const field = textareaRef.current;
    const at = field ? field.selectionStart ?? value.length : value.length;
    const next = value.slice(0, at) + emoji + value.slice(field?.selectionEnd ?? at);
    onChange(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      const caret = at + emoji.length;
      field.setSelectionRange(caret, caret);
    });
  };
  const [highlight, setHighlight] = useState(0);

  // Leaving note mode closes the mention list — the suggestions are only valid
  // on an internal note, and a stale popover over a customer-facing reply
  // invites inserting a colleague’s name into a WhatsApp message.
  useEffect(() => {
    if (!isInternal) onMentionQuery?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInternal]);

  const tooLong = value.length > maxLength;
  const canSend = !disabled && !sending && (value.trim().length > 0 || attachments.length > 0) && !tooLong;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention popover first: it only opens on internal notes, where the
    // snippet popover is the less likely of the two to be what the agent is
    // driving. Both cannot be open at once — one is triggered by `@`, the
    // other by `/`.
    if (mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        onMentionPick?.(mentionMatches[highlight]);
        setHighlight(0);
        return;
      }
      if (e.key === 'Escape') {
        onMentionQuery?.(null);
        return;
      }
    }

    // Snippet popover navigation takes precedence while it is open.
    if (shortCodeMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((i) => (i + 1) % shortCodeMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((i) => (i - 1 + shortCodeMatches.length) % shortCodeMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        onShortCodePick?.(shortCodeMatches[highlight]);
        setHighlight(0);
        return;
      }
      if (e.key === 'Escape') {
        onShortCodeQuery?.(null);
        return;
      }
    }

    // Ctrl/Cmd+Enter always sends. Plain Enter sends too (Shift+Enter for newline)
    // because agents type far more one-line replies than multi-line ones.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      if (canSend) void onSend();
    }
  };

  return (
    <div
      className={cn(
        'border-t transition-colors',
        isInternal
          ? 'border-warning/40 bg-warning/[0.06]'
          : 'border-border bg-card',
      )}
    >
      {/* Mode switch — the most important control in this screen */}
      <div className="flex items-center gap-1 px-3 pt-2">
        <div className="inline-flex rounded-md border border-border bg-secondary/40 p-0.5">
          <button
            type="button"
            onClick={() => onInternalChange(false)}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              !isInternal
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('رد')}
          </button>
          <button
            type="button"
            onClick={() => onInternalChange(true)}
            className={cn(
              'rounded px-3 py-1 text-xs font-medium transition-colors',
              isInternal
                ? 'bg-warning text-black shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t('ملاحظة داخلية')}
          </button>
        </div>

        {isInternal && (
          <span className="text-caption text-warning/90">
            {t('العميل ما بيشوف هالملاحظة')}
          </span>
        )}
      </div>

      {/* Quick replies */}
      {quickTemplates.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pt-2">
          {quickTemplates.slice(0, 6).map((tpl) => (
            <button
              key={tpl.id}
              type="button"
              disabled={disabled}
              onClick={() => onQuickTemplate?.(tpl)}
              className="max-w-[170px] truncate rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5 text-caption text-primary/80 transition-colors hover:bg-primary/15 hover:text-primary"
            >
              {tpl.shortCode && <span className="ms-1 text-primary/40">/{tpl.shortCode}</span>}
              {tpl.title}
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-3 pt-2" aria-label={t('Attached Snippet files')}>
        {attachments.map((attachment) => <span key={attachment.id} className="inline-flex max-w-52 items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-caption">
          <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{attachment.fileName}</span>
          <button type="button" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={`${t('Remove file')} ${attachment.fileName}`} onClick={() => onRemoveAttachment?.(attachment.id)}>×</button>
        </span>)}
      </div>}

      <div className="flex items-end gap-2 p-3">
        {/* Attachment — wired, not decorative */}
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onAttach?.(file);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 shrink-0"
          disabled={disabled || isInternal || !onAttach}
          title={isInternal ? t('المرفقات غير متاحة بالملاحظات') : t('إرفاق ملف')}
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        {/*
          Emoji. Available on notes as well as replies — a note is written by a
          person for people, and there is no channel constraint on it.
        */}
        <div className="relative shrink-0">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            disabled={disabled}
            aria-expanded={emojiOpen}
            title={t('إدراج إيموجي')}
            onClick={() => setEmojiOpen((previous) => !previous)}
          >
            <Smile className="h-4 w-4" />
          </Button>

          {emojiOpen && (
            <>
              {/* A click anywhere else closes it, including on the message
                  the agent meant to click next. */}
              <button
                type="button"
                aria-label={t('إغلاق')}
                className="fixed inset-0 z-20 cursor-default"
                onClick={() => setEmojiOpen(false)}
              />
              <div className="absolute bottom-11 start-0 z-30 grid w-56 grid-cols-10 gap-0.5 rounded-lg border border-border bg-popover p-1.5 shadow-xl">
                {EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => insertEmoji(emoji)}
                    className="rounded p-0.5 text-base leading-none transition-colors hover:bg-accent"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="relative flex-1">
          {mentionMatches.length > 0 && (
            <div
              className={cn(
                'absolute bottom-full mb-1.5 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover shadow-xl',
                'animate-in fade-in-0 slide-in-from-bottom-1 motion-panel',
              )}
              role="listbox"
            >
              {mentionMatches.slice(0, 5).map((user, i) => (
                <button
                  key={user.id}
                  type="button"
                  onClick={() => onMentionPick?.(user)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-start text-h3 transition-colors',
                    i === highlight ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                  )}
                >
                  <AtSign className="h-3 w-3 shrink-0 opacity-50" />
                  <span className="truncate">{user.name}</span>
                </button>
              ))}
              <div className="flex items-center gap-3 border-t border-border bg-secondary/50 px-3 py-1 text-micro text-muted-foreground">
                <span dir="ltr">↑↓</span>
                <span>{t('تنقّل')}</span>
                <span dir="ltr">Tab</span>
                <span>{t('إدراج')}</span>
              </div>
            </div>
          )}

          {shortCodeMatches.length > 0 && (
            <div
              className={cn(
                'absolute bottom-full mb-1.5 w-full max-w-md overflow-hidden rounded-lg border border-border bg-popover shadow-xl',
                // Rises out of the composer rather than appearing on top of
                // it, so the eye follows where it came from.
                'animate-in fade-in-0 slide-in-from-bottom-1 duration-150',
              )}
              role="listbox"
            >
              {shortCodeMatches.slice(0, 5).map((tpl, i) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onShortCodePick?.(tpl)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-start text-xs transition-colors',
                    i === highlight ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                  )}
                >
                  <Zap className="h-3 w-3 shrink-0 opacity-50" />
                  <span className="numeric font-mono opacity-60" dir="ltr">/{tpl.shortCode}</span>
                  <span className="truncate">{tpl.title}</span>
                </button>
              ))}
              {/* The list was already keyboard-navigable; nothing said so. */}
              <div className="flex items-center gap-3 border-t border-border bg-secondary/50 px-3 py-1 text-micro text-muted-foreground">
                <span dir="ltr">↑↓</span>
                <span>{t('تنقّل')}</span>
                <span dir="ltr">Tab</span>
                <span>{t('إدراج')}</span>
              </div>
            </div>
          )}

          <Textarea
            ref={textareaRef}
            rows={1}
            dir="auto"
            className={cn(
              'max-h-32 min-h-9 resize-none pe-14 text-sm',
              isInternal && 'border-warning/40 bg-warning/5',
              tooLong && 'border-destructive',
            )}
            placeholder={
              isInternal ? t('اكتب ملاحظة داخلية...') : t('اكتب رسالة...  اكتب / للردود الجاهزة')
            }
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value;
              onChange(next);
              // `/code` is the workspace-wide Snippet command. The old
              // `:code` form remains accepted so agents do not lose muscle
              // memory during the migration.
              if ((next.startsWith('/') || next.startsWith(':')) && next.length >= 2 && !next.includes(' ')) {
                onShortCodeQuery?.(next.slice(1));
              } else {
                onShortCodeQuery?.(null);
              }

              // `@fragment` at the caret opens the mention popover. Anchored to
              // the end rather than searched for anywhere in the note, so an
              // address or an already-inserted mention earlier in the text does
              // not reopen the list while the agent types past it.
              if (isInternal) {
                const atCaret = next.match(/@([^\s@]*)$/);
                onMentionQuery?.(atCaret ? atCaret[1] : null);
              } else {
                onMentionQuery?.(null);
              }
            }}
            onKeyDown={handleKeyDown}
          />
          <span
            className={cn(
              'absolute bottom-1.5 end-2 text-micro',
              tooLong ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {value.length}/{maxLength}
          </span>
        </div>

        <Button
          size="icon"
          className={cn('h-9 w-9 shrink-0', isInternal && 'bg-warning text-black hover:bg-warning/90')}
          disabled={!canSend}
          onClick={() => void onSend()}
          title={t('إرسال — Ctrl+Enter')}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>

      {error && <p className="px-3 pb-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}
