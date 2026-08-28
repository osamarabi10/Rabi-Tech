'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Shuffle,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createTeam,
  deleteTeam,
  fetchTeams,
  fetchWorkspaceUsers,
  updateTeam,
  updateTeamMembers,
  type AssignmentStrategy,
  type SystemUser,
  type Team,
  type WorkspaceUserCapabilities,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { DangerZone } from '@/components/ui/feedback-primitives';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ListToolbar, RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton, NoResultsState } from '@/components/ui/operational-state';
import { Textarea } from '@/components/ui/textarea';

const EMPTY_CAPABILITIES: WorkspaceUserCapabilities = {
  canInvite: false,
  canManage: false,
  managerInviteRole: 'AGENT',
  maskPhoneAndEmail: false,
  callsAvailable: false,
};

const TEAM_COLORS = ['#2563EB', '#059669', '#D97706', '#DC2626', '#0891B2', '#7C3AED'];
const STRATEGIES: AssignmentStrategy[] = ['NONE', 'ROUND_ROBIN', 'LEAST_OPEN'];

type TeamForm = {
  name: string;
  description: string;
  color: string;
  isDefault: boolean;
  assignmentStrategy: AssignmentStrategy;
  maxConcurrentPerAgent: string;
  memberIds: string[];
};

function toForm(team: Team): TeamForm {
  return {
    name: team.name,
    description: team.description || '',
    color: team.color,
    isDefault: team.isDefault,
    assignmentStrategy: team.assignmentStrategy || 'NONE',
    maxConcurrentPerAgent: team.maxConcurrentPerAgent == null ? '' : String(team.maxConcurrentPerAgent),
    memberIds: team.memberIds || [],
  };
}

function teamDependencies(team: Team): number {
  return (team._count?.members || 0) + (team._count?.conversations || 0) + (team._count?.sessions || 0);
}

export function WorkspaceTeams() {
  const { t } = useT();
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTeam, setNewTeam] = useState({ name: '', description: '', color: TEAM_COLORS[0] });
  const [selected, setSelected] = useState<Team | null>(null);
  const [form, setForm] = useState<TeamForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [teamRows, roster] = await Promise.all([fetchTeams(), fetchWorkspaceUsers()]);
      setTeams(teamRows);
      setUsers(roster.users);
      setCapabilities(roster.capabilities);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filteredTeams = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return teams;
    return teams.filter((team) => `${team.name} ${team.description || ''}`.toLowerCase().includes(needle));
  }, [query, teams]);

  const filteredUsers = useMemo(() => {
    const needle = memberQuery.trim().toLowerCase();
    if (!needle) return users;
    return users.filter((user) => `${user.name} ${user.email} ${user.role}`.toLowerCase().includes(needle));
  }, [memberQuery, users]);

  const strategyLabel = (strategy: AssignmentStrategy) => t({
    NONE: 'Manual assignment',
    ROUND_ROBIN: 'Round robin',
    LEAST_OPEN: 'Least open conversations',
  }[strategy]);

  const roleLabel = (role: string) => t({
    ADMIN: 'Owner',
    SUPERVISOR: 'Manager',
    AGENT: 'Agent',
    VIEWER: 'Viewer',
    FINANCE: 'Finance',
  }[role] || role);

  const openEditor = (team: Team) => {
    setSelected(team);
    setForm(toForm(team));
    setMemberQuery('');
  };

  const submitCreate = async () => {
    if (!newTeam.name.trim()) return;
    setCreating(true);
    try {
      const created = await createTeam({
        name: newTeam.name.trim(),
        description: newTeam.description.trim() || undefined,
        color: newTeam.color,
      });
      toast.success(t('Team created'));
      setCreateOpen(false);
      setNewTeam({ name: '', description: '', color: TEAM_COLORS[0] });
      await load();
      openEditor({ ...created, memberIds: [], _count: { members: 0, conversations: 0, sessions: 0 } });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not create team'));
    } finally {
      setCreating(false);
    }
  };

  const save = async () => {
    if (!selected || !form || !form.name.trim()) return;
    const cap = form.maxConcurrentPerAgent.trim();
    if (cap && (!Number.isInteger(Number(cap)) || Number(cap) < 1)) {
      toast.error(t('Conversation limit must be a positive whole number'));
      return;
    }

    setSaving(true);
    try {
      await updateTeam(selected.id, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        color: form.color,
        isDefault: form.isDefault,
        assignmentStrategy: form.assignmentStrategy,
        maxConcurrentPerAgent: cap ? Number(cap) : null,
      });
      await updateTeamMembers(selected.id, form.memberIds);
      toast.success(t('Team saved'));
      setSelected(null);
      setForm(null);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not save team'));
    } finally {
      setSaving(false);
    }
  };

  const requestDelete = (team: Team) => {
    if (team.isDefault) {
      toast.error(t('Choose another default team before deleting this one.'));
      return;
    }
    if (teamDependencies(team) > 0) {
      toast.error(t('Move members, conversations, and channels before deleting this team.'));
      return;
    }
    setDeleteTarget(team);
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteTeam(deleteTarget.id);
      toast.success(t('Team deleted'));
      if (selected?.id === deleteTarget.id) {
        setSelected(null);
        setForm(null);
      }
      setDeleteTarget(null);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not delete team'));
    } finally {
      setDeleting(false);
    }
  };

  const toggleMember = (userId: string) => {
    setForm((current) => {
      if (!current) return current;
      const selectedMember = current.memberIds.includes(userId);
      return {
        ...current,
        memberIds: selectedMember
          ? current.memberIds.filter((id) => id !== userId)
          : [...current.memberIds, userId],
      };
    });
  };

  if (loading) return <LayoutSkeleton label={t('Loading teams')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load teams')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{t('Teams')}</h1>
          <p className="mt-1 text-caption text-muted-foreground">{t('Group users for shared inbox access, routing, reports, and reusable resources.')}</p>
        </div>
        {capabilities.canManage ? (
          <Button type="button" onClick={() => setCreateOpen(true)}><Plus className="size-4" />{t('New team')}</Button>
        ) : (
          <span className="flex items-center gap-2 text-caption text-muted-foreground"><ShieldCheck className="size-4" />{t('Only workspace owners can change teams.')}</span>
        )}
      </header>

      <ListToolbar
        searchValue={query}
        onSearchChange={setQuery}
        searchLabel={t('Search teams')}
        clearSearchLabel={t('Clear search')}
      />

      <div className="min-h-0 flex-1 overflow-auto">
        {!teams.length ? (
          <EmptyState icon={UsersRound} title={t('No teams yet')} description={t('Create a team to share inbox access and route conversations.')} />
        ) : !filteredTeams.length ? (
          <NoResultsState title={t('No teams found')} description={t('Try a different search.')} clearLabel={t('Clear search')} onClear={() => setQuery('')} />
        ) : (
          <div>
            <div className="hidden grid-cols-[minmax(220px,2fr)_minmax(140px,1fr)_100px_110px_110px_40px] gap-3 border-b border-border bg-muted/30 px-6 py-2 text-micro font-semibold text-muted-foreground md:grid">
              <span>{t('Team')}</span><span>{t('Routing')}</span><span>{t('Members')}</span><span>{t('Channels')}</span><span>{t('Conversations')}</span><span className="sr-only">{t('Actions')}</span>
            </div>
            {filteredTeams.map((team) => (
              <div key={team.id} className="grid grid-cols-2 items-center gap-3 border-b border-border px-4 py-3 md:grid-cols-[minmax(220px,2fr)_minmax(140px,1fr)_100px_110px_110px_40px] md:px-6">
                <button type="button" onClick={() => openEditor(team)} className="col-span-2 flex min-w-0 items-center gap-3 text-start md:col-span-1">
                  <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: team.color }} aria-hidden />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2"><span className="truncate text-small font-medium">{team.name}</span>{team.isDefault && <Badge variant="outline">{t('Default')}</Badge>}</span>
                    {team.description && <span className="mt-0.5 block truncate text-caption text-muted-foreground">{team.description}</span>}
                  </span>
                </button>
                <span className="flex items-center gap-1.5 text-caption"><Shuffle className="size-3.5 text-muted-foreground" />{strategyLabel(team.assignmentStrategy || 'NONE')}</span>
                <span className="text-caption"><span className="font-medium numeric">{team._count?.members || 0}</span> <span className="text-muted-foreground md:hidden">{t('Members')}</span></span>
                <span className="text-caption"><span className="font-medium numeric">{team._count?.sessions || 0}</span> <span className="text-muted-foreground md:hidden">{t('Channels')}</span></span>
                <span className="text-caption"><span className="font-medium numeric">{team._count?.conversations || 0}</span> <span className="text-muted-foreground md:hidden">{t('Conversations')}</span></span>
                <span className="justify-self-end">
                  {capabilities.canManage ? <RowOverflowMenu label={t('Team actions')} actions={[
                    { label: t('Edit team'), icon: Pencil, onSelect: () => openEditor(team) },
                    { label: t('Delete team'), icon: Trash2, destructive: true, onSelect: () => requestDelete(team) },
                  ]} /> : <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => openEditor(team)} aria-label={t('View team')}><Pencil className="size-4" /></Button>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t('New team')}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="new-team-name">{t('Team name')}</Label><Input id="new-team-name" autoFocus value={newTeam.name} onChange={(event) => setNewTeam((value) => ({ ...value, name: event.target.value }))} /></div>
            <div className="space-y-1.5"><Label htmlFor="new-team-description">{t('Description')} <span className="text-muted-foreground">({t('Optional')})</span></Label><Textarea id="new-team-description" value={newTeam.description} onChange={(event) => setNewTeam((value) => ({ ...value, description: event.target.value }))} maxLength={500} /></div>
            <ColorPicker value={newTeam.color} onChange={(color) => setNewTeam((current) => ({ ...current, color }))} label={t('Team color')} />
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setCreateOpen(false)}>{t('Cancel')}</Button><Button onClick={submitCreate} disabled={creating || !newTeam.name.trim()}>{creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}{t('Create team')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Drawer open={!!selected} onOpenChange={(open) => { if (!open) { setSelected(null); setForm(null); } }}>
        <DrawerContent closeLabel={t('Close')}>
          <DrawerHeader><DrawerTitle className="text-base font-semibold">{selected?.name}</DrawerTitle><DrawerDescription>{capabilities.canManage ? t('Edit members and conversation routing.') : t('Review members and conversation routing.')}</DrawerDescription></DrawerHeader>
          {form && <DrawerBody className="space-y-7">
            <fieldset disabled={!capabilities.canManage} className="space-y-4 disabled:opacity-75">
              <legend className="text-small font-semibold">{t('Team details')}</legend>
              <div className="space-y-1.5"><Label htmlFor="team-name">{t('Team name')}</Label><Input id="team-name" value={form.name} onChange={(event) => setForm((value) => value && ({ ...value, name: event.target.value }))} /></div>
              <div className="space-y-1.5"><Label htmlFor="team-description">{t('Description')}</Label><Textarea id="team-description" value={form.description} onChange={(event) => setForm((value) => value && ({ ...value, description: event.target.value }))} maxLength={500} /></div>
              <ColorPicker value={form.color} onChange={(color) => setForm((value) => value && ({ ...value, color }))} label={t('Team color')} />
              <label className="flex items-start gap-3 border-t border-border pt-4"><input type="checkbox" className="mt-1 size-4 accent-primary" checked={form.isDefault} disabled={form.isDefault} onChange={(event) => setForm((value) => value && ({ ...value, isDefault: event.target.checked }))} /><span><span className="block text-small font-medium">{t('Default team')}</span><span className="mt-0.5 block text-caption text-muted-foreground">{form.isDefault ? t('Choose another team as default before changing this one.') : t('New channels and users can use this team by default.')}</span></span></label>
            </fieldset>

            <fieldset disabled={!capabilities.canManage} className="space-y-3 disabled:opacity-75">
              <legend className="text-small font-semibold">{t('Automatic assignment')}</legend>
              <p className="text-caption text-muted-foreground">{t('Choose how new conversations are distributed among active team members.')}</p>
              <div className="grid grid-cols-3 rounded-md border border-border p-1" role="group" aria-label={t('Assignment strategy')}>
                {STRATEGIES.map((strategy) => <button key={strategy} type="button" aria-pressed={form.assignmentStrategy === strategy} onClick={() => setForm((value) => value && ({ ...value, assignmentStrategy: strategy }))} className={cn('min-h-10 rounded px-1.5 text-micro font-medium', form.assignmentStrategy === strategy ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')}>{strategyLabel(strategy)}</button>)}
              </div>
              <div className="space-y-1.5"><Label htmlFor="conversation-cap">{t('Conversation limit per agent')}</Label><Input id="conversation-cap" type="number" min={1} inputMode="numeric" disabled={form.assignmentStrategy === 'NONE' || !capabilities.canManage} value={form.maxConcurrentPerAgent} onChange={(event) => setForm((value) => value && ({ ...value, maxConcurrentPerAgent: event.target.value }))} placeholder={t('Unlimited')} /><p className="text-caption text-muted-foreground">{t('Away users and users at the limit are skipped. If nobody is available, the conversation remains in the team queue.')}</p></div>
            </fieldset>

            <section className="space-y-3">
              <div><h2 className="text-small font-semibold">{t('Team members')}</h2><p className="mt-1 text-caption text-muted-foreground">{t('Members receive team inbox access and can be selected by automatic assignment.')}</p></div>
              <Input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} placeholder={t('Search users')} aria-label={t('Search users')} />
              <div className="divide-y divide-border border-y border-border">
                {filteredUsers.map((user) => <label key={user.id} className="flex items-center gap-3 py-3">
                  <input type="checkbox" className="size-4 accent-primary" checked={form.memberIds.includes(user.id)} disabled={!capabilities.canManage} onChange={() => toggleMember(user.id)} />
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-caption font-semibold text-primary">{user.name.slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-small font-medium">{user.name}</span><span className="block truncate text-caption text-muted-foreground" dir="ltr">{user.email}</span></span>
                  <Badge variant="outline">{roleLabel(user.role)}</Badge>
                </label>)}
                {!filteredUsers.length && <p className="py-6 text-center text-caption text-muted-foreground">{t('No users found')}</p>}
              </div>
            </section>

            {capabilities.canManage && selected && <DangerZone title={t('Delete team')} description={selected.isDefault ? t('Choose another default team before deleting this one.') : teamDependencies(selected) ? t('Move members, conversations, and channels before deleting this team.') : t('Deleting this team cannot be undone.')}><Button type="button" variant="destructive" disabled={selected.isDefault || teamDependencies(selected) > 0} onClick={() => setDeleteTarget(selected)}><Trash2 className="size-4" />{t('Delete team')}</Button></DangerZone>}
          </DrawerBody>}
          <DrawerFooter><Button variant="outline" onClick={() => { setSelected(null); setForm(null); }}>{t('Close')}</Button>{capabilities.canManage && <Button onClick={save} disabled={saving || !form?.name.trim()}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t('Save')}</Button>}</DrawerFooter>
        </DrawerContent>
      </Drawer>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title={t('Delete team')} description={`${t('This permanently deletes')} ${deleteTarget?.name || ''}. ${t('This action cannot be undone.')}`} cancelLabel={t('Cancel')} confirmLabel={t('Delete team')} onConfirm={remove} busy={deleting} />
    </div>
  );
}

function ColorPicker({ value, onChange, label }: { value: string; onChange: (color: string) => void; label: string }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {TEAM_COLORS.map((color) => <button key={color} type="button" onClick={() => onChange(color)} aria-label={color} aria-pressed={value.toUpperCase() === color} className={cn('relative flex size-8 items-center justify-center rounded-full border-2', value.toUpperCase() === color ? 'border-foreground' : 'border-transparent')}><span className="size-5 rounded-full" style={{ backgroundColor: color }} />{value.toUpperCase() === color && <Check className="absolute size-3 text-white" />}</button>)}
      </div>
    </div>
  );
}
