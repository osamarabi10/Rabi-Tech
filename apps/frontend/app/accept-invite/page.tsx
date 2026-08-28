'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, KeyRound, Loader2, Mail, Users } from 'lucide-react';
import { acceptWorkspaceInvitation, fetchInvitationPreview, type InvitationPreview } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';

function InvitationForm() {
  const { t } = useT();
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!token) {
      setError(t('Invitation is invalid or expired'));
      setLoading(false);
      return;
    }
    fetchInvitationPreview(token)
      .then((value) => { setInvitation(value); setName(value.name || ''); })
      .catch((requestError) => setError(requestError?.response?.data?.error || t('Invitation is invalid or expired')))
      .finally(() => setLoading(false));
  }, [t, token]);

  const accept = async () => {
    setSaving(true);
    setError('');
    try {
      await acceptWorkspaceInvitation(token, { name: name || undefined, password });
      setAccepted(true);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.error || t('Could not accept invitation'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LayoutSkeleton label={t('Loading invitation')} />;
  if (!invitation) return <ErrorState title={error || t('Invitation is invalid or expired')} retryLabel={t('Go to sign in')} onRetry={() => { window.location.href = '/login'; }} />;
  if (accepted) return <div className="space-y-5 text-center"><CheckCircle2 className="mx-auto size-10 text-success" /><div><h1 className="text-xl font-semibold">{t('You joined the workspace')}</h1><p className="mt-2 text-small text-muted-foreground">{t('Your account is ready. Sign in with your email and password.')}</p></div><Button asChild className="w-full"><Link href="/login">{t('Go to sign in')}</Link></Button></div>;

  return <div className="space-y-5">
    <div><h1 className="text-xl font-semibold">{t('Join workspace')}</h1><p className="mt-2 text-small text-muted-foreground">{invitation.invitedByName} {t('invited you to join')} <strong className="text-foreground">{invitation.workspaceName}</strong>.</p></div>
    <div className="space-y-2 border-y border-border py-4 text-caption"><p className="flex items-center gap-2"><Mail className="size-4 text-muted-foreground" /><span dir="ltr">{invitation.email}</span></p><p className="flex items-center gap-2"><Users className="size-4 text-muted-foreground" />{invitation.teamName || t('No team')} · {t(invitation.role === 'SUPERVISOR' ? 'Manager' : invitation.role === 'AGENT' ? 'Agent' : invitation.role === 'VIEWER' ? 'Viewer' : 'Finance')}</p></div>
    {!invitation.requiresExistingPassword && <div className="space-y-1.5"><Label htmlFor="accepted-name">{t('Name')}</Label><Input id="accepted-name" value={name} onChange={(event) => setName(event.target.value)} /></div>}
    <div className="space-y-1.5"><Label htmlFor="accepted-password">{t(invitation.requiresExistingPassword ? 'Current account password' : 'Create password')}</Label><Input id="accepted-password" type="password" dir="ltr" value={password} onChange={(event) => setPassword(event.target.value)} /><p className="text-micro text-muted-foreground">{t(invitation.requiresExistingPassword ? 'Use your existing RabiTech password to add this workspace.' : 'Use at least 10 characters.')}</p></div>
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    <Button className="w-full" onClick={accept} disabled={saving || !password || (!invitation.requiresExistingPassword && name.trim().length < 2)}>{saving ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}{t('Accept invitation')}</Button>
  </div>;
}

export default function AcceptInvitePage() {
  return <main className="flex min-h-screen items-center justify-center bg-background p-4"><div className="w-full max-w-md"><div className="mb-6 flex justify-center"><BrandLogo /></div><div className="rounded-lg border border-border bg-card p-6 shadow-card"><Suspense fallback={<LayoutSkeleton label="Loading invitation" />}><InvitationForm /></Suspense></div></div></main>;
}
