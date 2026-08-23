'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AtSign, ChevronDown, Clock, Inbox, UserCheck, UserX, Wifi, WifiOff } from 'lucide-react';
import {
  isSnoozed,
  fetchLifecycleStages,
  fetchSessions,
  fetchTeams,
  type Conv,
  type LifecycleStage,
  type Session,
  type Team,
} from '@/lib/data';
import { gatewayCopy, gatewayState } from '@/lib/gateway-state';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Column 1 of the four-pane inbox: what you are looking at.
 *
 * The conversation list already owned *status* filtering. This owns *scope* —
 * whose work it is, where the contact stands in the pipeline, which team's
 * queue. The two are orthogonal and combine: "my conversations that are still
 * open", "the Sales queue at the Qualified stage".
 *
 * ## Counts are real, and bounded
 *
 * Every number here is counted from the conversations actually loaded, not
 * invented and not fetched from a second endpoint that could disagree with the
 * list beside it. The list endpoint currently returns every conversation in the
 * organization with no pagination, so today these totals are exact.
 *
 * That has a ceiling. When the list is paginated — and it will need to be — the
 * counts become "of what is loaded" and start lying quietly. At that point they
 * must move to a server-side aggregate. The comment is here so the next person
 * finds the reason rather than the bug.
 */

export type InboxScope =
  | { kind: 'system'; value: 'all' | 'mine' | 'unassigned' | 'mentions' | 'snoozed' }
  | { kind: 'lifecycle'; value: string }
  | { kind: 'team'; value: string };

export const DEFAULT_SCOPE: InboxScope = { kind: 'system', value: 'all' };

/**
 * Everything a scope needs that cannot be read off a conversation.
 *
 * An object rather than more positional parameters. This signature had
 * already reached four, and saved views would have made five — the point at
 * which a caller silently passes the wrong argument in the right position and
 * nothing complains. Adding a field here breaks the callers that need to know
 * and leaves the rest alone.
 */
export type ScopeContext = {
  /** The signed-in user, for the `mine` scope. */
  currentUserId: string | undefined;
  /**
   * Conversations this user was named in.
   *
   * A mention lives on a notification, not on the thread, so it cannot be
   * read from `conv`. An empty set means not loaded yet and matches nothing:
   * briefly showing an empty Mentions view beats briefly showing every
   * conversation in it.
   */
  mentioned: Set<string>;
};

/**
 * Conversations that belong in an inbox at all.
 *
 * WhatsApp status broadcasts arrive as messages from `status@broadcast` and
 * are not conversations with anybody. Excluded once, here, rather than in
 * every caller's filter chain — which is where it lived, and where one caller
 * forgetting it would have shown a phantom row.
 */
export function isRealConversation(conv: Conv): boolean {
  return !conv.phone.includes('status@broadcast');
}

export function scopeMatches(
  conv: Conv,
  scope: InboxScope,
  ctx: ScopeContext,
): boolean {
  // Snoozed threads belong to exactly one view. Checked before anything else
  // so the counts here and the list beside them cannot disagree — the first
  // version excluded them in the page's filter only, and every row in this
  // column then counted one conversation more than the list contained.
  if (scope.value === 'snoozed') return isSnoozed(conv);
  if (isSnoozed(conv)) return false;

  if (scope.kind === 'lifecycle') return conv.lifecycleStage === scope.value;
  if (scope.kind === 'team') return conv.teamId === scope.value;
  if (scope.value === 'mine') return conv.assigneeId === ctx.currentUserId;
  if (scope.value === 'unassigned') return !conv.assigneeId;
  if (scope.value === 'mentions') return ctx.mentioned.has(conv.id);
  return true;
}

/**
 * How many conversations a scope holds.
 *
 * The count beside a row and the rows in the list are the same question, so
 * they run the same predicate. The pane used to answer it with seven
 * hand-written predicates — one per row — each duplicating a branch of
 * scopeMatches and each free to drift from it. Both times the counts have
 * disagreed with the list, that is where it came from.
 */
export function countForScope(
  convs: Conv[],
  scope: InboxScope,
  ctx: ScopeContext,
): number {
  return convs.filter((conv) => isRealConversation(conv) && scopeMatches(conv, scope, ctx))
    .length;
}

/**
 * Lifecycle stages and teams, fetched once and shared.
 *
 * Two components need them — the full pane on a wide screen and the compact
 * menu below it — and both are mounted at every width because the choice
 * between them is CSS, not JavaScript. Without the cache that is two extra
 * requests on every desktop page load for data that does not change during
 * a session.
 */
let taxonomyCache: Promise<{ stages: LifecycleStage[]; teams: Team[] }> | null = null;

function loadTaxonomy() {
  if (!taxonomyCache) {
    taxonomyCache = Promise.all([
      fetchLifecycleStages().catch(() => [] as LifecycleStage[]),
      fetchTeams().catch(() => [] as Team[]),
    ]).then(([stages, teams]) => ({ stages, teams }));
  }
  return taxonomyCache;
}

export function useInboxTaxonomy() {
  const [taxonomy, setTaxonomy] = useState<{ stages: LifecycleStage[]; teams: Team[] }>({
    stages: [],
    teams: [],
  });

  useEffect(() => {
    let cancelled = false;
    loadTaxonomy().then((next) => {
      if (!cancelled) setTaxonomy(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return taxonomy;
}

function sameScope(a: InboxScope, b: InboxScope): boolean {
  return a.kind === b.kind && a.value === b.value;
}

/** One row. The count sits in its own column so the numbers align down the list. */
function ScopeRow({
  label,
  count,
  active,
  onSelect,
  icon,
  swatch,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  swatch?: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start transition-colors motion-micro',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {swatch !== undefined && swatch !== null && (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: swatch }}
          aria-hidden
        />
      )}
      {icon}
      <span className="min-w-0 flex-1 truncate text-caption font-medium">{label}</span>
      {/* Zero is shown rather than hidden: an empty queue is information, and a
          row that drops its number reads as though it failed to load. */}
      <span
        className={cn(
          'numeric shrink-0 text-micro tabular-nums',
          active ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {count}
      </span>
    </button>
  );
}

function Group({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 px-2 py-1 text-micro font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={cn('h-3 w-3 transition-transform motion-micro', !open && '-rotate-90 rtl:rotate-90')}
        />
        <span className="flex-1 text-start">{title}</span>
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

export function InboxSelector({
  convs,
  scope,
  onScopeChange,
  currentUserId,
  mentioned,
  className,
}: {
  convs: Conv[];
  scope: InboxScope;
  onScopeChange: (next: InboxScope) => void;
  currentUserId: string | undefined;
  /** Conversations this user was @mentioned in, for the Mentions row. */
  mentioned: Set<string>;
  className?: string;
}) {
  const { t } = useT();
  const { stages, teams } = useInboxTaxonomy();
  const [sessions, setSessions] = useState<Session[] | null>(null);

  useEffect(() => {
    // Gateway state is live, so it is polled rather than read once. An agent
    // whose session dropped needs to see it here, not discover it from a failed
    // send — this column is the only always-visible surface in the inbox.
    let cancelled = false;
    const read = () =>
      fetchSessions()
        .then((next) => {
          if (!cancelled) setSessions(next);
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });

    read();
    const timer = setInterval(read, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const ctx: ScopeContext = { currentUserId, mentioned };

  /**
   * Everything a row needs, derived from the one scope it represents.
   *
   * Its count, whether it is active, and what selecting it does were three
   * separate expressions repeating the same scope literal three times. One
   * of them drifting from the other two is a row that highlights the wrong
   * entry, or counts a different thing from what it opens.
   */
  const row = (target: InboxScope) => ({
    count: countForScope(convs, target, ctx),
    active: sameScope(scope, target),
    onSelect: () => onScopeChange(target),
  });

  const snoozedCount = countForScope(convs, { kind: 'system', value: 'snoozed' }, ctx);

  const connected = sessions?.filter((s) => s.connected).length ?? 0;
  const total = sessions?.length ?? 0;
  const gateway = gatewayState(sessions);
  const gatewayText = gatewayCopy(gateway);

  return (
    <aside
      className={cn(
        'flex w-full flex-col border-e border-border bg-card md:w-[232px] md:shrink-0',
        className,
      )}
      aria-label={t('اختيار صندوق الوارد')}
    >
      <div className="flex-1 overflow-y-auto p-2">
        <Group title={t('صناديق الوارد')}>
          <ScopeRow
            label={t('كل المحادثات')}
            icon={<Inbox className="h-3.5 w-3.5 shrink-0" />}
            {...row({ kind: 'system', value: 'all' })}
          />
          <ScopeRow
            label={t('مُسندة لي')}
            icon={<UserCheck className="h-3.5 w-3.5 shrink-0" />}
            {...row({ kind: 'system', value: 'mine' })}
          />
          <ScopeRow
            label={t('غير مسندة')}
            icon={<UserX className="h-3.5 w-3.5 shrink-0" />}
            {...row({ kind: 'system', value: 'unassigned' })}
          />
          {/*
            Mentions. Shown only once there is at least one — an agent nobody
            has ever named does not need a permanent zero telling them so.
          */}
          {/*
            Snoozed. Like Mentions, offered only when there is something in
            it — a permanent zero is a row that never earns its line.
          */}
          {snoozedCount > 0 && (
            <ScopeRow
              label={t('مؤجّلة')}
              icon={<Clock className="h-3.5 w-3.5 shrink-0" />}
              {...row({ kind: 'system', value: 'snoozed' })}
            />
          )}
          {mentioned.size > 0 && (
            <ScopeRow
              label={t('ذُكرت فيها')}
              icon={<AtSign className="h-3.5 w-3.5 shrink-0" />}
              {...row({ kind: 'system', value: 'mentions' })}
            />
          )}
        </Group>

        {/*
          Lifecycle and teams appear only when the tenant has configured them.
          An empty "Lifecycle" heading over nothing is a dead section, and this
          product's whole vocabulary is subscriber-defined.
        */}
        {stages.length > 0 && (
          <Group title={t('مراحل العميل')}>
            {stages.map((stage) => (
              <ScopeRow
                key={stage.id}
                label={stage.name}
                swatch={stage.color}
                {...row({ kind: 'lifecycle', value: stage.name })}
              />
            ))}
          </Group>
        )}

        {teams.length > 0 && (
          <Group title={t('صناديق الفرق')}>
            {teams.map((team) => (
              <ScopeRow
                key={team.id}
                label={team.name}
                swatch={team.color ?? null}
                {...row({ kind: 'team', value: team.id })}
              />
            ))}
          </Group>
        )}
      </div>

      {/*
        Gateway state, pinned to the bottom. First-class placement because on an
        unofficial gateway nothing else warns you: Meta would flag a degrading
        number, here a dead session is silent until a send fails.
      */}
      <div className="shrink-0 border-t border-border p-2">
        <div
          className={cn(
            'px-1 py-1.5 text-micro',
            gatewayText.tone === 'success' && 'text-success',
            gatewayText.tone === 'warning' && 'text-warning',
            gatewayText.tone === 'destructive' && 'text-destructive',
            gatewayText.tone === 'muted' && 'text-muted-foreground',
          )}
        >
          <div className="flex items-center gap-2">
            {gateway.kind === 'checking' ? (
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/40" />
            ) : gateway.kind === 'healthy' ? (
              <Wifi className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{t(gatewayText.label)}</span>
            {/* The ratio only means anything once there is more than one
                number: "0/1" restates the sentence beside it. */}
            {total > 1 && (
              <span className="numeric shrink-0 tabular-nums" dir="ltr">
                {connected}/{total}
              </span>
            )}
          </div>
          {gatewayText.impact && (
            <p className="mt-0.5 ps-5 opacity-80">{t(gatewayText.impact)}</p>
          )}
          {gatewayText.action && (
            <Link
              href={gatewayText.action.href}
              className="mt-0.5 inline-block ps-5 font-medium underline underline-offset-2 hover:no-underline"
            >
              {t(gatewayText.action.label)}
            </Link>
          )}
        </div>
      </div>
    </aside>
  );
}
