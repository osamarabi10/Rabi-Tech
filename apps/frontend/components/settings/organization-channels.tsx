'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChannelRail, type ChannelRailChannel } from '@/components/ui/channel-rail';
import {
  CheckCircle2,
  Loader2,
  AlertTriangle,
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
  fetchOrganizationUsers,
  bindSessionChannel,
  connectSessionGateway,
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
import { SettingsHeader } from './settings-primitives';

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

/**
 * Localised copy for a pairing fault, keyed by the code on the wire.
 *
 * The server sends a machine-readable code plus English prose. The code is
 * the contract and is what gets translated here; the prose is the fallback
 * for a code this build has not been taught, so an unknown fault still says
 * something true rather than rendering an empty panel.
 */
function pairingFaultCopy(
  qr: SessionQR,
  t: (key: string) => string,
): { reason: string; nextStep: string } {
  switch (qr.code) {
    case 'CHANNEL_NOT_PROVISIONED':
      return {
        reason: t('لم يتم تجهيز بوابة واتساب لهذه المؤسسة بعد'),
        nextStep: t('تواصل مع الدعم لتجهيز البوابة'),
      };
    case 'GATEWAY_REFUSED':
      return {
        reason: t('بوابة واتساب ردّت بخطأ'),
        nextStep: t('حاول بعد دقيقة، وإذا تكرر تواصل مع الدعم'),
      };
    case 'GATEWAY_UNREACHABLE':
      return {
        reason: t('بوابة واتساب لا تستجيب'),
        nextStep: t('يعاد تشغيل البوابة، حاول بعد دقيقة'),
      };
    case 'GATEWAY_PROVISIONING':
      // Being built, which is neither a fault nor a reason to promise a QR
      // code that is not there yet. The dialog stays open and says so.
      return {
        reason: t('عم نجهّز بوابة واتساب لهالرقم'),
        nextStep: t('بياخد دقيقة تقريباً. خلّي الشاشة مفتوحة ورمز QR بيطلع لحاله'),
      };
    default:
      return { reason: qr.reason || t('سبب غير معروف'), nextStep: qr.nextStep || '' };
  }
}

export function OrganizationChannels() {
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
  /*
    The rail's selection lives in the URL, not in component state.

    Two reasons. The routing rules require detail states to be addressable, so
    a channel someone is configuring must survive a refresh and be shareable.
    And the existing `selected` state drives a drawer, which is a different
    thing from which channel the rail is scoped to — collapsing them would
    have made opening the drawer change the rail.
  */
  const router = useRouter();
  const searchParams = useSearchParams();
  const railSelectedId = searchParams.get('channel');

  const railChannels: ChannelRailChannel[] = useMemo(
    () => sessions.map((session) => ({
      id: session.id,
      name: session.label || session.sessionName,
      /*
        Capabilities, not identity — the tenancy gate refuses the latter in a
        frontend component, and the refusal is correct.

        `sessions` only ever contains OpenWA sessions: the endpoint returns no
        transport field because it returns nothing else. OpenWA does not do
        Meta templates, so the capability is false here. When the Meta channel
        joins this rail it will carry its own capabilities, and nothing in the
        rail has to learn who either provider is.
      */
      capabilities: { supportsTemplates: false },
      status: !session.isActive
        ? 'INACTIVE'
        : session.connectionStatus === 'CONNECTED'
          ? 'CONNECTED'
          : session.connectionStatus === 'UNAVAILABLE'
            ? 'CONNECTING'
            : 'DISCONNECTED',
      phoneNumber: session.phoneNumber,
    })),
    [sessions],
  );

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [sessionRows, teamRows, roster] = await Promise.all([
        fetchSessions(),
        fetchTeams(),
        fetchOrganizationUsers(),
      ]);
      setSessions(sessionRows);
      setTeams(teamRows);
      setCapabilities(roster.capabilities);
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
        /*
          A failed request is not pending either.

          This used to answer `pending: true`, which meant the screen span on
          "preparing link code" whenever the request itself failed -- the same
          lie the endpoint told, told again one layer up. The request failing
          is its own unreachable state, and it says so.
        */
        if (active) {
          setQr({
            connected: false,
            unavailable: true,
            code: 'GATEWAY_UNREACHABLE',
            reason: t('تعذّر الوصول إلى الخادم للتحقق من حالة القناة'),
            nextStep: t('تحقق من اتصالك وحاول مرة أخرى بعد دقيقة'),
          });
        }
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

  /*
    What the *selected* number's gateway can do.

    This used to be one organization-wide answer fetched beside the session
    list. Capabilities are the gateway's and the gateway is the number's, so an
    organization-level answer had to pick one of a subscriber's channels and was
    wrong about the others — telling a composer there is no service window on a
    Meta number, which is how a send gets refused by Meta after the agent was
    told it was fine.
  */
  useEffect(() => {
    if (!selected) {
      setChannelState({ capabilities: null, code: null, message: null });
      return;
    }
    let cancelled = false;
    fetchChannelCapabilities(selected.sessionName)
      .catch(() => ({ capabilities: null, code: 'CHANNEL_CAPABILITIES_UNAVAILABLE', message: null }))
      .then((state) => { if (!cancelled) setChannelState(state); });
    return () => { cancelled = true; };
  }, [selected]);

  const teamNames = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);
  const label = (session: Session) => session.label || t('WhatsApp channel');

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
    if (!selected) return;
    setBusy(true);
    try {
      await bindSessionChannel(selected.sessionName, 'OPENWA');
      setConfirmOpenWA(false);
      await channelChanged();
      toast.success(t('This number now sends through OpenWA'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not change the gateway for this number'));
    } finally {
      setBusy(false);
    }
  };

  const bindToMeta = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await bindSessionChannel(selected.sessionName, 'WHATSAPP_CLOUD');
      await channelChanged();
      toast.success(t('This number now sends through Meta'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not change the gateway for this number'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The gateway a number sends through, in words.
   *
   * A lookup rather than a chain of comparisons, and not only for tidiness:
   * the tenancy audit forbids a UI component branching on channel identity,
   * because a component that asks "is this Meta?" has to be edited every time a
   * channel is added. A table keyed by kind is the same principle honoured —
   * these are proper nouns, and an unknown kind renders its own code rather
   * than falling into whichever branch happened to be last.
   */
  const gatewayLabel = (session: Session) =>
    session.channelKind
      ? GATEWAY_NAMES[session.channelKind] ?? session.channelKind
      : t('No gateway set');

  /** Is this number already on that gateway? The kind travels as data. */
  const alreadyOn = (kind: 'OPENWA' | 'WHATSAPP_CLOUD') => selected?.channelKind === kind;

  /**
   * Ask for the gateway, then open the pairing dialog.
   *
   * The request comes first and the dialog second, deliberately. Opening the
   * dialog first would show CHANNEL_NOT_PROVISIONED for the moment before the
   * request lands — telling the customer to press the button they just pressed.
   *
   * A refusal keeps the dialog shut. There is nothing to pair with, and a QR
   * screen over a gateway that will never be built is the spinner-over-a-dead-
   * gateway shape in a different costume.
   */
  const connectAndPair = async (session: Session) => {
    setBusy(true);
    try {
      await connectSessionGateway(session.sessionName);
      setQrSession(session);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not start building the gateway for this number'));
    } finally {
      setBusy(false);
    }
  };

  const channelProblem = channelState.code
    ? channelProblemCopy(channelState.code, t)
    : null;

  /*
    The rail is hoisted above the loading and error branches, deliberately.

    It used to sit inside the tree those two early-returns skip, so a failed
    load replaced the whole surface — content *and* navigation — with a retry
    button. That is not a rendering detail: navigation that disappears when
    content fails strands the user on a dead end, with no way to reach anything
    else in the section except the browser's back button. The rail is wayfinding
    and does not depend on the request that failed, so it has no business being
    inside its failure path.

    Its own data can be empty, and an empty rail is correct while loading — the
    group is omitted when it has no items, so nothing renders a hollow shell.
  */
  const shell = (content: React.ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <ChannelRail
        channels={railChannels}
        selectedChannelId={railSelectedId}
        basePath="/settings/channels"
        onAddChannel={sessions.length ? undefined : () => setConfirmOpenWA(true)}
        addDisabledReason={sessions.length ? t('قناة واحدة لكل مؤسسة في هذه المرحلة') : undefined}
      />
      {content}
    </div>
  );

  if (loading) return shell(<LayoutSkeleton label={t('Loading channels')} className="m-4 flex-1" />);
  if (failed) {
    return shell(
      <ErrorState
        title={t('Could not load channels')}
        retryLabel={t('Try again')}
        onRetry={load}
        className="m-4 flex-1"
      />,
    );
  }

  return shell(
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <SettingsHeader
      title={t('Channels')}
      description={t('Monitor linked messaging accounts and manage their connection state.')}
      action={<>{!capabilities.canManage && <span className="flex items-center gap-2 text-caption text-muted-foreground"><ShieldCheck className="size-4" />{t('Only organization owners can change channels.')}</span>}</>}
    />

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

        {/*
          The organization-level "send through OpenWA" switch is gone, not
          moved. There is no organization sending channel any more: each number
          carries its own gateway, and the control for changing it lives on the
          number, in the drawer below. A switch that kept the old name here
          would describe a concept the product no longer has.
        */}

        {!sessions.length ? (
          <EmptyState icon={MessageCircle} title={t('No channels configured')} description={t('A channel appears here after organization provisioning completes.')} />
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
                  <dt className="text-muted-foreground">{t('Provider')}</dt><dd className="text-end font-medium">{gatewayLabel(session)}</dd>
                  <dt className="text-muted-foreground">{t('Team')}</dt><dd className="truncate text-end font-medium">{session.teamId ? teamNames.get(session.teamId) || t('Unknown team') : t('No team')}</dd>
                  <dt className="text-muted-foreground">{t('Session')}</dt><dd className="truncate text-end font-mono text-micro" dir="ltr">{session.sessionName}</dd>
                </dl>

                <div className="mt-auto flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                  <Button type="button" variant="outline" size="sm" onClick={() => setSelected(session)}>{t('View channel')}</Button>
                  {!session.connected && capabilities.canManage && <Button type="button" size="sm" disabled={busy} onClick={() => connectAndPair(session)}><QrCode className="size-4" />{t('Link device')}</Button>}
                </div>
              </article>
            ))}
          </div>
        )}

        <MetaChannelCard
          canManage={capabilities.canManage}
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
                <Detail label={t('Provider')} value={gatewayLabel(selected)} />
                <Detail label={t('Linked number')} value={selected.phoneNumber || t('No number linked')} ltr />
                <Detail label={t('Team')} value={selected.teamId ? teamNames.get(selected.teamId) || t('Unknown team') : t('No team')} />
                <Detail label={t('Session ID')} value={selected.sessionName} ltr />
              </dl>
              {capabilities.canManage && (
                <div className="space-y-2">
                  <p className="text-caption text-muted-foreground">
                    {t('Messages from this number leave through its own gateway. Changing it here changes nothing for any other number.')}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || alreadyOn('OPENWA')}
                      onClick={() => setConfirmOpenWA(true)}
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                      {t('Send through OpenWA')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy || alreadyOn('WHATSAPP_CLOUD')}
                      onClick={bindToMeta}
                    >
                      {busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                      {t('Send through Meta')}
                    </Button>
                  </div>
                </div>
              )}
              {!selected.connected && capabilities.canManage && <Button type="button" disabled={busy} onClick={() => connectAndPair(selected)}><QrCode className="size-4" />{t('Link device')}</Button>}
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
              : qr?.unavailable ? (
                /*
                  The honest branch. It is placed above `reconnecting` and the
                  spinner on purpose: a fault outranks both, because a spinner
                  shown over a dead gateway is a promise the product cannot keep.
                */
                qr.code === 'GATEWAY_PROVISIONING' ? (
                  /*
                    Being built is not a fault, and must not be dressed as one.

                    It arrives through the same `unavailable` shape as the three
                    real faults — the endpoint has one way to say "no QR yet" —
                    but a red triangle over "could not prepare the pairing code"
                    would be false: nothing failed, the customer pressed Connect
                    a moment ago and the container is starting. Same channel,
                    opposite meaning, so it gets its own presentation: a
                    progress role, no destructive colour, and a spinner that is
                    honest here precisely because something *is* happening.
                  */
                  <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="status">
                    <Loader2 className="size-8 animate-spin text-primary" aria-hidden />
                    <p className="text-small font-semibold">{pairingFaultCopy(qr, t).reason}</p>
                    <p className="text-caption text-muted-foreground">{pairingFaultCopy(qr, t).nextStep}</p>
                  </div>
                ) : (
                  <div className="flex max-w-sm flex-col items-center gap-3 text-center" role="alert">
                    <AlertTriangle className="size-8 text-destructive" aria-hidden />
                    <p className="text-small font-semibold text-destructive">{t('تعذّر تجهيز رمز الربط')}</p>
                    <p className="text-caption text-muted-foreground">{pairingFaultCopy(qr, t).reason}</p>
                    <p className="text-caption font-medium text-foreground">{pairingFaultCopy(qr, t).nextStep}</p>
                  </div>
                )
              )
              : qr?.reconnecting ? <div className="flex max-w-xs flex-col items-center gap-3 text-center"><Loader2 className="size-7 animate-spin text-warning" /><p className="text-small font-medium">{t('Reconnecting the existing number')}</p><p className="text-caption text-muted-foreground">{t('Unlink the current number first when you need to pair a different one.')}</p></div>
              : <div className="flex flex-col items-center gap-3 text-muted-foreground"><Loader2 className="size-8 animate-spin" /><p className="text-caption">{t('Preparing link code')}</p></div>}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmOpenWA}
        onOpenChange={setConfirmOpenWA}
        title={t('Send this number through OpenWA?')}
        description={t('Messages from this number will leave through the OpenWA gateway. Every other number keeps the gateway it already has, and existing conversations and message history remain saved.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Send through OpenWA')}
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

/**
 * What each gateway is called, for a human.
 *
 * Proper nouns, so they are not translated and not composed by the server —
 * "OpenWA" is OpenWA in every locale. A kind absent from this table renders its
 * own code, which is ugly and true, rather than being silently labelled as
 * whichever gateway the last branch named.
 */
const GATEWAY_NAMES: Record<string, string> = {
  OPENWA: 'OpenWA',
  WHATSAPP_CLOUD: 'WhatsApp Cloud API',
};

function ChannelStatus({ connected, connectedLabel, disconnectedLabel }: { connected: boolean; connectedLabel: string; disconnectedLabel: string }) {
  return <span className={connected ? 'inline-flex items-center gap-1.5 text-caption font-medium text-success' : 'inline-flex items-center gap-1.5 text-caption font-medium text-warning'}><span className="size-2 rounded-full bg-current" />{connected ? connectedLabel : disconnectedLabel}</span>;
}

/**
 * What is wrong with the selected number's gateway, in words.
 *
 * Every entry here used to speak for the organization — "no sending channel is
 * active", "an organization owner must select one channel". Those sentences
 * described a product where one channel served everybody. They are about one
 * number now, because the server's answer is.
 *
 * CHANNEL_AMBIGUOUS is gone rather than reworded: it cannot occur. A number
 * carries its gateway, so there is never more than one answer to disambiguate.
 */
function channelProblemCopy(code: string, t: (key: string) => string) {
  if (code === 'SESSION_NOT_BOUND') {
    return {
      title: t('This number has no gateway'),
      description: t('Nothing will send from it until a gateway is chosen. RabiTech does not pick one for you: a reply leaving from the wrong number cannot be taken back.'),
    };
  }
  if (code === 'CHANNEL_NOT_ACTIVE') {
    return {
      title: t('This number\'s gateway is not active'),
      description: t('Sending from this number is paused until its gateway is running. Other numbers are unaffected.'),
    };
  }
  return {
    title: t('Could not check this number\'s gateway'),
    description: t('RabiTech could not read the gateway capabilities for this number. Check again before changing its channel settings.'),
  };
}

function Detail({ label, value, ltr }: { label: string; value: string; ltr?: boolean }) {
  return <div className="flex items-center justify-between gap-4 py-3"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 truncate font-medium" dir={ltr ? 'ltr' : undefined}>{value}</dd></div>;
}
