'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, Plus } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * P4 · RailGroup — a labelled group of rail destinations.
 *
 * ## What this is extracted from, and the constraint that shaped it
 *
 * The grouping markup came out of `settings/settings-rail.tsx`, which is P2 and
 * already certified. Extraction had one hard rule: **the rendered DOM and
 * `aria-current` behaviour must be identical afterwards.** If the DOM moves, a
 * checked item has been quietly decertified in order to build an unchecked one,
 * and `settings-responsive.spec.ts` is the regression check that says so.
 *
 * That rule is why the canonical class names live here rather than being passed
 * in, and why every capability the settings rail does not use is **off by
 * default and renders nothing at all** when unused:
 *
 * - `collapsible` off → the heading stays a plain `h2`, not a disclosure button.
 * - `count` undefined → no count element. Deliberately not defaulted to 0:
 *   "no count" and "a count of zero" are different statements, and a rail that
 *   says `0` next to a group is telling the user something false about why the
 *   group is there.
 * - `addAction` undefined → no button.
 *
 * ## Omitted when empty
 *
 * The group takes `items` rather than `children` for one reason: emptiness has
 * to be knowable. Counting `React.Children` is unreliable — a single mapped
 * fragment counts as one child whatever it contains — so the contract's
 * "omitted when empty" would have been a guess. With `items` it is a fact, and
 * the component returns `null`.
 */
export type RailGroupAddAction =
  | { label: string; href: string }
  | { label: string; onClick: () => void }
  /** Rendered disabled, with the reason exposed — never a dead control with no explanation. */
  | { label: string; disabledReason: string };

export function RailGroup<T>({
  label,
  items,
  renderItem,
  itemKey,
  collapsible = false,
  defaultOpen = true,
  count,
  addAction,
  className,
}: {
  label: string;
  items: readonly T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  itemKey: (item: T, index: number) => string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  count?: number;
  addAction?: RailGroupAddAction;
  className?: string;
}) {
  const { t } = useT();
  const reactId = useId();
  const headingId = `rail-group-${reactId}`;
  const navId = `rail-group-nav-${reactId}`;
  const [open, setOpen] = useState(defaultOpen);

  // The contract: omitted when empty, not rendered empty. A group heading with
  // nothing under it is a promise the rail cannot keep.
  if (items.length === 0) return null;

  const expanded = collapsible ? open : true;

  /*
    The count sits inside the heading so it is part of the group's accessible
    name rather than a loose number beside it. `tabular-nums` because rail
    counts change in place and proportional digits make them jitter; `bdi`
    because a Latin numeral inside an Arabic or Hebrew label is a direction
    change, and without isolation the surrounding text reorders around it.
  */
  const countNode = count === undefined ? null : (
    <bdi className="ms-1.5 font-normal tabular-nums text-muted-foreground/70">{count}</bdi>
  );

  const headingClasses =
    'hidden px-3 pb-1.5 text-micro font-semibold uppercase tracking-wider text-muted-foreground/80 lg:block';

  return (
    <section key={label} className={cn('shrink-0 lg:mb-6', className)} aria-labelledby={headingId}>
      {/* Uppercase, tracked, and quieter than the items under it — a
          group label is a signpost, not a destination. */}
      {collapsible || addAction ? (
        <div className={cn(headingClasses, 'flex items-center justify-between gap-1 pb-1.5')}>
          {collapsible ? (
            <button
              type="button"
              id={headingId}
              onClick={() => setOpen((value) => !value)}
              aria-expanded={expanded}
              aria-controls={navId}
              className="flex min-h-6 flex-1 items-center gap-1 rounded text-start uppercase tracking-wider text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* Rotates rather than swapping glyphs, so the control does not
                  change size between states and the row never reflows. */}
              <ChevronDown
                className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90 rtl:rotate-90')}
                aria-hidden
              />
              <span>{t(label)}</span>
              {countNode}
            </button>
          ) : (
            <h2 id={headingId} className="flex flex-1 items-center">
              <span>{t(label)}</span>
              {countNode}
            </h2>
          )}
          {addAction && <AddAction action={addAction} groupLabel={t(label)} />}
        </div>
      ) : (
        <h2 id={headingId} className={headingClasses}>
          {t(label)}
          {countNode}
        </h2>
      )}

      <nav
        id={navId}
        className={cn('flex gap-1 lg:block', collapsible && !expanded && 'lg:hidden')}
        aria-label={t(label)}
      >
        {items.map((item, index) => (
          <RailGroupItem key={itemKey(item, index)}>{renderItem(item, index)}</RailGroupItem>
        ))}
      </nav>
    </section>
  );
}

/**
 * A pass-through so `renderItem` output keeps its own key handling without this
 * component wrapping it in an element — wrapping would change the DOM P2 is
 * certified against.
 */
function RailGroupItem({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function AddAction({ action, groupLabel }: { action: RailGroupAddAction; groupLabel: string }) {
  const { t } = useT();
  const shared =
    'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  // The accessible name names the group, because "Add" alone in a rail of
  // several groups does not say add what, and a screen reader reads the button
  // without the heading beside it.
  const name = `${t(action.label)} — ${groupLabel}`;

  if ('disabledReason' in action) {
    /*
      Disabled, and it says why. A rail control that is dead with no explanation
      reads as broken, and the gate for this is explicit: no unexplained
      disabled control. `title` covers pointer, `aria-describedby` covers
      assistive technology, and the reason is real text rather than a tooltip
      that never appears on touch.
    */
    const reasonId = `rail-add-reason-${groupLabel.replace(/\s+/g, '-')}`;
    return (
      <>
        <button type="button" disabled aria-label={name} aria-describedby={reasonId} title={action.disabledReason} className={cn(shared, 'cursor-not-allowed opacity-50')}>
          <Plus className="size-3.5" aria-hidden />
        </button>
        <span id={reasonId} className="sr-only">{action.disabledReason}</span>
      </>
    );
  }

  if ('href' in action) {
    return (
      <Link href={action.href} aria-label={name} title={t(action.label)} className={shared}>
        <Plus className="size-3.5" aria-hidden />
      </Link>
    );
  }

  return (
    <button type="button" onClick={action.onClick} aria-label={name} title={t(action.label)} className={shared}>
      <Plus className="size-3.5" aria-hidden />
    </button>
  );
}
