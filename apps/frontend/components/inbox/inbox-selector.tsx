'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AtSign, ChevronDown, Inbox, UserCheck, UserX, Wifi, WifiOff } from 'lucide-react';
import {
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
  | { kind: 'system'; value: 'all' | 'mine' | 'unassigned' | 'mentions' }
  | { kind: 'lifecycle'; value: string }
  | { kind: 'team'; value: string };

export const DEFAULT_SCOPE: InboxScope = { kind: 'system', value: 'all' };

export function scopeMatches(
  conv: Conv,
  scope: InboxScope,
  currentUserId: string | undefined,
  /**
   * Conversations this user was named in.
   *
   * Passed in rather than read from the conversation, because a mention
   * lives on a notification and not on the thread. An undefined set means
   * not loaded yet, which matches nothing — briefly showing an empty
   * Mentions view is better than briefly showing every conversation in it.
   */
  mentioned?: Set<string>,
): boolean {
  if (scope.kind === 'lifecycle') return conv.lifecycleStage === scope.value;
  if (scope.kind === 'team') return conv.teamId === scope.value;
  if (scope.value === 'mine') return conv.assigneeId === currentUserId;
  if (scope.value === 'unassigned') return !conv.assigneeId;
  if (scope.value === 'mentions') return mentioned?.has(conv.id) ?? false;
  return true;
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

  const countWhere = (predicate: (conv: Conv) => boolean) =>
    convs.filter((conv) => !conv.phone.includes('status@broadcast')).filter(predicate).length;

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
            count={countWhere(() => true)}
            active={sameScope(scope, { kind: 'system', value: 'all' })}
            onSelect={() => onScopeChange({ kind: 'system', value: 'all' })}
            icon={<Inbox className="h-3.5 w-3.5 shrink-0" />}
          />
          <ScopeRow
            label={t('مُسندة لي')}
            count={countWhere((c) => c.assigneeId === currentUserId)}
            active={sameScope(scope, { kind: 'system', value: 'mine' })}
            onSelect={() => onScopeChange({ kind: 'system', value: 'mine' })}
            icon={<UserCheck className="h-3.5 w-3.5 shrink-0" />}
          />
          <ScopeRow
            label={t('غير مسندة')}
            count={countWhere((c) => !c.assigneeId)}
            active={sameScope(scope, { kind: 'system', value: 'unassigned' })}
            onSelect={() => onScopeChange({ kind: 'system', value: 'unassigned' })}
            icon={<UserX className="h-3.5 w-3.5 shrink-0" />}
          />
          {/*
            Mentions. Shown only once there is at least one — an agent nobody
            has ever named does not need a permanent zero telling them so.
          */}
          {mentioned.size > 0 && (
            <ScopeRow
              label={t('ذُكرت فيها')}
              count={countWhere((c) => mentioned.has(c.id))}
              active={sameScope(scope, { kind: 'system', value: 'mentions' })}
              onSelect={() => onScopeChange({ kind: 'system', value: 'mentions' })}
              icon={<AtSign className="h-3.5 w-3.5 shrink-0" />}
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
                count={countWhere((c) => c.lifecycleStage === stage.name)}
                active={sameScope(scope, { kind: 'lifecycle', value: stage.name })}
                onSelect={() => onScopeChange({ kind: 'lifecycle', value: stage.name })}
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
                count={countWhere((c) => c.teamId === team.id)}
                active={sameScope(scope, { kind: 'team', value: team.id })}
                onSelect={() => onScopeChange({ kind: 'team', value: team.id })}
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
