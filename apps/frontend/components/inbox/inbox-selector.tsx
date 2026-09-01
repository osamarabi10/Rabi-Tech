'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  Clock,
  Inbox,
  MoreHorizontal,
  Trash2,
  UserCheck,
  UserX,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import {
  isSnoozed,
  fetchLifecycleStages,
  fetchSessions,
  fetchTeams,
  createInboxView,
  deleteInboxView,
  updateInboxView,
  type Conv,
  type InboxView,
  type LifecycleStage,
  type Session,
  type Team,
} from '@/lib/data';
import { matchesViewFilter } from '@/lib/inbox-view-match';
import { captureView, type ConvStatusFilter } from '@/lib/inbox-view-capture';
import { SaveViewDialog } from '@/components/inbox/save-view-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  | { kind: 'system'; value: 'all' | 'mine' | 'unassigned' | 'mentions' | 'snoozed' | 'blocked' }
  | { kind: 'lifecycle'; value: string }
  | { kind: 'team'; value: string }
  /** A saved view. `value` is its id. */
  | { kind: 'view'; value: string };

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
  /**
   * The saved views this user can see — their own, plus the shared ones.
   *
   * Carried here rather than looked up by the predicate, because a scope of
   * kind 'view' holds only an id and the filter behind it lives elsewhere.
   * A view missing from this list matches nothing: while they load, an empty
   * view is honest and every conversation under someone's saved heading is
   * not.
   */
  views: InboxView[];
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
  // Snoozed threads belong to exactly one scope. Checked before anything else
  // so the counts here and the list beside them cannot disagree — the first
  // version excluded them in the page's filter only, and every row in this
  // column then counted one conversation more than the list contained.
  //
  // `kind` is part of the test, not just `value`: lifecycle stages are named
  // by the tenant, and a stage called "snoozed" would otherwise take over
  // this branch and show snoozed threads under a stage heading.
  if (scope.kind === 'system' && scope.value === 'snoozed') return isSnoozed(conv);

  /*
    Blocked is its own inbox, and like snoozed it is answered before the
    blanket exclusions below.

    Blocking refuses a contact at the inbound worker, before a conversation
    exists — so it stops NEW threads and leaves the ones already open sitting
    in the queue looking ordinary. That is the gap this closes: an operator
    blocks somebody and then cannot find what they blocked them from.

    Excluded from every other scope, the way snoozed is. A blocked contact's
    threads appearing under All is how an agent replies to somebody the
    workspace has decided not to talk to.
  */
  if (scope.kind === 'system' && scope.value === 'blocked') return conv.contactBlocked;
  if (conv.contactBlocked) return false;

  // Views decide their own relationship with snoozing, so they are answered
  // before the blanket exclusion below rather than after it.
  if (scope.kind === 'view') {
    const view = ctx.views.find((candidate) => candidate.id === scope.value);
    if (!view) return false;
    if (isSnoozed(conv) && !view.filter.includeSnoozed) return false;
    return matchesViewFilter(conv, view.filter, ctx.currentUserId);
  }

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
  action,
}: {
  label: string;
  count: number;
  active: boolean;
  onSelect: () => void;
  icon?: React.ReactNode;
  swatch?: string | null;
  /**
   * A control that belongs to the row rather than to selecting it — the
   * saved-view menu. A sibling of the button, never a child: a menu trigger
   * nested inside a button is invalid markup, and the browser resolves it by
   * firing both.
   */
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'group flex w-full items-center rounded-md transition-colors motion-micro',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start"
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
      {action && <span className="shrink-0 pe-1">{action}</span>}
    </div>
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
  views,
  convFilter,
  labelFilter,
  onViewsChanged,
  className,
}: {
  convs: Conv[];
  scope: InboxScope;
  onScopeChange: (next: InboxScope) => void;
  currentUserId: string | undefined;
  /** Conversations this user was @mentioned in, for the Mentions row. */
  mentioned: Set<string>;
  /** Saved views this user can see: their own, plus the shared ones. */
  views: InboxView[];
  /** The status pill above the list, so a saved view captures it too. */
  convFilter: ConvStatusFilter;
  /** The label chip above the list, same reason. */
  labelFilter: string | null;
  /**
   * Applied after a change this pane made. The socket also broadcasts it, but
   * the author should not have to wait for a round trip to see their own
   * edit — and their own private view is only ever sent to them.
   */
  onViewsChanged: (next: InboxView[]) => void;
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

  /**
   * Whether this user may put a view in front of the whole workspace.
   *
   * Read from the server rather than inferred from a role string here. It
   * gates only what the dialog offers; the server enforces the same rule
   * regardless of what this renders, which is why showing the restriction
   * instead of hiding it is safe.
   */
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    let cancelled = false;
    import('@/lib/api')
      .then(({ default: api }) => api.get('/api/auth/me'))
      .then((res) => {
        if (cancelled) return;
        const granted = res.data?.permissions;
        setCanShare(Array.isArray(granted) && granted.includes('inbox-view:manage-shared'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const [saveOpen, setSaveOpen] = useState(false);
  /** The view being renamed, or null when the dialog is creating one. */
  const [editing, setEditing] = useState<InboxView | null>(null);

  const ctx: ScopeContext = { currentUserId, mentioned, views };

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

  const capture = captureView(
    scope,
    convFilter,
    labelFilter,
    t,
    (id) => teams.find((team) => team.id === id)?.name ?? id,
    (id) => views.find((view) => view.id === id),
  );

  const replace = (next: InboxView) =>
    onViewsChanged(
      [...views.filter((view) => view.id !== next.id), next].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    );

  const submitDialog = async (name: string, shared: boolean) => {
    if (editing) {
      // updatedAt is what turns a concurrent edit into a 409 rather than one
      // supervisor silently overwriting another's rename.
      const updated = await updateInboxView(editing.id, {
        name,
        shared,
        updatedAt: editing.updatedAt,
      });
      replace(updated);
      return;
    }
    const created = await createInboxView({ name, filter: capture.filter, shared });
    onViewsChanged(
      [...views, created].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    );
    onScopeChange({ kind: 'view', value: created.id });
  };

  const removeView = async (view: InboxView) => {
    await deleteInboxView(view.id);
    onViewsChanged(views.filter((candidate) => candidate.id !== view.id));
    // The open scope just stopped existing.
    if (scope.kind === 'view' && scope.value === view.id) onScopeChange(DEFAULT_SCOPE);
  };

  /**
   * Move a view one place up or down.
   *
   * Rewrites `sortOrder` for the two rows that swap rather than for the whole
   * list: two requests instead of N, and the rest of the list keeps whatever
   * spacing it had. Both are sent before the state is replaced so a failure on
   * the second cannot leave the pane showing an order the server rejected.
   */
  const moveView = async (view: InboxView, direction: -1 | 1) => {
    const index = views.findIndex((candidate) => candidate.id === view.id);
    const swapWith = views[index + direction];
    if (!swapWith) return;

    // Equal sortOrder values are possible — everything defaults to 0 until
    // something moves — and swapping them would be a no-op that looks broken.
    // Falling back to the positions themselves gives the two rows distinct
    // numbers in one step.
    const [a, b] =
      view.sortOrder === swapWith.sortOrder
        ? [index + direction, index]
        : [swapWith.sortOrder, view.sortOrder];

    const moved = await updateInboxView(view.id, { sortOrder: a, updatedAt: view.updatedAt });
    const displaced = await updateInboxView(swapWith.id, {
      sortOrder: b,
      updatedAt: swapWith.updatedAt,
    });
    onViewsChanged(
      views
        .map((candidate) =>
          candidate.id === moved.id ? moved : candidate.id === displaced.id ? displaced : candidate,
        )
        .sort((x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name)),
    );
  };

  /** Own views are always editable; a shared one needs the permission. */
  const mayEdit = (view: InboxView) => (view.shared ? canShare : view.ownerId === currentUserId);

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

        {/*
          Saved views, on the same primitives as every other group so a view
          behaves exactly like a built-in scope. Shown only when one exists:
          same rule as Mentions and Snoozed — an agent with no views does not
          need a permanent empty heading explaining that.
        */}
        {views.length > 0 && (
          <Group title={t('العروض المحفوظة')}>
            {views.map((view) => (
              <ScopeRow
                key={view.id}
                label={view.name}
                icon={
                  view.shared ? (
                    <Users className="h-3.5 w-3.5 shrink-0" />
                  ) : (
                    <Bookmark className="h-3.5 w-3.5 shrink-0" />
                  )
                }
                {...row({ kind: 'view', value: view.id })}
                action={
                  /*
                    Only for views this user may change. Shown rather than
                    hidden would mean a menu whose every item errors — the
                    restriction is already visible in the dialog that offers
                    sharing, and a dead menu on someone else's shared view
                    teaches nothing.
                  */
                  mayEdit(view) ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('خيارات العرض')}
                          className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onSelect={() => {
                            setEditing(view);
                            setSaveOpen(true);
                          }}
                        >
                          {t('عدّل')}
                        </DropdownMenuItem>
                        {/*
                          Only offered where there is somewhere to go. A
                          permanently disabled "move up" on the first row is a
                          control that never does anything.
                        */}
                        {views[0]?.id !== view.id && (
                          <DropdownMenuItem
                            onSelect={() => {
                              void moveView(view, -1);
                            }}
                          >
                            <ArrowUp className="me-1.5 h-3.5 w-3.5" />
                            {t('حرّكه فوق')}
                          </DropdownMenuItem>
                        )}
                        {views[views.length - 1]?.id !== view.id && (
                          <DropdownMenuItem
                            onSelect={() => {
                              void moveView(view, 1);
                            }}
                          >
                            <ArrowDown className="me-1.5 h-3.5 w-3.5" />
                            {t('حرّكه تحت')}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          className="text-danger"
                          onSelect={() => {
                            void removeView(view);
                          }}
                        >
                          <Trash2 className="me-1.5 h-3.5 w-3.5" />
                          {t('احذف')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : undefined
                }
              />
            ))}
          </Group>
        )}

        {/*
          The only way to create one, so it is always present — a control that
          appears once you already have the thing it creates is a control
          nobody finds.
        */}
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setSaveOpen(true);
          }}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-caption text-muted-foreground transition-colors motion-micro hover:bg-accent hover:text-foreground"
        >
          <BookmarkPlus className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t('احفظ هالعرض')}</span>
        </button>
      </div>

      {/*
        Gateway state, pinned to the bottom. First-class placement because on an
        unofficial gateway nothing else warns you: Meta would flag a degrading
        number, here a dead session is silent until a send fails.
      */}
      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        mode={editing ? 'edit' : 'create'}
        initialName={editing?.name ?? ''}
        initialShared={editing?.shared ?? false}
        describes={capture.describes}
        omits={capture.omits}
        canShare={canShare}
        onSubmit={submitDialog}
      />

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
