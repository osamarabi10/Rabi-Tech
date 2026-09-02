'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, ChevronDown, Filter, WifiOff } from 'lucide-react';
import { isSnoozed, type Conv, type InboxView, type Session } from '@/lib/data';
import { gatewayCopy, gatewayState } from '@/lib/gateway-state';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  DEFAULT_SCOPE,
  countForScope,
  useInboxTaxonomy,
  type InboxScope,
  type ScopeContext,
} from '@/components/inbox/inbox-selector';

/**
 * The inbox scopes, for screens too narrow to carry the pane that holds them.
 *
 * Pane 1 is hidden below `lg`, which was the right call — a tablet keeps three
 * working panes rather than squeezing in a fourth. What was not right was the
 * claim that came with it: that every scope "stays reachable from the status
 * pills and search inside the list itself". The status pills are a different
 * axis entirely (open, pending, resolved). Mine, Unassigned, each lifecycle
 * stage and each team queue were reachable on a desktop and reachable nowhere
 * else, so an agent working from a phone could not see their own queue.
 *
 * Same scopes, same counts, one control instead of a column.
 */

type Option = { scope: InboxScope; label: string; count: number; swatch?: string | null };

function sameScope(a: InboxScope, b: InboxScope): boolean {
  return a.kind === b.kind && a.value === b.value;
}

export function InboxScopeMenu({
  convs,
  scope,
  onScopeChange,
  currentUserId,
  mentioned,
  views,
  className,
}: {
  convs: Conv[];
  scope: InboxScope;
  onScopeChange: (next: InboxScope) => void;
  currentUserId: string | undefined;
  /** Conversations this user was @mentioned in. Same set the pane uses. */
  mentioned: Set<string>;
  /** Saved views. Same list the pane renders, from the same fetch. */
  views: InboxView[];
  className?: string;
}) {
  const { t } = useT();
  const { stages, teams } = useInboxTaxonomy();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    // Also on Escape: a menu that only closes by clicking away traps anyone
    // navigating by keyboard.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const ctx: ScopeContext = { currentUserId, mentioned, views };

  // The same function the pane calls, not the same *logic* re-expressed.
  // Wide and narrow cannot disagree about a number if they ask one question.
  const countWhere = (candidate: InboxScope) => countForScope(convs, candidate, ctx);

  const groups: Array<{ title: string; options: Option[] }> = [
    {
      title: t('صناديق الوارد'),
      options: (
        [
          { scope: DEFAULT_SCOPE, label: t('كل المحادثات') },
          { scope: { kind: 'system', value: 'mine' } as InboxScope, label: t('مُسندة لي') },
          { scope: { kind: 'system', value: 'unassigned' } as InboxScope, label: t('غير مسندة') },
          ...(convs.some((conv) => isSnoozed(conv))
            ? [{ scope: { kind: 'system', value: 'snoozed' } as InboxScope, label: t('مؤجّلة') }]
            : []),
          // Same rule as the pane: offered only once there is one to look at.
          ...(mentioned.size > 0
            ? [{ scope: { kind: 'system', value: 'mentions' } as InboxScope, label: t('ذُكرت فيها') }]
            : []),
          /*
            Blocked, on the same rule.

            Shown only when a blocked contact actually has threads, because an
            empty Blocked inbox on a workspace that has never blocked anybody is
            a permanent row explaining a feature nobody used. When it appears it
            is because there is something in it.
          */
          ...(convs.some((conv) => conv.contactBlocked)
            ? [{ scope: { kind: 'system', value: 'blocked' } as InboxScope, label: t('محظورة') }]
            : []),
          /*
            Collaborations — threads this person is on but does not own.

            Offered only when there is one, on the same rule as the rest: a
            permanent empty row on a workspace that has never used collaborators
            explains a feature nobody adopted.
          */
          ...(convs.some((conv) => conv.collaboratorIds.length > 0)
            ? [{ scope: { kind: 'system', value: 'collaborating' } as InboxScope, label: t('مشترك فيها') }]
            : []),
        ] as Array<{ scope: InboxScope; label: string }>
      ).map((option) => ({ ...option, count: countWhere(option.scope) })),
    },
  ];

  if (stages.length > 0) {
    groups.push({
      title: t('مراحل العميل'),
      options: stages.map((stage) => {
        const candidate: InboxScope = { kind: 'lifecycle', value: stage.name };
        return {
          scope: candidate,
          label: stage.name,
          swatch: stage.color,
          count: countWhere(candidate),
        };
      }),
    });
  }

  if (teams.length > 0) {
    groups.push({
      title: t('صناديق الفرق'),
      options: teams.map((team) => {
        const candidate: InboxScope = { kind: 'team', value: team.id };
        return {
          scope: candidate,
          label: team.name,
          swatch: team.color ?? null,
          count: countWhere(candidate),
        };
      }),
    });
  }

  // Saved views, from the same list and the same counting function the pane
  // uses. Wide and narrow cannot disagree about a view's contents if neither
  // is expressing the rule in its own words.
  if (views.length > 0) {
    groups.push({
      title: t('العروض المحفوظة'),
      options: views.map((view) => {
        const candidate: InboxScope = { kind: 'view', value: view.id };
        return { scope: candidate, label: view.name, count: countWhere(candidate) };
      }),
    });
  }

  const active =
    groups.flatMap((group) => group.options).find((option) => sameScope(option.scope, scope)) ??
    groups[0].options[0];

  return (
    <div ref={wrapper} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex h-8 w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium"
      >
        <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-start">{active.label}</span>
        <span className="numeric shrink-0 tabular-nums text-muted-foreground">{active.count}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>

      {open && (
        <div
          role="listbox"
          // start-0 end-0, not inset-inline-0: the latter reads like the
          // logical property but Tailwind never generates it, so the menu had
          // no horizontal anchoring at all and sized itself to its longest
          // label. It looked deliberate and was simply an unstyled element.
          className="absolute start-0 end-0 top-9 z-30 max-h-72 overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg"
        >
          {groups.map((group) => (
            <div key={group.title}>
              <p className="px-2 py-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </p>
              {group.options.map((option) => {
                const isActive = sameScope(option.scope, scope);
                return (
                  <button
                    key={`${option.scope.kind}:${option.scope.value}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={() => {
                      onScopeChange(option.scope);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs',
                      isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent',
                    )}
                  >
                    {option.swatch ? (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: option.swatch }}
                        aria-hidden
                      />
                    ) : (
                      <Check
                        className={cn('h-3 w-3 shrink-0', isActive ? 'opacity-100' : 'opacity-0')}
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-start">{option.label}</span>
                    <span className="numeric shrink-0 tabular-nums text-muted-foreground">
                      {option.count}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Gateway trouble, on the screens that cannot see the rail that reports it.
 *
 * The pane at the bottom of column 1 is the only always-visible gateway status
 * in the inbox — and it disappears below `lg` along with the rest of that
 * column. On an unofficial gateway a dead session is silent, so the width at
 * which the warning vanishes is the width at which messages start going missing
 * with nothing on screen about it.
 *
 * Renders nothing when the gateway is healthy or still being checked: a
 * permanent green bar on a phone costs more room than it earns.
 */
export function GatewayNotice({
  sessions,
  className,
}: {
  sessions: Session[] | null;
  className?: string;
}) {
  const { t } = useT();
  const state = gatewayState(sessions);

  if (state.kind === 'checking' || state.kind === 'healthy') return null;

  const copy = gatewayCopy(state);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-3 py-1.5 text-micro',
        copy.tone === 'warning'
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-destructive/40 bg-destructive/10 text-destructive',
        className,
      )}
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="font-medium">{t(copy.label)}</span>
      {copy.impact && <span className="opacity-80">{t(copy.impact)}</span>}
      {copy.action && (
        <Link
          href={copy.action.href}
          className="ms-auto shrink-0 font-medium underline underline-offset-2 hover:no-underline"
        >
          {t(copy.action.label)}
        </Link>
      )}
    </div>
  );
}
