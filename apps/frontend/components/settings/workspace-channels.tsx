'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  PowerOff,
  QrCode,
  Radio,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  disconnectSession,
  fetchChannelCapabilities,
  fetchSessionQR,
  fetchSessions,
  fetchTeams,
  fetchWorkspaceUsers,
  setActiveChannel,
  type ChannelCapabilities,
  type Session,
  type SessionQR,
  type Team,
  type WorkspaceUserCapabilities,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DangerZone } from '@/components/ui/feedback-primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { MetaChannelCard } from '@/components/settings/meta-channel-card';
import { ChannelCapabilitiesPanel } from '@/components/settings/channel-capabilities-panel';

const EMPTY_CAPABILITIES: WorkspaceUserCapabilities = {
  canInvite: false,
  canManage: false,
  managerInviteRole: 'AGENT',
  maskPhoneAndEmail: false,
  callsAvailable: false,
};

type DestructiveAction = { session: Session; unlink: boolean } | null;
type ChannelState = {
  capabilities: ChannelCapabilities | null;
  code: string | null;
  message: string | null;
};

export function WorkspaceChannels() {
  const { t } = useT();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Session | null>(null);
  const [qrSession, setQrSession] = useState<Session | null>(null);
  const [qr, setQr] = useState<SessionQR | null>(null);
  const [action, setAction] = useState<DestructiveAction>(null);
  const [busy, setBusy] = useState(false);
  const [channelState, setChannelState] = useState<ChannelState>({ capabilities: null, code: null, message: null });
  const [confirmOpenWA, setConfirmOpenWA] = useState(false);
  const [channelRevision, setChannelRevision] = useState(0);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [sessionRows, teamRows, roster, activeChannel] = await Promise.all([
        fetchSessions(),
        fetchTeams(),
        fetchWorkspaceUsers(),
        fetchChannelCapabilities().catch(() => ({
          capabilities: null,
          code: 'CHANNEL_CAPABILITIES_UNAVAILABLE',
          message: null,
        })),
      ]);
      setSessions(sessionRows);
      setTeams(teamRows);
      setCapabilities(roster.capabilities);
      setChannelState(activeChannel);
      setSelected((current) => current ? sessionRows.find((row) => row.id === current.id) || null : null);
    } catch {
      setFailed(true);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!qrSession) return;
    let active = true;
    let polling = false;

    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const result = await fetchSessionQR(qrSession.sessionName);
        if (!active) return;
        setQr(result);
        if (result.connected) {
          setSessions((rows) => rows.map((row) => row.id === qrSession.id ? { ...row, connected: true, isActive: true } : row));
        }
      } catch {
        if (active) setQr({ connected: false, pending: true });
      } finally {
        polling = false;
      }
    };

    setQr(null);
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [qrSession]);

  const teamNames = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  const label = (session: Session) => session.label || t('WhatsApp channel');
  const openWAIsActive = sessions.some((session) => session.isActiveChannel);
  const openWAConnected = sessions.some((session) => session.connected);
  const openWAProbeUnavailable = !openWAConnected && sessions.some((session) => session.connectionStatus === 'UNAVAILABLE');
  const repairAmbiguous = channelState.code === 'CHANNEL_AMBIGUOUS';
  const offerOpenWASwitch = capabilities.canManage && (!openWAIsActive || repairAmbiguous);

  const runAction = async () => {
    if (!action) return;
    setBusy(true);
    try {
      await disconnectSession(action.session.sessionName, { unlink: action.unlink });
      toast.success(action.unlink ? t('WhatsApp number unlinked') : t('Channel disconnected'));
      setAction(null);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not update channel'));
    } finally {
      setBusy(false);
    }
  };

  const channelChanged = useCallback(async () => {
    await load(false);
    setChannelRevision((value) => value + 1);
  }, [load]);

  const activateOpenWA = async () => {
    setBusy(true);
    try {
      await setActiveChannel('OPENWA');
      setConfirmOpenWA(false);
      await channelChanged();
      toast.success(t('This workspace now sends through OpenWA'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not switch the sending channel'));
    } finally {
      setBusy(false);
    }
  };

  const channelProblem = channelState.code
    ? channelProblemCopy(channelState.code, t)
    : null;

  if (loading) return <LayoutSkeleton label={t('Loading channels')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load channels')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{t('Channels')}</h1>
          <p className="mt-1 text-caption text-muted-foreground">{t('Monitor linked messaging accounts and manage their connection state.')}</p>
        </div>
        {!capabilities.canManage && <span className="flex items-center gap-2 text-caption text-muted-foreground"><ShieldCheck className="size-4" />{t('Only workspace owners can change channels.')}</span>}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        {channelProblem && (
          <div role="alert" className="mb-6 border border-warning/40 bg-warning/5">
            <ErrorState
              title={channelProblem.title}
              description={channelProblem.description}
              retryLabel={t('Check again')}
              onRetry={() => load(false)}
              compact
            />
          </div>
        )}

        {channelState.capabilities && <ChannelCapabilitiesPanel capabilities={channelState.capabilities} />}

        {!!sessions.length && (
          <section className="mb-4 flex flex-wrap items-start justify-between gap-3" aria-labelledby="openwa-channel-heading">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="openwa-channel-heading" className="text-small font-semibold">OpenWA</h2>
                <ActiveChannelStatus
                  active={openWAIsActive && !repairAmbiguous}
                  activeLabel={t('Active sending channel')}
                  inactiveLabel={repairAmbiguous ? t('Sending channel needs selection') : t('Inactive sending channel')}
                />
              </div>
              <p className="mt-1 text-caption text-muted-foreground">{t('QR-linked WhatsApp sessions for this workspace.')}</p>
            </div>
            {offerOpenWASwitch && (
              <div className="max-w-md text-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !openWAConnected}
                  onClick={() => setConfirmOpenWA(true)}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                  {repairAmbiguous ? t('Use OpenWA and repair sending') : t('Send through OpenWA')}
                </Button>
                {!openWAConnected && (
                  <p role="status" className="mt-2 text-micro text-warning">
                    {openWAProbeUnavailable
                      ? t('RabiTech could not check whether OpenWA is connected. Check again before switching.')
                      : t('Connect an OpenWA session before switching to it.')}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {!sessions.length ? (
          <EmptyState icon={MessageCircle} title={t('No channels configured')} description={t('A channel appears here after workspace provisioning completes.')} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sessions.map((session) => (
              <article key={session.id} className="flex min-h-52 flex-col border border-border bg-card p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-success/10 text-success"><MessageCircle className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-small font-semibold">{label(session)}</h2><ChannelStatus connected={session.connected} connectedLabel={t('Connected')} disconnectedLabel={t('Disconnected')} /></div>
                    <p className="mt-1 truncate text-caption text-muted-foreground" dir="ltr">{session.phoneNumber || t('No number linked')}</p>
                  </div>
                </div>

                <dl className="mt-5 grid grid-cols-2 gap-x-3 gap-y-2 text-caption">
                  <dt className="text-muted-foreground">{t('Provider')}</dt><dd className="text-end font-medium">OpenWA</dd>
                  <dt className="text-muted-foreground">{t('Team')}</dt><dd className="truncate text-end font-medium">{session.teamId ? teamNames.get(session.teamId) || t('Unknown team') : t('No team')}</dd>
                  <dt className="text-muted-foreground">{t('Session')}</dt><dd className="truncate text-end font-mono text-micro" dir="ltr">{session.sessionName}</dd>
                </dl>

                <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelected(session)}>{t('View channel')}</Button>
                  {!session.connected && capabilities.canManage && <Button type="button" size="sm" onClick={() => setQrSession(session)}><QrCode className="size-4" />{t('Link device')}</Button>}
                </div>
              </article>
            ))}
          </div>
        )}

        <MetaChannelCard
          canManage={capabilities.canManage}
          resolutionCode={channelState.code}
          refreshToken={channelRevision}
          onChannelChanged={channelChanged}
        />
      </div>

      <Drawer open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DrawerContent closeLabel={t('Close')}>
          <DrawerHeader><DrawerTitle className="text-base font-semibold">{selected ? label(selected) : ''}</DrawerTitle><DrawerDescription>{t('Channel connection and ownership details.')}</DrawerDescription></DrawerHeader>
          {selected && <DrawerBody className="space-y-7">
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3"><h2 className="text-small font-semibold">{t('Connection')}</h2><ChannelStatus connected={selected.connected} connectedLabel={t('Connected')} disconnectedLabel={t('Disconnected')} /></div>
              <dl className="divide-y divide-border border-y border-border text-small">
                <Detail label={t('Provider')} value="OpenWA" />
                <Detail label={t('Linked number')} value={selected.phoneNumber || t('No number linked')} ltr />
                <Detail label={t('Team')} value={selected.teamId ? teamNames.get(selected.teamId) || t('Unknown team') : t('No team')} />
                <Detail label={t('Session ID')} value={selected.sessionName} ltr />
              </dl>
              {!selected.connected && capabilities.canManage && <Button type="button" onClick={() => setQrSession(selected)}><QrCode className="size-4" />{t('Link device')}</Button>}
            </section>

            {capabilities.canManage && <DangerZone title={t('Connection controls')} description={t('Conversation history remains in RabiTech when a WhatsApp connection is stopped or unlinked.')}>
              <div className="flex flex-wrap gap-2">
                {selected.connected && <Button type="button" variant="outline" onClick={() => setAction({ session: selected, unlink: false })}><PowerOff className="size-4" />{t('Disconnect temporarily')}</Button>}
                {selected.phoneNumber && <Button type="button" variant="destructive" onClick={() => setAction({ session: selected, unlink: true })}><Unplug className="size-4" />{t('Unlink number')}</Button>}
              </div>
            </DangerZone>}
          </DrawerBody>}
          <DrawerFooter><Button variant="outline" onClick={() => setSelected(null)}>{t('Close')}</Button></DrawerFooter>
        </DrawerContent>
      </Drawer>

      <Dialog open={!!qrSession} onOpenChange={(open) => { if (!open) { setQrSession(null); setQr(null); load(false); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>{t('Link WhatsApp device')}</DialogTitle><DialogDescription>{t('In WhatsApp, open Linked devices, choose Link a device, then scan this code.')}</DialogDescription></DialogHeader>
          <div className="flex min-h-72 items-center justify-center">
            {qr?.connected ? <div className="flex flex-col items-center gap-3 text-success"><CheckCircle2 className="size-12" /><p className="text-small font-semibold">{t('Device linked')}</p></div>
              : qr?.qrCode ? <div className="space-y-3 text-center">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={qr.qrCode} alt={t('WhatsApp linking QR code')} className="mx-auto size-64 bg-white p-2" /><p className="text-caption text-muted-foreground">{t('The code refreshes automatically.')}</p></div>
              : qr?.reconnecting ? <div className="flex max-w-xs flex-col items-center gap-3 text-center"><Loader2 className="size-7 animate-spin text-warning" /><p className="text-small font-medium">{t('Reconnecting the existing number')}</p><p className="text-caption text-muted-foreground">{t('Unlink the current number first when you need to pair a different one.')}</p></div>
              : <div className="flex flex-col items-center gap-3 text-muted-foreground"><Loader2 className="size-8 animate-spin" /><p className="text-caption">{t('Preparing link code')}</p></div>}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpenWA}
        onOpenChange={setConfirmOpenWA}
        title={t('Switch sending channel to OpenWA?')}
        description={t('Future messages and automatic replies will use OpenWA. The Meta credential stays saved, but customer messages sent to the inactive Meta number will not reach RabiTech until Meta is reactivated. Existing conversations and message history remain saved.')}
        cancelLabel={t('Cancel')}
        confirmLabel={repairAmbiguous ? t('Use OpenWA and repair sending') : t('Send through OpenWA')}
        onConfirm={activateOpenWA}
        busy={busy}
        destructive={false}
      />

      <ConfirmDialog
        open={!!action}
        onOpenChange={(open) => { if (!open) setAction(null); }}
        title={action?.unlink ? t('Unlink WhatsApp number') : t('Disconnect channel')}
        description={action?.unlink ? t('The current pairing is removed and a new QR scan is required. Existing conversations remain saved.') : t('Messaging pauses temporarily. The same paired number can reconnect without a new QR scan.')}
        cancelLabel={t('Cancel')}
        confirmLabel={action?.unlink ? t('Unlink number') : t('Disconnect temporarily')}
        onConfirm={runAction}
        busy={busy}
        destructive={action?.unlink !== false}
      />
    </div>
  );
}

function ChannelStatus({ connected, connectedLabel, disconnectedLabel }: { connected: boolean; connectedLabel: string; disconnectedLabel: string }) {
  return <span className={connected ? 'inline-flex items-center gap-1.5 text-caption font-medium text-success' : 'inline-flex items-center gap-1.5 text-caption font-medium text-warning'}><span className="size-2 rounded-full bg-current" />{connected ? connectedLabel : disconnectedLabel}</span>;
}

function ActiveChannelStatus({ active, activeLabel, inactiveLabel }: { active: boolean; activeLabel: string; inactiveLabel: string }) {
  return <span className={active ? 'inline-flex items-center gap-1.5 text-caption font-medium text-success' : 'inline-flex items-center gap-1.5 text-caption font-medium text-warning'}><span className="size-2 rounded-full bg-current" />{active ? activeLabel : inactiveLabel}</span>;
}

function channelProblemCopy(code: string, t: (key: string) => string) {
  if (code === 'CHANNEL_NOT_ACTIVE') {
    return {
      title: t('No sending channel is active'),
      description: t('Sending is paused. A workspace owner must choose a connected channel below.'),
    };
  }
  if (code === 'CHANNEL_AMBIGUOUS') {
    return {
      title: t('More than one sending channel is active'),
      description: t('Sending is paused to prevent messages leaving from the wrong number. A workspace owner must select one channel below.'),
    };
  }
  return {
    title: t('Could not check the sending channel'),
    description: t('RabiTech could not read the active channel capabilities. Check again before changing channel settings.'),
  };
}

function Detail({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return <div className="flex items-center justify-between gap-4 py-3"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 truncate font-medium" dir={ltr ? 'ltr' : undefined}>{value}</dd></div>;
}
