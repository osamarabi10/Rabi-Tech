'use client';

/**
 * The branch switcher.
 *
 * ## Why "branch" and not "workspace"
 *
 * The code calls this a Workspace, and the product cannot. `مساحة العمل`
 * already means the ORGANIZATION throughout this UI — the sidebar's brand menu
 * is labelled with it, the overview page summarises it, the signup page
 * promises one. Shipping a second control called the same thing, one level
 * down, would leave nobody able to say which one they meant.
 *
 * So the schema keeps Workspace and the interface says فرع / סניף / Branch. The
 * label is taken from BRANCH_LABEL below and nowhere else, so if the product
 * name for this changes it changes in one place.
 *
 * ## It does not render for a single branch
 *
 * A control with one option is noise: it occupies a place in the shell, invites
 * a click, and does nothing. Below two branches this returns null — unless the
 * organization could create one, in which case the create action is the whole
 * reason to show anything.
 */

import { useEffect, useState } from 'react';
import { Building2, Check, Plus, ChevronsUpDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UpgradeBadge } from '@/components/ui/feedback-primitives';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  activateWorkspace,
  createWorkspace,
  fetchWorkspaces,
  type WorkspaceList,
} from '@/lib/data';

/**
 * The concept's name in the interface, for anything that needs to refer to it
 * outside a t() call.
 *
 * The strings below are written as literals rather than as t(BRANCH_LABEL),
 * because the extractor only sees literals and a dynamic key would need an
 * exemption. The dictionary entry for الفرع is still the single place the
 * translations live.
 */
export const BRANCH_LABEL = 'الفرع';

export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { t } = useT();
  const [state, setState] = useState<WorkspaceList | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchWorkspaces()
      .then((data) => {
        /*
          Shape-checked, not merely truthy-checked.

          An endpoint that answers with something unexpected - a proxy error
          page, an empty array, a catch-all in a test fixture - produces a value
          that passes `if (!state)` and then throws on `.workspaces.length`,
          taking the whole shell down with it. This component sits in the
          layout, so its crash is every page.s crash. Asking for the field it
          actually needs is the difference between rendering nothing and
          rendering nothing anywhere.
        */
        if (alive) setState(Array.isArray((data as any)?.workspaces) ? data : null);
      })
      // A switcher that cannot load its own list says nothing rather than
      // claiming a fault it has not confirmed.
      .catch(() => { if (alive) setState(null); });
    return () => { alive = false; };
  }, []);

  if (!state) return null;

  const many = state.workspaces.length > 1;
  // Nothing to switch between and nothing to add: render nothing at all.
  if (!many && !state.canCreate) return null;

  const active = state.workspaces.find((w) => w.id === state.activeWorkspaceId)
    ?? state.workspaces.find((w) => w.isDefault)
    ?? state.workspaces[0];

  async function choose(id: string) {
    if (busy || id === active?.id) return;
    setBusy(true);
    try {
      await activateWorkspace(id);
      // A full reload rather than refetching in place. Every cached list on the
      // screen belongs to the branch being left — contacts, threads, counts —
      // and reconciling them one by one is a long list of chances to miss one.
      window.location.reload();
    } catch {
      setBusy(false);
      setError(t('ما زبطت تبديل الفرع'));
    }
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createWorkspace(trimmed);
      await activateWorkspace(created.id);
      window.location.reload();
    } catch (err: any) {
      setBusy(false);
      const status = err?.response?.status;
      setError(status === 402
        ? err?.response?.data?.message || t('باقتك ما بتسمح بفرع زيادة')
        : status === 409
          ? t('في فرع بنفس الاسم')
          : t('ما زبط إنشاء الفرع'));
    }
  }

  return (
    /*
      The component owns its own strip.

      Placing a bar in the layout and putting the switcher inside it would leave
      an empty bordered strip on every screen of every organization with one
      branch - which is all of them today. Returning null from here removes the
      strip with it, so there is nothing to hide and no display utility fighting
      a breakpoint to do it.
    */
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="branch-switcher"
          aria-label={t('الفرع')}
          className={cn(
            'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-caption font-semibold',
            'text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <Building2 className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{active?.name ?? t('الفرع')}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{t('الفرع')}</DropdownMenuLabel>

        {state.workspaces.map((workspace) => (
          <DropdownMenuItem
            key={workspace.id}
            data-testid={`branch-option-${workspace.id}`}
            onSelect={() => choose(workspace.id)}
            className="flex items-center justify-between gap-2"
          >
            <span className="truncate">{workspace.name}</span>
            {workspace.id === active?.id && <Check className="size-3.5 shrink-0" aria-hidden />}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/*
          The create action is always rendered, never hidden.

          A control that disappears for a subscriber who cannot use it is
          indistinguishable from a feature that does not exist, so the plan
          ceiling is shown as a badge on a disabled action instead. That is the
          shipped rule for restricted actions and the reason the endpoint
          answers 402 rather than 403.
        */}
        {state.canCreate ? (
          creating ? (
            <div className="flex flex-col gap-1.5 px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder={t('اسم الفرع')}
                aria-label={t('اسم الفرع')}
                data-testid="branch-name-input"
                className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <button
                type="button"
                onClick={submit}
                disabled={busy || !name.trim()}
                data-testid="branch-create-submit"
                className="rounded-md bg-primary px-2 py-1 text-caption font-semibold text-primary-foreground disabled:opacity-50"
              >
                {t('إنشاء')}
              </button>
            </div>
          ) : (
            <DropdownMenuItem
              data-testid="branch-create"
              onSelect={(e) => { e.preventDefault(); setCreating(true); }}
              className="flex items-center gap-2"
            >
              <Plus className="size-3.5" aria-hidden />
              {t('فرع جديد')}
            </DropdownMenuItem>
          )
        ) : (
          <div
            data-testid="branch-create-locked"
            className="flex items-center justify-between gap-2 px-2 py-1.5 text-caption text-muted-foreground"
          >
            <span className="flex items-center gap-2">
              <Plus className="size-3.5 opacity-50" aria-hidden />
              {t('فرع جديد')}
            </span>
            <UpgradeBadge label={t('ترقية')} />
          </div>
        )}

        {error && (
          <p role="alert" className="px-2 pb-1.5 text-micro text-danger">{error}</p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    </div>
  );
}
