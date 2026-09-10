'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2, MessageCircle, MoreHorizontal, Pause, Play,
  Plus, RefreshCw, RotateCw, Tag, Trash2, Users, Eye, Wallet, AlarmClock, Clock, Plug,
  Search, CircleAlert, Activity,
} from 'lucide-react';
import { toast } from 'sonner';
import api, { setViewAsOrg } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  _count: { users: number; whatsappSessions: number; workspaces: number };
  /** Branches held. A priced ceiling, so it belongs on the row. */
  workspaceCount: number;
  /**
   * When a customer last wrote in, or null if one never has.
   *
   * Null is not "a long time ago" — a subscriber who signed up this morning
   * has never had an inbound message and is not quiet, they are new. The
   * quiet filter reads createdAt in that case rather than treating null as
   * the epoch.
   */
  lastInboundAt: string | null;
  /**
   * Against at least one allowance they actually hold.
   *
   * Decided on the server by `limitState`, the same function every refusal
   * uses. Deriving it here would be a seventh copy of a comparison C4 spent a
   * commit reducing to one, and it would disagree the first time an override
   * moved — silently, because both sides would look right.
   */
  overLimit: boolean;
  /** Which allowances are full, for the tooltip. Empty when overLimit is false. */
  overLimitReasons: string[];
  channels: Array<{
    status: string;
    provisioningState: ProvisioningState;
    provisioningStep: string | null;
    failureReason: string | null;
    failureStep: string | null;
    managedByProvisioner: boolean;
    apiPort: number | null;
    deploymentName: string | null;
    /**
     * When a gateway was first built for this subscriber.
     *
     * What separates "never finished setup" from "was working and dropped".
     * Already sent by the list endpoint; the type simply had not claimed it.
     */
    provisionedAt: string | null;
  }>;
};

type RollupUsage = {
  asOf: string | null;
  items: Array<{ metric: string; current: string; limit: string | null }>;
};

type PlatformSession = {
  platformRole?: 'OWNER' | 'SUPPORT';
  platformPermissions?: string[];
};

type PlatformViewGrant = {
  organization: { id: string; name: string };
  accessToken: string;
  expiresAt: string;
  durationSeconds: number;
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

const DAY_MS = 86_400_000;

/**
 * The four questions an owner opens this screen to ask.
 *
 * Written as predicates over one subscriber, at module scope, so the filter
 * chips and the counted header cannot drift: the header counts rows that would
 * survive each filter, using the filter itself rather than a parallel rule.
 * A header that disagrees with the list under it is worse than no header —
 * it is the only number on the page nobody can check by looking.
 */
const RISKS = {
  /**
   * A trial that runs out inside a week — expired ones included.
   *
   * Deliberate: this is a call list, and somebody whose trial ended yesterday
   * is the most urgent name on it. Excluding them would hide exactly the rows
   * the filter exists to surface.
   */
  trial7: {
    label: 'Trial ending ≤ 7d',
    match: (subscriber: Subscriber) => {
      const deadline = trialDeadline(subscriber);
      return deadline !== null && deadline <= Date.now() + 7 * DAY_MS;
    },
  },
  /** Against an allowance they hold. Decided by the server, never here. */
  overLimit: {
    label: 'Over a limit',
    match: (subscriber: Subscriber) => subscriber.overLimit,
  },
  /**
   * Had a working gateway and does not now.
   *
   * `provisionedAt` is what makes this different from "setup never finished":
   * a subscriber stuck at AWAITING_QR on day one needs onboarding, one that
   * was ACTIVE and fell back to AWAITING_QR is an outage somebody is living
   * through. D-16 is why the second state is reachable at all — before it the
   * machine only ever promoted, and a dropped gateway read as connected.
   */
  disconnected: {
    label: 'Channel disconnected',
    match: (subscriber: Subscriber) => {
      const channel = subscriber.channels[0];
      return Boolean(channel?.provisionedAt) && channel.provisioningState !== 'ACTIVE';
    },
  },
  /**
   * Nobody has written in for a fortnight.
   *
   * Falls back to createdAt when there has never been an inbound message, so a
   * subscriber who signed up this morning is new rather than quiet. Treating
   * null as "never, therefore ancient" would put every fresh signup on the
   * at-risk list on their first day, which is the day they need it least.
   */
  quiet14: {
    label: 'No inbound ≥ 14d',
    match: (subscriber: Subscriber) => {
      const since = subscriber.lastInboundAt ?? subscriber.createdAt;
      const parsed = new Date(since).getTime();
      return Number.isFinite(parsed) && Date.now() - parsed >= 14 * DAY_MS;
    },
  },
} as const;

type RiskKey = keyof typeof RISKS;
const RISK_KEYS = Object.keys(RISKS) as RiskKey[];

/** At risk means any of the four. The header and the chips share this. */
function atRisk(subscriber: Subscriber): boolean {
  return RISK_KEYS.some((key) => RISKS[key].match(subscriber));
}

function inTrial(subscriber: Subscriber): boolean {
  const deadline = trialDeadline(subscriber);
  return deadline !== null && deadline > Date.now();
}

/** Coarse on purpose: an owner scanning wants "3w", not a timestamp. */
function quietLabel(subscriber: Subscriber): string {
  if (!subscriber.lastInboundAt) return 'never';
  const days = Math.floor((Date.now() - new Date(subscriber.lastInboundAt).getTime()) / DAY_MS);
  if (days <= 0) return 'today';
  if (days < 14) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * How long is left, in the console's own words.
 *
 * Coarse on purpose: an owner scanning a table wants to know who is about to
 * fall off, not that an organization has 2h 41m. Minutes appear only inside the
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
  const [active, setActive] = useState<RiskKey[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | Subscriber['status']>('ALL');
  const [planFilter, setPlanFilter] = useState('ALL');
  /*
    The editions an owner may activate somebody onto.

    Read from the catalogue rather than written into this file. The three menu
    items here were 'GROWTH', 'BUSINESS' and 'ENTERPRISE', and the parameter
    type was that same union - so a fourth edition was not merely unlisted, it
    was unrepresentable: activatePlan(sub, 'STANDARD') did not compile. That
    also meant STANDARD, a real sellable tier, could never be activated from
    this console at all.
  */
  const [usage, setUsage] = useState<Record<string, RollupUsage>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [destroyTarget, setDestroyTarget] = useState<Subscriber | null>(null);
  const [paymentFailureTarget, setPaymentFailureTarget] = useState<Subscriber | null>(null);
  const [termsTarget, setTermsTarget] = useState<Subscriber | null>(null);
  const [viewTarget, setViewTarget] = useState<Subscriber | null>(null);
  const [viewReason, setViewReason] = useState('');
  const [viewTicketReference, setViewTicketReference] = useState('');
  const [viewBusy, setViewBusy] = useState(false);
  const [platformSession, setPlatformSession] = useState<PlatformSession | null>(null);
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
    const user = JSON.parse(localStorage.getItem('rabitech_user') || '{}') as PlatformSession & { scope?: string };
    if (!token || user.scope !== 'PLATFORM') {
      router.replace('/login');
      return;
    }
    setPlatformSession(user);
    load();
  }, [load, router]);

  useEffect(() => {
    const initialSearch = new URLSearchParams(window.location.search).get('search');
    if (initialSearch) setQuery(initialSearch.slice(0, 120));
  }, []);

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
      toast.success('Subscriber created.');
      setForm(EMPTY_FORM);
      setOpen(false);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to create subscriber');
    } finally {
      setSaving(false);
    }
  };

  const canOpenSubscriber = platformSession?.platformRole === 'OWNER' || (
    platformSession?.platformPermissions?.includes('subscriber:view-as')
    && platformSession.platformPermissions.includes('subscriber:content:read')
  );
  const normalizedViewReason = viewReason.trim().replace(/\s+/g, ' ');
  const validViewReason = Array.from(normalizedViewReason).length >= 12 && /\p{L}/u.test(normalizedViewReason);
  const normalizedTicketReference = viewTicketReference.trim().toUpperCase();
  const validTicketReference = /^SUP-[0-9]{6,}$/.test(normalizedTicketReference)
    && normalizedTicketReference.length <= 32;

  const closeViewDialog = () => {
    setViewTarget(null);
    setViewReason('');
    setViewTicketReference('');
  };

  const openSubscriberWorkspace = async () => {
    if (!viewTarget || !validViewReason || !validTicketReference) return;
    setViewBusy(true);
    try {
      const { data } = await api.post<PlatformViewGrant>(
        `/api/platform/subscribers/${viewTarget.id}/view-as`,
        { reason: normalizedViewReason, ticketReference: normalizedTicketReference },
      );
      setViewAsOrg({
        id: data.organization.id,
        name: data.organization.name,
        accessToken: data.accessToken,
        expiresAt: data.expiresAt,
      });
      closeViewDialog();
      router.push('/inbox');
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not open subscriber workspace');
    } finally {
      setViewBusy(false);
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

  const markPaymentFailed = async (subscriber: Subscriber) => {
    setActionId(subscriber.id);
    try {
      await api.post(`/api/platform/subscribers/${subscriber.id}/billing/mark-failed`, { reason: 'Manual payment failure' });
      toast.success('Payment failure applied');
      setPaymentFailureTarget(null);
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

  /*
    Every active chip must match — narrowing, not widening. Computed here
    rather than in the map below so the "showing N of M" line and the rows are
    the same array, and cannot report different totals.
  */
  const normalizedQuery = query.trim().slice(0, 120).toLocaleLowerCase();
  const availablePlans = Array.from(new Set(subscribers.map((subscriber) => subscriber.tier))).sort();
  const visible = subscribers.filter((subscriber) => {
    if (!active.every((key) => RISKS[key].match(subscriber))) return false;
    if (statusFilter !== 'ALL' && subscriber.status !== statusFilter) return false;
    if (planFilter !== 'ALL' && subscriber.tier !== planFilter) return false;
    if (!normalizedQuery) return true;
    return [subscriber.name, subscriber.slug, subscriber.tier]
      .some((candidate) => candidate.toLocaleLowerCase().includes(normalizedQuery));
  });

  const hasFilters = active.length > 0 || Boolean(normalizedQuery) || statusFilter !== 'ALL' || planFilter !== 'ALL';

  const clearFilters = () => {
    setActive([]);
    setQuery('');
    setStatusFilter('ALL');
    setPlanFilter('ALL');
  };

  const stateVariant = (state?: ProvisioningState) => {
    if (state === 'ACTIVE') return 'default' as const;
    if (state === 'FAILED') return 'destructive' as const;
    return 'secondary' as const;
  };

  const subscriberActions = (subscriber: Subscriber, expanded = false) => {
    const channel = subscriber.channels[0];
    return (
      <div className={cn('flex items-center gap-1.5', expanded && 'w-full lg:w-auto')}>
        {canOpenSubscriber ? (
          <Button
            size="sm"
            variant="outline"
            className={cn('h-8', expanded && 'flex-1 lg:flex-none')}
            title="Open this subscriber's workspace read-only"
            onClick={() => setViewTarget(subscriber)}
          >
            <Eye className="h-3.5 w-3.5" /> View
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className={cn('h-8 px-2.5', expanded && 'flex-1 lg:flex-none')}
          title="Plan override, quota, discount and credit"
          onClick={() => setTermsTarget(subscriber)}
        >
          <Tag className="h-3.5 w-3.5" />
          <span className={expanded ? 'lg:sr-only' : 'sr-only'}>Terms</span>
          {subscriber.planOverride ? <span className="ms-1 h-1.5 w-1.5 rounded-full bg-warning" aria-label="Has override" /> : null}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className={cn('h-8 px-2.5', expanded && 'flex-1 lg:flex-none')}
          title="Invoices, payments and receipts"
          onClick={() => setFinanceTarget(subscriber)}
        >
          <Wallet className="h-3.5 w-3.5" />
          <span className={expanded ? 'lg:sr-only' : 'sr-only'}>Finance</span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 w-8 p-0"
              disabled={actionId === subscriber.id}
              title="Actions"
            >
              {actionId === subscriber.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              <span className="sr-only">More actions</span>
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
            {channel && !channel.managedByProvisioner ? (
              <DropdownMenuItem onSelect={() => setChannelTarget(subscriber)}>
                <Plug /> Edit OpenWA channel
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            {subscriber.subscriptions[0]?.trialEndsAt ? (
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
            ) : null}
            <DropdownMenuItem onSelect={() => setPaymentFailureTarget(subscriber)}>
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
  };

  return (
    <main className="min-h-full bg-background text-foreground">
      <section className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Customer operations</p>
            <h1 className="mt-1 text-2xl font-semibold">Subscribers</h1>
            <p className="mt-1 text-sm text-muted-foreground">Monitor service, usage, billing, and channel health.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn('me-2 h-4 w-4', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="me-2 h-4 w-4" /> New subscriber
            </Button>
          </div>
        </header>

        <dl className="mt-5 grid overflow-hidden rounded-md border border-border bg-card grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-x-reverse lg:divide-border">
          {([
            ['Total', subscribers.length, Building2, ''],
            ['Active', subscribers.filter((subscriber) => subscriber.status === 'ACTIVE').length, Activity, 'text-success'],
            ['In trial', subscribers.filter(inTrial).length, Clock, 'text-primary'],
            ['At risk', subscribers.filter(atRisk).length, CircleAlert, 'text-warning'],
          ] as Array<[string, number, typeof Building2, string]>).map(([label, value, Icon, tone], index) => (
            <div
              key={label}
              className={cn(
                'flex min-h-20 items-center gap-3 px-4 py-3',
                index < 2 && 'border-b border-border lg:border-b-0',
              )}
            >
              <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground', tone)}>
                <Icon className="h-4 w-4" />
              </span>
              <div>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className={cn('mt-0.5 text-xl font-semibold tabular-nums', tone)} dir="ltr">{value}</dd>
              </div>
            </div>
          ))}
        </dl>

        <div className="mt-4">
          <GatewayAlerts health={health} />
        </div>

        <div className="mt-4 rounded-md border border-border bg-card">
          <div className="grid gap-3 border-b border-border p-3 lg:grid-cols-[minmax(240px,1fr)_160px_160px_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Label htmlFor="subscriber-search" className="sr-only">Search subscribers</Label>
              <Input
                id="subscriber-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name or slug"
                maxLength={120}
                className="h-9 ps-9"
              />
            </div>
            <Label className="sr-only" htmlFor="subscriber-status">Subscriber status</Label>
            <select
              id="subscriber-status"
              className="select-field h-9"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as 'ALL' | Subscriber['status'])}
            >
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
              <option value="PROVISIONING">Provisioning</option>
            </select>
            <Label className="sr-only" htmlFor="subscriber-plan">Subscriber plan</Label>
            <select
              id="subscriber-plan"
              className="select-field h-9"
              value={planFilter}
              onChange={(event) => setPlanFilter(event.target.value)}
            >
              <option value="ALL">All plans</option>
              {availablePlans.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
            </select>
            {hasFilters ? (
              <Button size="sm" variant="ghost" onClick={clearFilters}>Clear</Button>
            ) : <span aria-hidden />}
          </div>

          <div className="flex flex-wrap items-center gap-2 p-3">
            <span className="me-1 text-xs font-medium text-muted-foreground">Risk</span>
            {RISK_KEYS.map((key) => {
              const selected = active.includes(key);
              return (
                <Button
                  key={key}
                  size="sm"
                  variant={selected ? 'default' : 'outline'}
                  aria-pressed={selected}
                  onClick={() => setActive((current) => (
                    current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]
                  ))}
                  className="h-8"
                >
                  {RISKS[key].label}
                  <span className="ms-1.5 tabular-nums opacity-70" dir="ltr">
                    {subscribers.filter(RISKS[key].match).length}
                  </span>
                </Button>
              );
            })}
            {hasFilters ? (
              <span className="ms-auto text-xs text-muted-foreground" role="status">
                Showing {visible.length} of {subscribers.length}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-md border border-border bg-card">
          <div className="hidden min-w-[1040px] grid-cols-[minmax(175px,1.3fr)_minmax(115px,0.8fr)_minmax(175px,1.1fr)_minmax(140px,0.9fr)_80px_78px_178px] gap-4 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground lg:grid">
            <span>Subscriber</span>
            <span>Plan</span>
            <span>Usage</span>
            <span>Channel</span>
            <span>Last inbound</span>
            <span title="Status poll and internal self-send probe">Health</span>
            <span className="sr-only">Actions</span>
          </div>

          {loading ? <p className="px-4 py-10 text-center text-sm text-muted-foreground">Loading subscribers...</p> : null}
          {!loading && loadError ? (
            <ErrorState
              compact
              title="Could not load subscribers"
              description="The subscriber list could not be loaded. Check the platform connection and try again."
              retryLabel="Retry"
              onRetry={load}
            />
          ) : null}
          {!loading && !loadError && subscribers.length === 0 ? (
            <EmptyState compact title="No subscribers" description="Create a subscriber to see workspaces in this console." />
          ) : null}
          {!loading && !loadError && subscribers.length > 0 && visible.length === 0 ? (
            <EmptyState
              compact
              title="No subscribers match these filters"
              description={`All ${subscribers.length} are hidden by the filters above. Clear them to see the full list.`}
            />
          ) : null}

          {!loading && !loadError && visible.map((subscriber) => {
            const channel = subscriber.channels[0];
            return (
              <article
                key={subscriber.id}
                aria-label={subscriber.name}
                className={cn(
                  'grid grid-cols-2 gap-x-4 gap-y-4 border-b border-border px-4 py-4 text-sm last:border-b-0',
                  'lg:min-w-[1040px] lg:grid-cols-[minmax(175px,1.3fr)_minmax(115px,0.8fr)_minmax(175px,1.1fr)_minmax(140px,0.9fr)_80px_78px_178px] lg:items-center lg:gap-4 lg:py-3',
                  atRisk(subscriber) && 'bg-warning/[0.025]',
                )}
              >
                <div className="col-span-2 min-w-0 lg:col-span-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{subscriber.name}</span>
                    {subscriber.overLimit ? (
                      <CircleAlert className="h-4 w-4 shrink-0 text-warning" aria-label="Over a plan limit" />
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr">{subscriber.slug}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1" title="Users"><Users className="h-3.5 w-3.5" />{subscriber._count.users}</span>
                    <span className="flex items-center gap-1" title="WhatsApp sessions"><MessageCircle className="h-3.5 w-3.5" />{subscriber._count.whatsappSessions}</span>
                    <span
                      className={cn('flex items-center gap-1', subscriber.overLimitReasons.includes('workspaces') && 'font-semibold text-warning')}
                      title="Branches"
                    >
                      <Building2 className="h-3.5 w-3.5" />{subscriber.workspaceCount}
                    </span>
                    {!subscriber.emailVerifiedAt ? <span className="text-warning">Email pending</span> : null}
                  </div>
                </div>

                <div className="min-w-0">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground lg:hidden">Plan</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={subscriber.subscriptions[0]?.status === 'ACTIVE' ? 'default' : 'secondary'}>{subscriber.tier}</Badge>
                    {subscriber.planOverride ? <Badge variant="outline">Override</Badge> : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{subscriber.subscriptions[0]?.status || 'No subscription'}</p>
                  {trialLabel(subscriber) ? (
                    <p className={cn('mt-1 truncate text-xs', trialExpired(subscriber) ? 'text-danger' : 'text-warning')}>
                      {trialLabel(subscriber)}
                    </p>
                  ) : null}
                  {subscriber.suspendAt ? (
                    <p className="mt-1 flex items-center gap-1 truncate text-xs text-destructive" title={subscriber.suspendReason ?? undefined}>
                      <AlarmClock className="h-3 w-3 shrink-0" />
                      {new Date(subscriber.suspendAt) <= new Date() ? 'Cut-off due' : `Cut-off ${subscriber.suspendAt.slice(0, 10)}`}
                    </p>
                  ) : null}
                </div>

                <div className="col-span-2 min-w-0 lg:col-span-1">
                  <p className="mb-2 text-xs font-medium text-muted-foreground lg:hidden">Usage</p>
                  <dl className="grid grid-cols-3 gap-3 lg:block lg:space-y-1.5">
                    {[
                      ['Contacts', 'active_contacts'],
                      ['Outbound', 'messages_outbound'],
                      ['Campaign', 'campaign_sends'],
                    ].map(([label, metric]) => (
                      <div key={metric} className="min-w-0 lg:flex lg:items-center lg:justify-between lg:gap-2">
                        <dt className="truncate text-xs text-muted-foreground lg:shrink-0">{label}</dt>
                        <dd className="mt-0.5 break-words font-mono text-[11px] font-medium leading-4 lg:mt-0 lg:shrink-0 lg:whitespace-nowrap" dir="ltr">{usageValue(subscriber.id, metric)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>

                <div className="min-w-0">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground lg:hidden">Channel</p>
                  <div className="flex items-center gap-2">
                    <Badge variant={stateVariant(channel?.provisioningState)}>
                      {channel?.provisioningState || subscriber.status}
                    </Badge>
                    {channel?.apiPort ? <span className="font-mono text-xs text-muted-foreground">:{channel.apiPort}</span> : null}
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground" title={channel?.failureReason || undefined}>
                    {channel?.failureReason
                      || channel?.provisioningStep?.replaceAll('_', ' ')
                      || (channel?.managedByProvisioner ? 'Managed gateway' : 'Manually configured')}
                  </p>
                </div>

                <div className="min-w-0">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground lg:hidden">Last inbound</p>
                  <span
                    className={cn('text-xs', RISKS.quiet14.match(subscriber) ? 'font-medium text-warning' : 'text-muted-foreground')}
                    title={subscriber.lastInboundAt ?? 'No inbound message has ever arrived'}
                  >
                    {quietLabel(subscriber)}
                  </span>
                </div>

                <div className="min-w-0">
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground lg:hidden">Health</p>
                  <HealthCell organizationId={subscriber.id} health={health} onRefresh={refreshHealth} />
                </div>

                <div className="col-span-2 flex justify-end lg:col-span-1">
                  {subscriberActions(subscriber, true)}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <Dialog
        open={Boolean(viewTarget)}
        onOpenChange={(next) => {
          if (!next && !viewBusy) {
            closeViewDialog();
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>View workspace - {viewTarget?.name}</DialogTitle>
            <DialogDescription className="sr-only">
              Record the support case and reason for this time-limited customer-content access.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="platform-view-ticket">Ticket reference</Label>
              <Input
                id="platform-view-ticket"
                value={viewTicketReference}
                onChange={(event) => setViewTicketReference(event.target.value)}
                placeholder="SUP-001042"
                maxLength={32}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="platform-view-reason">Reason for access</Label>
              <Textarea
                id="platform-view-reason"
                value={viewReason}
                onChange={(event) => setViewReason(event.target.value)}
                placeholder="Investigating the delivery failure reported by the customer"
                maxLength={500}
              />
              <p className="text-caption text-muted-foreground">
                Access lasts 15 minutes. A renewal creates another audit entry.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={viewBusy} onClick={closeViewDialog}>
              Cancel
            </Button>
            <Button
              onClick={openSubscriberWorkspace}
              disabled={viewBusy || !validViewReason || !validTicketReference}
            >
              <Eye className="h-4 w-4" /> {viewBusy ? 'Opening...' : 'Open for 15 minutes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

      <Dialog
        open={Boolean(paymentFailureTarget)}
        onOpenChange={(open) => {
          if (!open && actionId !== paymentFailureTarget?.id) setPaymentFailureTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark payment failed</DialogTitle>
            <DialogDescription>
              This suspends service immediately for {paymentFailureTarget?.name}. It does not wait for the normal dunning grace period.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPaymentFailureTarget(null)}
              disabled={actionId === paymentFailureTarget?.id}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => paymentFailureTarget && markPaymentFailed(paymentFailureTarget)}
              disabled={actionId === paymentFailureTarget?.id}
            >
              <Pause className="h-4 w-4" aria-hidden />
              Mark payment failed
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
