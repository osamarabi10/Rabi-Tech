'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Check, Clock3, Loader2, Mail, MoreHorizontal, Search, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchSeatUsage, fetchTeams, fetchUserInvitations, fetchWorkspaceUsers,
  inviteWorkspaceUser, revokeUserInvitation, updateSystemUser,
  type SeatUsage, type SystemUser, type Team, type UserInvitation, type WorkspaceUserCapabilities,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { ToggleCard, UpgradeBadge } from '@/components/ui/feedback-primitives';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';

const WORKER_ROLES = ['SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'] as const;
const EMPTY_CAPABILITIES: WorkspaceUserCapabilities = { canInvite: false, canManage: false, managerInviteRole: 'AGENT', maskPhoneAndEmail: false, callsAvailable: false };

type EditForm = {
  role: string;
  primaryTeamId: string;
  isActive: boolean;
  restrictContactVisibility: boolean;
  contactVisibilityScope: 'TEAM' | 'SELF';
  restrictCalls: boolean;
  restrictWorkflows: boolean;
  maskPhoneAndEmail: boolean;
};

function editForm(user: SystemUser): EditForm {
  return {
    role: user.role,
    primaryTeamId: user.primaryTeamId || '',
    isActive: user.isActive,
    restrictContactVisibility: !!user.restrictContactVisibility,
    contactVisibilityScope: user.contactVisibilityScope || 'TEAM',
    restrictCalls: !!user.restrictCalls,
    restrictWorkflows: !!user.restrictWorkflows,
    maskPhoneAndEmail: !!user.maskPhoneAndEmail,
  };
}

export function WorkspaceUsers() {
  const { t, locale } = useT();
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [invitations, setInvitations] = useState<UserInvitation[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'members' | 'pending'>('members');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [invite, setInvite] = useState({ name: '', email: '', role: 'AGENT', primaryTeamId: '' });
  const [selected, setSelected] = useState<SystemUser | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const [roster, teamRows, seatUsage] = await Promise.all([fetchWorkspaceUsers(), fetchTeams(), fetchSeatUsage()]);
      setUsers(roster.users);
      setCapabilities(roster.capabilities);
      setTeams(teamRows);
      setSeats(seatUsage);
      setInvitations(roster.capabilities.canInvite ? await fetchUserInvitations() : []);
    } catch (error: any) {
      setFailed(true);
      if (error?.response?.status === 403) toast.error(t('You do not have access to workspace users'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const filteredUsers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? users.filter((user) => `${user.name} ${user.email} ${user.role} ${user.primaryTeam?.name || ''}`.toLowerCase().includes(needle)) : users;
  }, [query, users]);
  const filteredInvitations = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? invitations.filter((item) => `${item.name || ''} ${item.email} ${item.role}`.toLowerCase().includes(needle)) : invitations;
  }, [invitations, query]);

  const roleLabel = (role: string) => t({ ADMIN: 'Owner', SUPERVISOR: 'Manager', AGENT: 'Agent', VIEWER: 'Viewer', FINANCE: 'Finance' }[role] || role);
  const presenceLabel = (presence?: string) => t({ ONLINE: 'Online', AWAY: 'Away', OFFLINE: 'Offline', INACTIVE: 'Inactive' }[presence || 'OFFLINE'] || 'Offline');
  const date = (value?: string | null) => value ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-PS' : locale === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('Never');

  const submitInvitation = async () => {
    if (!invite.email.trim()) return toast.error(t('Email is required'));
    setInviteSaving(true);
    try {
      await inviteWorkspaceUser({ email: invite.email, name: invite.name || undefined, role: capabilities.canManage ? invite.role : 'AGENT', primaryTeamId: invite.primaryTeamId || null });
      toast.success(t('Invitation sent'));
      setInvite({ name: '', email: '', role: 'AGENT', primaryTeamId: '' });
      setInviteOpen(false);
      await load();
      setView('pending');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not send invitation'));
    } finally {
      setInviteSaving(false);
    }
  };

  const openEditor = (user: SystemUser) => {
    if (!capabilities.canManage || user.role === 'ADMIN') return;
    setSelected(user);
    setForm(editForm(user));
  };

  const saveUser = async () => {
    if (!selected || !form) return;
    setSaving(true);
    try {
      await updateSystemUser(selected.id, {
        role: form.role, primaryTeamId: form.primaryTeamId || null, teamIds: form.primaryTeamId ? [form.primaryTeamId] : [],
        isActive: form.isActive, restrictContactVisibility: form.restrictContactVisibility,
        contactVisibilityScope: form.contactVisibilityScope, restrictCalls: form.restrictCalls,
        restrictWorkflows: form.restrictWorkflows, maskPhoneAndEmail: form.maskPhoneAndEmail,
      });
      toast.success(t('User access saved'));
      setSelected(null);
      setForm(null);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not save user access'));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await revokeUserInvitation(id);
      setInvitations((items) => items.filter((item) => item.id !== id));
      toast.success(t('Invitation revoked'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not revoke invitation'));
    }
  };

  if (loading) return <LayoutSkeleton label={t('Loading workspace users')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load workspace users')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;
  const seatPercent = seats?.limit ? Math.min(100, Math.round((seats.used / seats.limit) * 100)) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">{t('Workspace users')}</h1><p className="mt-1 text-caption text-muted-foreground">{t('Invite people, review presence, and control what each user can access.')}</p></div>
        {capabilities.canInvite && <Button onClick={() => setInviteOpen(true)} disabled={!!seats?.atLimit} title={seats?.atLimit ? t('Upgrade the plan to add another user') : undefined}><UserPlus className="size-4" />{t('Invite user')}</Button>}
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="space-y-3 border-b border-border px-4 py-3 sm:px-6">
          {seats && <div className="flex flex-wrap items-center gap-3 text-caption"><span className="font-medium">{t('Seats')} · {seats.used}/{seats.limit ?? '∞'}</span><div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={seatPercent} aria-valuemin={0} aria-valuemax={100}><div className={cn('h-full', seats.atLimit ? 'bg-warning' : 'bg-primary')} style={{ width: `${seatPercent}%` }} /></div><span className="text-muted-foreground">{seats.planName}</span>{seats.atLimit && <span className="text-warning">{t('No seats available')}</span>}</div>}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="inline-flex w-fit rounded-md bg-muted p-0.5" role="tablist" aria-label={t('User list view')}><button type="button" role="tab" aria-selected={view === 'members'} onClick={() => setView('members')} className={cn('rounded px-3 py-1.5 text-caption font-medium', view === 'members' && 'bg-card shadow-sm')}>{t('Members')} <span className="text-muted-foreground">{users.length}</span></button>{capabilities.canInvite && <button type="button" role="tab" aria-selected={view === 'pending'} onClick={() => setView('pending')} className={cn('rounded px-3 py-1.5 text-caption font-medium', view === 'pending' && 'bg-card shadow-sm')}>{t('Pending')} <span className="text-muted-foreground">{invitations.length}</span></button>}</div>
            <div className="relative sm:ms-auto sm:w-72"><Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="ps-9" placeholder={t('Search users')} aria-label={t('Search users')} /></div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {view === 'members' ? filteredUsers.length ? <div>
            <div className="hidden grid-cols-[minmax(220px,2fr)_minmax(130px,1fr)_minmax(120px,1fr)_minmax(170px,1fr)_40px] gap-3 border-b border-border bg-muted/30 px-6 py-2 text-micro font-semibold text-muted-foreground sm:grid"><span>{t('User')}</span><span>{t('Access level')}</span><span>{t('Team')}</span><span>{t('Presence')}</span><span className="sr-only">{t('Actions')}</span></div>
            {filteredUsers.map((user) => <button key={user.id} type="button" onClick={() => openEditor(user)} disabled={!capabilities.canManage || user.role === 'ADMIN'} className="grid w-full grid-cols-2 items-center gap-3 border-b border-border px-4 py-3 text-start hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-transparent sm:grid-cols-[minmax(220px,2fr)_minmax(130px,1fr)_minmax(120px,1fr)_minmax(170px,1fr)_40px] sm:px-6">
              <span className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1"><span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-caption font-semibold text-primary">{user.name.slice(0, 1).toUpperCase()}</span><span className="min-w-0"><span className="block truncate text-small font-medium">{user.name}</span><span className="block truncate text-caption text-muted-foreground" dir="ltr">{user.email}</span></span></span>
              <span><Badge variant="outline">{roleLabel(user.role)}</Badge></span><span className="truncate text-caption text-muted-foreground">{user.primaryTeam?.name || t('No team')}</span>
              <span className="col-span-2 flex min-w-0 items-center gap-2 text-caption sm:col-span-1"><span className={cn('size-2 shrink-0 rounded-full', user.presence === 'ONLINE' ? 'bg-success' : user.presence === 'AWAY' ? 'bg-warning' : 'bg-muted-foreground/40')} /><span><span className="block font-medium">{presenceLabel(user.presence)}</span><span className="block truncate text-micro text-muted-foreground">{t('Last seen')}: {date(user.lastSeen)}</span></span></span>
              <span className="hidden sm:block">{capabilities.canManage && user.role !== 'ADMIN' ? <MoreHorizontal className="size-4 text-muted-foreground" /> : <ShieldCheck className="size-4 text-muted-foreground" />}</span>
            </button>)}
          </div> : <EmptyState icon={Users} title={t('No users found')} description={t('Try a different search.')} /> : filteredInvitations.length ? <div className="divide-y divide-border">{filteredInvitations.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6"><span className="flex size-8 items-center justify-center rounded-full bg-warning/10 text-warning"><Mail className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-small font-medium">{item.name || item.email}</span><span className="block truncate text-caption text-muted-foreground" dir="ltr">{item.email}</span></span><Badge variant="outline">{roleLabel(item.role)}</Badge><span className="text-caption text-muted-foreground"><Clock3 className="me-1 inline size-3.5" />{t('Expires')} {date(item.expiresAt)}</span>{capabilities.canManage && <Button variant="ghost" size="sm" onClick={() => revoke(item.id)}><Ban className="size-4" />{t('Revoke')}</Button>}</div>)}</div> : <EmptyState icon={Mail} title={t('No pending invitations')} description={t('New invitations will appear here until they are accepted.')} />}
        </div>
      </div>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t('Invite user')}</DialogTitle></DialogHeader><div className="space-y-4"><div className="space-y-1.5"><Label htmlFor="invite-name">{t('Name')} <span className="text-muted-foreground">({t('Optional')})</span></Label><Input id="invite-name" value={invite.name} onChange={(event) => setInvite((value) => ({ ...value, name: event.target.value }))} /></div><div className="space-y-1.5"><Label htmlFor="invite-email">{t('Email')}</Label><Input id="invite-email" type="email" dir="ltr" value={invite.email} onChange={(event) => setInvite((value) => ({ ...value, email: event.target.value }))} /></div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>{t('Access level')}</Label><Select value={capabilities.canManage ? invite.role : 'AGENT'} disabled={!capabilities.canManage} onValueChange={(role) => setInvite((value) => ({ ...value, role }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(capabilities.canManage ? WORKER_ROLES : ['AGENT']).map((role) => <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>)}</SelectContent></Select>{!capabilities.canManage && <p className="text-micro text-muted-foreground">{t('Managers can invite Agents only.')}</p>}</div><div className="space-y-1.5"><Label>{t('Team')}</Label><Select value={invite.primaryTeamId || 'none'} onValueChange={(value) => setInvite((state) => ({ ...state, primaryTeamId: value === 'none' ? '' : value }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('No team')}</SelectItem>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div></div><p className="text-caption text-muted-foreground">{t('The user will choose a password from a secure link that expires after seven days.')}</p></div><DialogFooter><Button variant="outline" onClick={() => setInviteOpen(false)}>{t('Cancel')}</Button><Button onClick={submitInvitation} disabled={inviteSaving || !invite.email.trim()}>{inviteSaving ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}{t('Send invitation')}</Button></DialogFooter></DialogContent></Dialog>

      <Drawer open={!!selected} onOpenChange={(open) => { if (!open) { setSelected(null); setForm(null); } }}><DrawerContent closeLabel={t('Close')}><DrawerHeader><DrawerTitle className="text-base font-semibold">{selected?.name}</DrawerTitle><DrawerDescription>{selected?.email}</DrawerDescription></DrawerHeader>{form && <DrawerBody className="space-y-6"><section className="space-y-3"><h2 className="text-small font-semibold">{t('Access')}</h2><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label>{t('Access level')}</Label><Select value={form.role} onValueChange={(role) => setForm((value) => value && ({ ...value, role }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{WORKER_ROLES.map((role) => <SelectItem key={role} value={role}>{roleLabel(role)}</SelectItem>)}</SelectContent></Select></div><div className="space-y-1.5"><Label>{t('Team')}</Label><Select value={form.primaryTeamId || 'none'} onValueChange={(value) => setForm((state) => state && ({ ...state, primaryTeamId: value === 'none' ? '' : value }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">{t('No team')}</SelectItem>{teams.map((team) => <SelectItem key={team.id} value={team.id}>{team.name}</SelectItem>)}</SelectContent></Select></div></div></section><section><h2 className="text-small font-semibold">{t('Restrictions')}</h2><ToggleCard title={t('Restrict contact visibility')} description={t('Limit this user to contacts handled by their team or assigned directly to them.')} checked={form.restrictContactVisibility} onCheckedChange={(checked) => setForm((value) => value && ({ ...value, restrictContactVisibility: checked }))} />{form.restrictContactVisibility && <div className="border-b border-border pb-4"><Label>{t('Visible contacts')}</Label><Select value={form.contactVisibilityScope} onValueChange={(scope: 'TEAM' | 'SELF') => setForm((value) => value && ({ ...value, contactVisibilityScope: scope }))}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="TEAM">{t('Anyone in the user’s team')}</SelectItem><SelectItem value="SELF">{t('Assigned to this user only')}</SelectItem></SelectContent></Select></div>}<ToggleCard title={t('Restrict calls')} description={t('Prevent this user from starting or receiving calls.')} checked={form.restrictCalls} onCheckedChange={() => {}} disabled disabledReason={t('Calling is not available until a calling provider is connected.')} /><ToggleCard title={t('Hide Workflows button')} description={t('Remove workflow navigation and block workflow API access for this user.')} checked={form.restrictWorkflows} onCheckedChange={(checked) => setForm((value) => value && ({ ...value, restrictWorkflows: checked }))} /><div className="relative"><ToggleCard title={t('Mask phone numbers and email addresses')} description={t('Contact details are masked in Contacts and Inbox responses.')} checked={form.maskPhoneAndEmail} onCheckedChange={(checked) => setForm((value) => value && ({ ...value, maskPhoneAndEmail: checked }))} disabled={!capabilities.maskPhoneAndEmail} disabledReason={!capabilities.maskPhoneAndEmail ? t('Available on Business and Enterprise plans.') : undefined} />{!capabilities.maskPhoneAndEmail && <UpgradeBadge label={t('Upgrade')} className="absolute end-12 top-4" />}</div></section><section className="border-t border-border pt-4"><h2 className="text-small font-semibold">{t('Account status')}</h2><ToggleCard title={t('Active user')} description={t('Inactive users are signed out and no longer consume a seat.')} checked={form.isActive} onCheckedChange={(checked) => setForm((value) => value && ({ ...value, isActive: checked }))} /></section></DrawerBody>}<DrawerFooter><Button variant="outline" onClick={() => { setSelected(null); setForm(null); }}>{t('Cancel')}</Button><Button onClick={saveUser} disabled={saving}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t('Save')}</Button></DrawerFooter></DrawerContent></Drawer>
    </div>
  );
}
