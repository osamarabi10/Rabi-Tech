'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, MessageCircle, MoreHorizontal, Pause, Play,
  Plus, RefreshCw, RotateCw, Tag, Trash2, Users, CreditCard, Eye, Wallet, AlarmClock, Clock, Plug, ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import api, { setViewAsOrg } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState } from '@/components/ui/operational-state';
import { CommercialTermsDialog } from '@/components/platform/commercial-terms-dialog';
import { FinanceDocumentTable } from '@/components/platform/finance-document-table';
import { GatewayAlerts, HealthCell, useGatewayHealth } from '@/components/platform/gateway-health';

type ProvisioningState =
  | 'PENDING' | 'PROVISIONING' | 'AWAITING_QR' | 'ACTIVE' | 'SUSPENDED' | 'FAILED';

type Subscriber = {
  id: string;
  name: string;
  slug: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PROVISIONING';
  tier: string;
  emailVerifiedAt: string | null;
  downgradeGraceEndsAt: string | null;
  /** Service stops then unless the balance clears. Null when not in dunning. */
  suspendAt: string | null;
  suspendReason: string | null;
  planOverride: string | null;
  overrideExpiresAt: string | null;
  subscriptions: Array<{
    planCode: string;
    status: string;
    provider: string;
    currentPeriodEnd: string | null;
    /** Set only while TRIALING. The console counts down to it. */
    trialEndsAt: string | null;
  }>;
  createdAt: string;
  _count: { users: number; whatsappSessions: number };
  channels: Array<{
    status: string;
    provisioningState: ProvisioningState;
    provisioningStep: string | null;
    failureReason: string | null;
    failureStep: string | null;
    managedByProvisioner: boolean;
    apiPort: number | null;
    deploymentName: string | null;
  }>;
};

type RollupUsage = {
  asOf: string | null;
  items: Array<{ metric: string; current: string; limit: string | null }>;
};

const EMPTY_FORM = {
  name: '', slug: '', adminName: '', adminEmail: '', adminPassword: '',
};

/** The deadline of a live trial, or null when this subscriber has none. */
function trialDeadline(subscriber: Subscriber): number | null {
  const raw = subscriber.subscriptions[0]?.trialEndsAt;
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function trialExpired(subscriber: Subscriber): boolean {
  const deadline = trialDeadline(subscriber);
  return deadline !== null && deadline <= Date.now();
}

/**
 * How long is left, in the console's own words.
 *
 * Coarse on purpose: an owner scanning a table wants to know who is about to
 * fall off, not that a workspace has 2h 41m. Minutes appear only inside the
 * last hour, where the difference is the difference between calling someone
 * today and calling them tomorrow.
 */
function trialLabel(subscriber: Subscriber): string | null {
  const deadline = trialDeadline(subscriber);
  if (deadline === null) return null;
  const ms = deadline - Date.now();
  if (ms <= 0) return 'trial expired';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `trial: ${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `trial: ${hours}h ${minutes % 60}m left`;
  return `trial: ${Math.floor(hours / 24)}d left`;
}

export default function SubscribersPage() {
  const router = useRouter();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [usage, setUsage] = useState<Record<string, RollupUsage>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<Subscriber | null>(null);
  const [termsTarget, setTermsTarget] = useState<Subscriber | null>(null);
  /**
   * The subscriber whose finance ledger is open.
   *
   * A dialog rather than a row expansion: the ledger has its own table and
   * two of its own dialogs, and nesting that inside a list row makes both
   * the row and the ledger harder to read than either is alone.
   */
  const [financeTarget, setFinanceTarget] = useState<Subscriber | null>(null);
  const [channelTarget, setChannelTarget] = useState<Subscriber | null>(null);
  const [channelBaseUrl, setChannelBaseUrl] = useState('');
  const [channelApiKey, setChannelApiKey] = useState('');
  const [rotateWebhook, setRotateWebhook] = useState(false);
  const { health, refresh: refreshHealth } = useGatewayHealth();
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { data } = await api.get<Subscriber[]>('/api/platform/subscribers');
      setSubscribers(data);
      const usageRows = await Promise.all(data.map(async (subscriber) => {
        const response = await api.get(`/api/platform/subscribers/${subscriber.id}/usage`);
        return [subscriber.id, response.data] as const;
      }));
      setUsage(Object.fromEntries(usageRows));
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('rabitech_token');
    const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
    if (!token || user.scope !== 'PLATFORM') {
      router.replace('/login');
      return;
    }
    load();
  }, [load, router]);

  useEffect(() => {
    const changing = subscribers.some((subscriber) =>
      ['PENDING', 'PROVISIONING', 'AWAITING_QR'].includes(
        subscriber.channels[0]?.provisioningState,
      ),
    );
    if (!changing) return;
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load, subscribers]);

  const createSubscriber = async () => {
    setSaving(true);
    try {
      await api.post('/api/platform/subscribers', form);
      toast.success('Subscriber created. Activate after email verification.');
      setForm(EMPTY_FORM);
      setOpen(false);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to create subscriber');
    } finally {
      setSaving(false);
    }
  };

  const gatewayAction = async (
    subscriber: Subscriber,
    action: 'retry' | 'suspend' | 'resume' | 'restart',
  ) => {
    setActionId(subscriber.id);
    try {
      await api.post(`/api/platform/subscribers/${subscriber.id}/gateway/${action}`);
      toast.success(`Gateway ${action} queued`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || `Failed to ${action} gateway`);
    } finally {
      setActionId(null);
    }
  };

  const destroySubscriber = async () => {
    if (!destroyTarget) return;
    setActionId(destroyTarget.id);
    try {
      await api.delete(`/api/platform/subscribers/${destroyTarget.id}`);
      toast.success('Subscriber destruction queued');
      setDestroyTarget(null);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to destroy subscriber');
    } finally {
      setActionId(null);
    }
  };

  /**
   * Give a trial more time.
   *
   * Extends from now, not from the old deadline — adding hours to a date that
   * passed last night would grant an extension that is also already over, and
   * the owner would be left clicking a button that visibly does nothing.
   */
  const extendTrial = async (subscriber: Subscriber, hours: number) => {
    setActionId(subscriber.id);
    try {
      await api.post(`/api/platform/subscribers/${subscriber.id}/billing/extend-trial`, { hours });
      toast.success(`Trial extended by ${hours}h`);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not extend the trial');
    } finally {
      setActionId(null);
    }
  };

  /**
   * Point a hand-configured subscriber at a different OpenWA deployment.
   *
   * The API key is write-only everywhere: it is stored encrypted and never
   * returned, so this field starts empty and an empty save is refused rather
   * than silently blanking a working credential.
   */
  const saveChannel = async () => {
    if (!channelTarget) return;
    setActionId(channelTarget.id);
    try {
      await api.patch(`/api/platform/subscribers/${channelTarget.id}/openwa-channel`, {
        baseUrl: channelBaseUrl.trim(),
        apiKey: channelApiKey.trim(),
        rotateWebhookToken: rotateWebhook,
      });
      toast.success('Channel updated');
      setChannelTarget(null);
      setChannelApiKey('');
      setRotateWebhook(false);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not update the channel');
    } finally {
      setActionId(null);
    }
  };

  const activatePlan = async (subscriber: Subscriber, planCode: 'GROWTH' | 'BUSINESS' | 'ENTERPRISE') => {
    setActionId(subscriber.id);
    try {
      await api.post(`/api/platform/subscribers/${subscriber.id}/billing/activate`, { planCode });
      toast.success(`${planCode} activation queued`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to activate plan');
    } finally {
      setActionId(null);
    }
  };

  const markPaymentFailed = async (subscriber: Subscriber) => {
    setActionId(subscriber.id);
    try {
      await api.post(`/api/platform/subscribers/${subscriber.id}/billing/mark-failed`, { reason: 'Manual payment failure' });
      toast.success('Payment failure applied');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to mark payment failed');
    } finally {
      setActionId(null);
    }
  };

  const usageValue = (subscriberId: string, metric: string) => {
    const item = usage[subscriberId]?.items.find((candidate) => candidate.metric === metric);
    if (!item) return '-';
    const limit = item.limit === null ? 'Unlimited' : Number(item.limit).toLocaleString();
    return `${Number(item.current).toLocaleString()} / ${limit}`;
  };

  const stateVariant = (state?: ProvisioningState) => {
    if (state === 'ACTIVE') return 'default' as const;
    if (state === 'FAILED') return 'destructive' as const;
    return 'secondary' as const;
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-bold">RabiTech</p>
              <p className="text-xs text-muted-foreground">Platform control</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /> New subscriber
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-6">
        {/* A console you can only leave with the browser back button is one
            page wearing a trench coat. */}
        <Link
          href="/platform"
          className="inline-flex items-center gap-1.5 text-caption text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5 rtl:rotate-180" />
          Platform control
        </Link>
        <h1 className="mb-4 mt-2 text-lg font-bold">Subscribers</h1>
        <GatewayAlerts health={health} />
        <div className="overflow-x-auto rounded-md border border-border">
          <div className="grid min-w-[1472px] grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)_90px_70px_90px_130px_140px_130px_minmax(190px,1.3fr)_92px_70px] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            <span>Name</span><span>Slug</span><span>Billing</span><span>Users</span><span>WhatsApp</span><span>Active contacts</span><span>Outbound messages</span><span>Campaign sends</span><span>Gateway</span><span title="Left dot: status poll. Right dot: internal self-send probe.">Health</span><span className="sr-only">Actions</span>
          </div>
          {loading && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</p>}
          {!loading && loadError && (
            <ErrorState
              compact
              title="Could not load subscribers"
              description="The subscriber list could not be loaded. Check the platform connection and try again."
              retryLabel="Retry"
              onRetry={load}
            />
          )}
          {!loading && !loadError && subscribers.length === 0 && (
            <EmptyState compact title="No subscribers" description="Create a subscriber to see workspaces in this console." />
          )}
          {!loading && !loadError && subscribers.map((subscriber) => {
            const channel = subscriber.channels[0];
            return (
              <div key={subscriber.id} className="grid min-w-[1472px] grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)_90px_70px_90px_130px_140px_130px_minmax(190px,1.3fr)_92px_70px] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
                <span className="truncate font-semibold">{subscriber.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{subscriber.slug}</span>
                <div className="min-w-0">
                  <Badge variant={subscriber.subscriptions[0]?.status === 'ACTIVE' ? 'default' : 'secondary'}>
                    {subscriber.tier}
                  </Badge>
                  <p className="mt-1 truncate text-caption text-muted-foreground">
                    {subscriber.subscriptions[0]?.status || 'none'}{subscriber.emailVerifiedAt ? '' : ' · email pending'}
                  </p>
                  {/*
                    Where a trial stands. Rendered from the deadline rather than
                    from a stored 'expired' flag, because nothing writes one —
                    expiry is decided when someone asks, so this reads the same
                    source the paywall does and cannot disagree with it.
                  */}
                  {trialLabel(subscriber) && (
                    <p
                      className={cn(
                        'mt-1 truncate text-caption',
                        trialExpired(subscriber) ? 'text-danger' : 'text-warning',
                      )}
                    >
                      {trialLabel(subscriber)}
                    </p>
                  )}
                  {/*
                    Counting down to cut-off. The one thing on this row an
                    owner has to act on before a date rather than after it, so
                    it sits with the billing state and not in a dialog.
                  */}
                  {subscriber.suspendAt && (
                    <p
                      className="mt-1 flex items-center gap-1 text-caption text-destructive"
                      title={subscriber.suspendReason ?? undefined}
                    >
                      <AlarmClock className="h-3 w-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {new Date(subscriber.suspendAt) <= new Date()
                          ? 'overdue — cut-off due'
                          : `cut-off ${subscriber.suspendAt.slice(0, 10)}`}
                      </span>
                    </p>
                  )}
                </div>
                <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" />{subscriber._count.users}</span>
                <span className="flex items-center gap-1.5"><MessageCircle className="h-3.5 w-3.5" />{subscriber._count.whatsappSessions}</span>
                <span className="font-mono text-xs">{usageValue(subscriber.id, 'active_contacts')}</span>
                <span className="font-mono text-xs">{usageValue(subscriber.id, 'messages_outbound')}</span>
                <span className="font-mono text-xs">{usageValue(subscriber.id, 'campaign_sends')}</span>
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant={stateVariant(channel?.provisioningState)}>
                      {channel?.provisioningState || subscriber.status}
                    </Badge>
                    {channel?.apiPort && <span className="font-mono text-xs text-muted-foreground">:{channel.apiPort}</span>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground" title={channel?.failureReason || undefined}>
                    {channel?.failureReason || channel?.provisioningStep?.replaceAll('_', ' ') || 'Unmanaged'}
                  </p>
                </div>
                <HealthCell
                  organizationId={subscriber.id}
                  health={health}
                  onRefresh={refreshHealth}
                />
                <Button
                  size="sm"
                  variant="outline"
                  title="Open this subscriber's workspace read-only"
                  onClick={() => {
                    setViewAsOrg({ id: subscriber.id, name: subscriber.name });
                    router.push('/inbox');
                  }}
                >
                  <Eye className="h-3.5 w-3.5" /> View
                </Button>
                {/*
                  A button of its own rather than an item in the menu above:
                  that menu is disabled whenever the gateway is unmanaged, and
                  commercial terms have nothing to do with gateway state.
                */}
                <Button
                  size="sm"
                  variant="outline"
                  title="Plan override, MAC quota, discount and credit"
                  onClick={() => setTermsTarget(subscriber)}
                >
                  <Tag className="h-3.5 w-3.5" /> Terms
                  {subscriber.planOverride && (
                    <Badge variant="secondary" className="ms-1 px-1 text-micro">عرض خاص</Badge>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  title="Invoices, payments and receipts"
                  onClick={() => setFinanceTarget(subscriber)}
                >
                  <Wallet className="h-3.5 w-3.5" /> Finance
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    {/*
                      Enabled regardless of the gateway. This trigger used to
                      require a provisioner-managed channel, which disabled the
                      whole menu — including extending a trial and activating a
                      plan — for every subscriber on a hand-configured gateway.
                      Billing actions have nothing to do with who provisioned
                      the channel. The gateway *items* still carry that
                      condition, individually, below.
                    */}
                    <Button size="icon" variant="ghost" disabled={actionId === subscriber.id} title="Actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={!channel?.managedByProvisioner || channel?.provisioningState !== 'FAILED'} onSelect={() => gatewayAction(subscriber, 'retry')}>
                      <RefreshCw /> Retry provisioning
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!channel?.managedByProvisioner || channel?.provisioningState === 'SUSPENDED'} onSelect={() => gatewayAction(subscriber, 'suspend')}>
                      <Pause /> Force suspend
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!channel?.managedByProvisioner || channel?.provisioningState !== 'SUSPENDED'} onSelect={() => gatewayAction(subscriber, 'resume')}>
                      <Play /> Resume
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!channel?.managedByProvisioner} onSelect={() => gatewayAction(subscriber, 'restart')}>
                      <RotateCw /> Restart gateway
                    </DropdownMenuItem>
                    {/*
                      The inverse condition: a managed gateway is changed
                      through provisioning actions and the endpoint refuses it
                      with a 409, so offering this there would be a control
                      that always errors.
                    */}
                    {channel && !channel.managedByProvisioner && (
                      <DropdownMenuItem onSelect={() => setChannelTarget(subscriber)}>
                        <Plug /> Edit OpenWA channel
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    {/* Only for subscribers who actually have a trial to extend. */}
                    {subscriber.subscriptions[0]?.trialEndsAt && (
                      <>
                        <DropdownMenuItem onSelect={() => extendTrial(subscriber, 3)}>
                          <Clock /> Extend trial 3h
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => extendTrial(subscriber, 24)}>
                          <Clock /> Extend trial 24h
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => extendTrial(subscriber, 24 * 7)}>
                          <Clock /> Extend trial 7 days
                        </DropdownMenuItem>
                      </>
                    )}
                    <DropdownMenuItem onSelect={() => activatePlan(subscriber, 'GROWTH')}>
                      <CreditCard /> Activate Growth
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => activatePlan(subscriber, 'BUSINESS')}>
                      <CreditCard /> Activate Business
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => activatePlan(subscriber, 'ENTERPRISE')}>
                      <CreditCard /> Activate Enterprise
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => markPaymentFailed(subscriber)}>
                      <Pause /> Mark payment failed
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDestroyTarget(subscriber)}>
                      <Trash2 /> Destroy subscriber
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      </section>

      <Dialog
        open={!!financeTarget}
        onOpenChange={(next) => !next && setFinanceTarget(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Finance — {financeTarget?.name}
            </DialogTitle>
          </DialogHeader>
          {financeTarget && <FinanceDocumentTable subscriberId={financeTarget.id} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!channelTarget}
        onOpenChange={(next) => {
          if (!next) { setChannelTarget(null); setChannelApiKey(''); setRotateWebhook(false); }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>OpenWA channel — {channelTarget?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ch-url">Base URL</Label>
              <Input
                id="ch-url"
                className="mt-1"
                dir="ltr"
                value={channelBaseUrl}
                onChange={(e) => setChannelBaseUrl(e.target.value)}
                placeholder="http://openwa:2785"
              />
            </div>
            <div>
              <Label htmlFor="ch-key">API key</Label>
              <Input
                id="ch-key"
                className="mt-1"
                dir="ltr"
                type="password"
                value={channelApiKey}
                onChange={(e) => setChannelApiKey(e.target.value)}
              />
              {/*
                Said rather than left to be discovered: the stored key is
                encrypted and never sent back, so this box is empty even though
                a key exists.
              */}
              <p className="mt-1 text-caption text-muted-foreground">
                Stored encrypted and never returned, so this starts empty. Both fields are required.
              </p>
            </div>
            <label className="flex items-start gap-2 text-caption">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-primary"
                checked={rotateWebhook}
                onChange={(e) => setRotateWebhook(e.target.checked)}
              />
              <span>
                Rotate the webhook token
                <span className="mt-0.5 block text-muted-foreground">
                  Inbound messages stop until the new token is configured on the gateway.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setChannelTarget(null)}>Cancel</Button>
            <Button
              onClick={saveChannel}
              disabled={!channelBaseUrl.trim() || !channelApiKey.trim() || actionId !== null}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New subscriber</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5"><Label>Organization name</Label><Input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
            <div className="space-y-1.5"><Label>Slug</Label><Input dir="ltr" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></div>
            <div className="space-y-1.5"><Label>Administrator name</Label><Input value={form.adminName} onChange={(event) => setForm({ ...form, adminName: event.target.value })} /></div>
            <div className="space-y-1.5"><Label>Administrator email</Label><Input dir="ltr" type="email" value={form.adminEmail} onChange={(event) => setForm({ ...form, adminEmail: event.target.value })} /></div>
            <div className="space-y-1.5"><Label>Temporary password</Label><Input dir="ltr" type="password" value={form.adminPassword} onChange={(event) => setForm({ ...form, adminPassword: event.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={saving} onClick={createSubscriber}>{saving ? 'Creating...' : 'Create subscriber'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CommercialTermsDialog
        subscriberId={termsTarget?.id ?? null}
        subscriberName={termsTarget?.name ?? ''}
        onClose={() => setTermsTarget(null)}
        onSaved={load}
      />

      <Dialog open={Boolean(destroyTarget)} onOpenChange={(value) => !value && setDestroyTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Destroy subscriber</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently removes {destroyTarget?.name}, its gateway containers, session volume, and organization data.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDestroyTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={destroySubscriber} disabled={actionId === destroyTarget?.id}>
              <Trash2 className="h-4 w-4" /> Destroy subscriber
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
