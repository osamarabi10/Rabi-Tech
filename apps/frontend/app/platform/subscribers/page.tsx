'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, LogOut, MessageCircle, MoreHorizontal, Pause, Play,
  Plus, RefreshCw, RotateCw, Tag, Trash2, Users, CreditCard, Eye,
} from 'lucide-react';
import { toast } from 'sonner';
import api, { setViewAsOrg } from '@/lib/api';
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
import { CommercialTermsDialog } from '@/components/platform/commercial-terms-dialog';
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
  planOverride: string | null;
  overrideExpiresAt: string | null;
  subscriptions: Array<{ planCode: string; status: string; provider: string; currentPeriodEnd: string | null }>;
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

export default function SubscribersPage() {
  const router = useRouter();
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [usage, setUsage] = useState<Record<string, RollupUsage>>({});
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<Subscriber | null>(null);
  const [termsTarget, setTermsTarget] = useState<Subscriber | null>(null);
  const { health, refresh: refreshHealth } = useGatewayHealth();
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<Subscriber[]>('/api/platform/subscribers');
      setSubscribers(data);
      const usageRows = await Promise.all(data.map(async (subscriber) => {
        const response = await api.get(`/api/platform/subscribers/${subscriber.id}/usage`);
        return [subscriber.id, response.data] as const;
      }));
      setUsage(Object.fromEntries(usageRows));
    } catch {
      toast.error('Failed to load subscribers');
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

  const logout = () => {
    localStorage.removeItem('rabitech_token');
    localStorage.removeItem('rabitech_user');
    setViewAsOrg(null); // don't leave a subscriber selected for the next sign-in
    router.push('/login');
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
            <Button size="icon" variant="ghost" onClick={logout} title="Sign out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-5 py-6">
        <h1 className="mb-4 text-lg font-bold">Subscribers</h1>
        <GatewayAlerts health={health} />
        <div className="overflow-x-auto rounded-md border border-border">
          <div className="grid min-w-[1472px] grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)_90px_70px_90px_130px_140px_130px_minmax(190px,1.3fr)_92px_70px] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground">
            <span>Name</span><span>Slug</span><span>Billing</span><span>Users</span><span>WhatsApp</span><span>Active contacts</span><span>Outbound messages</span><span>Campaign sends</span><span>Gateway</span><span title="Left dot: status poll. Right dot: internal self-send probe.">Health</span><span className="sr-only">Actions</span>
          </div>
          {loading && <p className="px-4 py-8 text-center text-sm text-muted-foreground">Loading...</p>}
          {!loading && subscribers.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No subscribers</p>
          )}
          {subscribers.map((subscriber) => {
            const channel = subscriber.channels[0];
            return (
              <div key={subscriber.id} className="grid min-w-[1472px] grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)_90px_70px_90px_130px_140px_130px_minmax(190px,1.3fr)_92px_70px] items-center gap-3 border-b border-border px-4 py-3 text-sm last:border-0">
                <span className="truncate font-semibold">{subscriber.name}</span>
                <span className="truncate font-mono text-xs text-muted-foreground">{subscriber.slug}</span>
                <div className="min-w-0">
                  <Badge variant={subscriber.subscriptions[0]?.status === 'ACTIVE' ? 'default' : 'secondary'}>
                    {subscriber.tier}
                  </Badge>
                  <p className="mt-1 truncate text-[11px] text-muted-foreground">
                    {subscriber.subscriptions[0]?.status || 'none'}{subscriber.emailVerifiedAt ? '' : ' · email pending'}
                  </p>
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
                    <Badge variant="secondary" className="ms-1 px-1 text-[9px]">عرض خاص</Badge>
                  )}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" disabled={actionId === subscriber.id || !channel?.managedByProvisioner} title="Gateway actions">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={channel?.provisioningState !== 'FAILED'} onSelect={() => gatewayAction(subscriber, 'retry')}>
                      <RefreshCw /> Retry provisioning
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={channel?.provisioningState === 'SUSPENDED'} onSelect={() => gatewayAction(subscriber, 'suspend')}>
                      <Pause /> Force suspend
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={channel?.provisioningState !== 'SUSPENDED'} onSelect={() => gatewayAction(subscriber, 'resume')}>
                      <Play /> Resume
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => gatewayAction(subscriber, 'restart')}>
                      <RotateCw /> Restart gateway
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
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
