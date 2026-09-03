'use client';

/**
 * Membership of the ACTIVE workspace.
 *
 * Scoped to the active workspace rather than offering a picker: the workspace
 * you are in is the one the rest of the product is showing you, and a screen
 * that could edit a workspace you are not looking at is a screen where the
 * wrong row gets changed. Switching workspace is the switcher's job.
 *
 * ## The role shown here governs membership, and says so
 *
 * `WorkspaceMember.role` decides who may manage this workspace's members. It
 * does NOT yet decide anything else — every other permission still comes from
 * the organization role. That is stated on the screen rather than left for
 * somebody to infer, because a role control that appears to govern everything
 * and governs one thing is worse than no control at all.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { PermissionNotice } from '@/components/permission-notice';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  addWorkspaceMember,
  fetchWorkspaceMembers,
  fetchWorkspaces,
  removeWorkspaceMember,
  setWorkspaceMemberRole,
  type WorkspaceMembersResponse,
} from '@/lib/data';

const ROLES = ['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'] as const;

export function WorkspaceMembers() {
  const { t } = useT();
  const [state, setState] = useState<WorkspaceMembersResponse | null>(null);
  const [single, setSingle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const [pickRole, setPickRole] = useState<string>('AGENT');

  const load = useCallback(async () => {
    const list = await fetchWorkspaces().catch(() => null);
    if (!list || !Array.isArray(list.workspaces)) return;
    // One workspace means there is nothing to manage membership OF that is not
    // simply the organization's user list, which has its own screen.
    if (list.workspaces.length < 2) { setSingle(true); setState(null); return; }
    const active = list.activeWorkspaceId
      ?? list.workspaces.find((w) => w.isDefault)?.id
      ?? list.workspaces[0]?.id;
    if (!active) return;
    setSingle(false);
    setState(await fetchWorkspaceMembers(active).catch(() => null));
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!state || !pick || busy) return;
    setBusy(true);
    try {
      await addWorkspaceMember(state.workspace.id, pick, pickRole);
      setPick('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || t('Could not add the member'));
    } finally { setBusy(false); }
  }

  async function changeRole(userId: string, role: string) {
    if (!state || busy) return;
    setBusy(true);
    try {
      await setWorkspaceMemberRole(state.workspace.id, userId, role);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || t('Could not change the role'));
    } finally { setBusy(false); }
  }

  async function remove(userId: string) {
    if (!state || busy) return;
    setBusy(true);
    try {
      const result = await removeWorkspaceMember(state.workspace.id, userId);
      // The released work is reported rather than done quietly: an assignment
      // that silently vanishes is a thread nobody knows is unowned.
      if (result.unassignedConversations > 0) {
        toast.success(t('Removed. Conversations released:') + ' ' + result.unassignedConversations);
      }
      if (userId === state.selfUserId) { window.location.reload(); return; }
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.message || t('Could not remove the member'));
    } finally { setBusy(false); }
  }

  if (single) {
    return (
      <div className="p-4" data-testid="members-single-workspace">
        <p className="text-caption text-muted-foreground">{t('This organization has one workspace, so everyone in it is already a member. Team members are managed in organization settings.')}</p>
      </div>
    );
  }

  if (!state) return null;

  return (
    <div className="flex flex-col gap-4 p-4" data-testid="workspace-members">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="text-body font-semibold">{t('Workspace members')}</h1>
        <p className="text-caption text-muted-foreground">
          {t('Who can work in')} <span className="font-medium text-foreground">{state.workspace.name}</span>
        </p>
      </header>

      {/*
        The override is stated at the point of use, never merely audited.

        An organization admin managing a workspace they do not belong to is a
        deliberate escape hatch — without it, an admin can lock themselves out
        of a workspace nobody can then administer. But an escape hatch nobody
        can see is indistinguishable from a hole, so it announces itself here
        and writes its own audit action on the server.
      */}
      {state.actingAsOverride && (
        <div
          data-testid="override-notice"
          role="status"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-caption text-warning"
        >
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {t('You are acting as organization administrator. You are not a member of this workspace, and this does not give you access to its contacts or conversations — only to who belongs to it.')}
          </span>
        </div>
      )}

      {/*
        What the role does, and what it does not.

        Said plainly because the honest answer is "less than you would assume",
        and a reader who assumes it governs everything will grant somebody
        ADMIN here believing it does more than it does.
      */}
      <p className="text-caption text-muted-foreground">
        {t('A workspace role decides who manages this workspace’s members. Everything else still follows the organization role.')}
      </p>

      {state.canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-caption font-medium">{t('Add a member')}</span>
            <select
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              data-testid="member-candidate"
              aria-label={t('Add a member')}
              className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-caption"
            >
              <option value="">{t('Choose someone')}</option>
              {state.candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-caption font-medium">{t('Workspace role')}</span>
            <select
              value={pickRole}
              onChange={(e) => setPickRole(e.target.value)}
              data-testid="member-role-new"
              aria-label={t('Workspace role')}
              className="rounded-md border border-border bg-transparent px-2 py-1.5 text-caption"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button
            type="button"
            onClick={add}
            disabled={!pick || busy}
            data-testid="member-add"
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-caption font-semibold text-primary-foreground disabled:opacity-50"
          >
            <UserPlus className="size-3.5" aria-hidden />
            {t('Add')}
          </button>
        </div>
      )}

      {/*
        Somebody who is not in the organization cannot be added here, and the
        screen says why rather than offering a control that would fail. The
        invitation flow cannot target a workspace — UserInvitation carries no
        workspaceId and acceptance lands in the default workspace — so this is
        genuinely two steps and pretending otherwise would be a lie in a button.
      */}
      {state.canManage && (
        <p className="text-caption text-muted-foreground">
          {t('Someone who is not in the organization yet has to be invited first, in organization settings. They join the default workspace, and can then be added here.')}
        </p>
      )}

      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {state.members.map((m) => (
          <li key={m.userId} data-testid={`member-${m.userId}`} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-caption font-medium">
              {m.name}
              {m.userId === state.selfUserId && (
                <span className="ms-1.5 text-micro text-muted-foreground">({t('you')})</span>
              )}
            </span>
            <select
              value={m.workspaceRole}
              disabled={!state.canManage || busy}
              onChange={(e) => changeRole(m.userId, e.target.value)}
              data-testid={`member-role-${m.userId}`}
              aria-label={`${t('Workspace role')} — ${m.name}`}
              className={cn(
                'rounded-md border border-border bg-transparent px-2 py-1 text-caption',
                !state.canManage && 'opacity-60',
              )}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {state.canManage && (
              <button
                type="button"
                onClick={() => remove(m.userId)}
                disabled={busy}
                data-testid={`member-remove-${m.userId}`}
                aria-label={`${t('Remove')} — ${m.name}`}
                className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-caption text-danger hover:bg-accent disabled:opacity-50"
              >
                <UserMinus className="size-3.5" aria-hidden />
                {m.userId === state.selfUserId ? t('Leave') : t('Remove')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {!state.canManage && (
        <PermissionNotice action={'إدارة أعضاء مساحة العمل'} who={'أدمن مساحة العمل'} />
      )}
    </div>
  );
}
