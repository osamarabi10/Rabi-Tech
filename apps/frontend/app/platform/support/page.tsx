'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Clock3,
  Gauge,
  MessageSquareWarning,
  Phone,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { cn } from '@/lib/utils';

type SearchResult = {
  id: string;
  name: string;
  slug: string;
  status: string;
  numbers: Array<{
    id: string;
    label: string;
    phoneNumber: string;
    isActive: boolean;
    channelKind: string | null;
    channelState: string | null;
  }>;
};

type LimitState = 'ok' | 'full' | 'not-included';

type SubscriberDiagnostics = {
  capturedAt: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  plan: {
    source: 'override' | 'subscription' | 'default';
    code: string;
    name: string;
    planVersionId: string;
    version: number;
    priceId: string;
    pricingModel: string;
    billingInterval: string;
    currency: string;
    listPriceCents: number;
    effectivePriceCents: number;
    subscription: {
      id: string;
      status: string;
      provider: string;
      currentPeriodStart: string | null;
      currentPeriodEnd: string | null;
      trialEndsAt: string | null;
      activatedAt: string | null;
    } | null;
    override: {
      active: boolean;
      plan: string | null;
      macQuota: number | null;
      discountPercent: number | null;
      creditCents: number;
      reason: string | null;
      expiresAt: string | null;
      expired: boolean;
    };
  };
  billing: {
    paymentProvider: string;
    latestSubscriptionStatus: string | null;
    suspendAt: string | null;
    suspendReason: string | null;
    downgradeGraceEndsAt: string | null;
    downgradeGraceReason: string | null;
  };
  channels: Array<{
    id: string;
    kind: string;
    status: string;
    state: 'active' | 'connecting' | 'needs_pairing' | 'failed' | 'suspended' | 'inactive';
    provisioningState: string;
    provisioningStep: string | null;
    failureStep: string | null;
    managedByProvisioner: boolean;
    problem: string | null;
    provisionedAt: string | null;
    connectedAt: string | null;
    suspendedAt: string | null;
    lastCheckedAt: string | null;
    credential: {
      status: string;
      lastValidatedAt: string | null;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      qualityRating: string | null;
      messagingTier: string | null;
    } | null;
  }>;
  numbers: Array<{
    id: string;
    label: string;
    phoneNumber: string | null;
    isActive: boolean;
    channelId: string | null;
    channelKind: string | null;
    state: 'active' | 'inactive' | 'unbound' | 'channel_unavailable';
  }>;
  lastInboundAt: string | null;
  recentFailures: Array<{
    source: string;
    occurredAt: string;
    reason: string;
    resolved: boolean;
  }>;
  usagePeriod: { start: string; end: string };
  limits: Array<{
    capability: string;
    label: string;
    current: string;
    limit: string | null;
    state: LimitState;
  }>;
  verdict: string;
};

type PlatformSession = {
  scope?: string;
  platformRole?: 'OWNER' | 'SUPPORT';
  platformPermissions?: string[];
};

function displayDate(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
}

function displayMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
}

function displayCount(value: string | null): string {
  if (value === null) return 'Unlimited';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed.toLocaleString('en') : value;
}

function sourceLabel(source: SubscriberDiagnostics['plan']['source']): string {
  if (source === 'override') return 'Current edition override';
  if (source === 'subscription') return 'Pinned subscription';
  return 'Current Free edition';
}

function stateLabel(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateVariant(state: string) {
  if (state === 'active' || state === 'ok') return 'default' as const;
  if (state === 'failed' || state === 'suspended' || state === 'full') return 'destructive' as const;
  return 'secondary' as const;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b border-border py-3 last:border-b-0 sm:border-b-0 sm:border-e sm:px-4 sm:first:ps-0 sm:last:border-e-0">
      <dt className="text-caption font-medium uppercase text-muted-foreground">{label}</dt>
      <dd className={cn('mt-1 break-words text-small font-medium', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

export default function PlatformSupportPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [diagnostics, setDiagnostics] = useState<SubscriberDiagnostics | null>(null);
  const [loadingDiagnostics, setLoadingDiagnostics] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('rabitech_token');
    let session: PlatformSession = {};
    try {
      session = JSON.parse(localStorage.getItem('rabitech_user') || '{}');
    } catch {
      session = {};
    }
    const allowed = session.platformRole === 'OWNER'
      || session.platformPermissions?.includes('subscriber:diagnostics');
    if (!token || session.scope !== 'PLATFORM' || !allowed) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const normalized = query.trim().replace(/\s+/g, ' ');
    if (Array.from(normalized).length < 2) {
      setSearchError('Enter at least 2 characters');
      return;
    }

    setSearching(true);
    setSearchError(null);
    setSearched(true);
    setSelected(null);
    setDiagnostics(null);
    try {
      const { data } = await api.get<{ results: SearchResult[] }>('/api/platform/subscribers/search', {
        params: { q: normalized },
      });
      setResults(data.results);
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      setResults([]);
      setSearchError(error?.response?.data?.error || 'Customer search failed');
    } finally {
      setSearching(false);
    }
  };

  const openDiagnostics = async (result: SearchResult) => {
    setSelected(result);
    setDiagnostics(null);
    setDiagnosticsError(false);
    setLoadingDiagnostics(true);
    try {
      const { data } = await api.get<SubscriberDiagnostics>(
        `/api/platform/subscribers/${result.id}/diagnostics`,
      );
      setDiagnostics(data);
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      setDiagnosticsError(true);
    } finally {
      setLoadingDiagnostics(false);
    }
  };

  if (!ready) return <LayoutSkeleton label="Loading support" rows={7} className="mx-auto max-w-7xl" />;

  const healthy = diagnostics?.verdict.endsWith('look healthy.') ?? false;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="size-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-body font-semibold">Support</h1>
            <p className="truncate text-caption text-muted-foreground">Customer diagnostics</p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <form onSubmit={runSearch} className="flex max-w-2xl items-end gap-2">
          <label className="min-w-0 flex-1">
            <span className="mb-1.5 block text-small font-medium">Customer search</span>
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Customer name or phone"
              placeholder="Name or phone"
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <Button type="submit" disabled={searching} className="shrink-0">
            <Search aria-hidden />
            {searching ? 'Searching' : 'Search'}
          </Button>
        </form>
        {searchError && (
          <p role="alert" className="mt-2 text-small text-destructive">{searchError}</p>
        )}

        <div className="mt-5 grid min-h-[34rem] overflow-hidden border-y border-border lg:grid-cols-[21rem_minmax(0,1fr)]">
          <aside aria-label="Customer search results" className="border-b border-border lg:border-b-0 lg:border-e">
            <div className="flex h-11 items-center justify-between border-b border-border px-3">
              <h2 className="text-small font-semibold">Customers</h2>
              {searched && <span className="text-caption text-muted-foreground">{results.length} found</span>}
            </div>
            <div className="max-h-72 overflow-y-auto lg:max-h-[calc(100vh-15rem)]">
              {!searched && (
                <EmptyState title="No search yet" compact className="min-h-48" />
              )}
              {searched && !searching && results.length === 0 && !searchError && (
                <EmptyState title="No customers found" compact className="min-h-48" />
              )}
              {results.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  onClick={() => openDiagnostics(result)}
                  aria-pressed={selected?.id === result.id}
                  className={cn(
                    'w-full border-b border-border px-3 py-3 text-start transition-colors hover:bg-accent',
                    selected?.id === result.id && 'bg-accent',
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate text-small font-semibold">{result.name}</span>
                      <span className="block truncate text-caption text-muted-foreground">{result.slug}</span>
                    </span>
                    <Badge variant={result.status === 'ACTIVE' ? 'outline' : 'secondary'}>{stateLabel(result.status)}</Badge>
                  </span>
                  <span className="mt-2 block space-y-1">
                    {result.numbers.length === 0 && (
                      <span className="block text-caption text-muted-foreground">No business number</span>
                    )}
                    {result.numbers.map((number) => (
                      <span key={number.id} className="flex min-w-0 items-center gap-1.5 text-caption">
                        <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate font-mono">{number.phoneNumber}</span>
                        {number.channelKind && (
                          <span className="truncate text-muted-foreground">{number.channelKind.replace('WHATSAPP_', '')}</span>
                        )}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section aria-label="Customer diagnostics" className="min-w-0">
            {!selected && (
              <EmptyState title="No customer selected" compact className="min-h-80" />
            )}
            {selected && loadingDiagnostics && (
              <LayoutSkeleton label={`Loading diagnostics for ${selected.name}`} rows={7} />
            )}
            {selected && diagnosticsError && (
              <ErrorState
                title="Diagnostics unavailable"
                retryLabel="Retry"
                onRetry={() => openDiagnostics(selected)}
                compact
                className="min-h-80"
              />
            )}
            {diagnostics && (
              <div>
                <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <h2 className="truncate text-body font-semibold">{diagnostics.organization.name}</h2>
                    </div>
                    <p className="mt-1 text-caption text-muted-foreground">
                      Captured {displayDate(diagnostics.capturedAt)}
                    </p>
                  </div>
                  <Badge variant={diagnostics.organization.status === 'ACTIVE' ? 'outline' : 'destructive'}>
                    {stateLabel(diagnostics.organization.status)}
                  </Badge>
                </div>

                <div
                  role="status"
                  className={cn(
                    'flex items-start gap-3 border-b px-4 py-4 text-small font-medium',
                    healthy
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100'
                      : 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
                  )}
                >
                  {healthy
                    ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                    : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
                  <span>{diagnostics.verdict}</span>
                </div>

                <section className="border-b border-border px-4 py-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Gauge className="size-4 text-muted-foreground" aria-hidden />
                    <h3 className="text-small font-semibold">Plan and billing</h3>
                  </div>
                  <dl className="grid sm:grid-cols-2 xl:grid-cols-4">
                    <Fact label="Effective plan" value={`${diagnostics.plan.name} (${diagnostics.plan.code})`} />
                    <Fact label="Terms" value={`Version ${diagnostics.plan.version} · ${sourceLabel(diagnostics.plan.source)}`} />
                    <Fact
                      label="Price"
                      value={`${displayMoney(diagnostics.plan.effectivePriceCents, diagnostics.plan.currency)} · ${stateLabel(diagnostics.plan.billingInterval)}`}
                    />
                    <Fact
                      label="Subscription"
                      value={diagnostics.plan.subscription?.status ?? diagnostics.billing.latestSubscriptionStatus ?? 'None'}
                    />
                  </dl>
                  <dl className="mt-1 grid sm:grid-cols-2 xl:grid-cols-4">
                    <Fact label="Plan version ID" value={diagnostics.plan.planVersionId} mono />
                    <Fact label="Price ID" value={diagnostics.plan.priceId} mono />
                    <Fact label="Provider" value={diagnostics.billing.paymentProvider} />
                    <Fact label="Last inbound" value={displayDate(diagnostics.lastInboundAt)} />
                  </dl>
                  {diagnostics.plan.override.active && (
                    <div className="mt-3 border-s-2 border-primary ps-3 text-small">
                      <p className="font-medium">Override active</p>
                      <p className="mt-0.5 text-muted-foreground">
                        {diagnostics.plan.override.reason || 'No reason recorded'}
                        {diagnostics.plan.override.expiresAt
                          ? ` · expires ${displayDate(diagnostics.plan.override.expiresAt)}`
                          : ' · no expiry'}
                      </p>
                    </div>
                  )}
                </section>

                <section className="border-b border-border px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Server className="size-4 text-muted-foreground" aria-hidden />
                      <h3 className="text-small font-semibold">Channels and numbers</h3>
                    </div>
                    <span className="text-caption text-muted-foreground">{diagnostics.numbers.length} numbers</span>
                  </div>
                  <div className="divide-y divide-border border-y border-border">
                    {diagnostics.channels.length === 0 && (
                      <p className="py-4 text-small text-muted-foreground">No channel configured</p>
                    )}
                    {diagnostics.channels.map((channel) => (
                      <div key={channel.id} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <div className="min-w-0">
                          <p className="text-small font-medium">{stateLabel(channel.kind)}</p>
                          <p className="mt-0.5 text-caption text-muted-foreground">
                            {channel.problem || `Last checked ${displayDate(channel.lastCheckedAt)}`}
                          </p>
                        </div>
                        <Badge variant={stateVariant(channel.state)}>{stateLabel(channel.state)}</Badge>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {diagnostics.numbers.map((number) => (
                      <div key={number.id} className="flex min-w-0 items-center justify-between gap-3 border-b border-border py-2">
                        <div className="min-w-0">
                          <p className="truncate font-mono text-small">{number.phoneNumber || 'Number not reported'}</p>
                          <p className="truncate text-caption text-muted-foreground">{number.label} · {number.channelKind || 'Unbound'}</p>
                        </div>
                        <Badge variant={stateVariant(number.state)}>{stateLabel(number.state)}</Badge>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="border-b border-border px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Clock3 className="size-4 text-muted-foreground" aria-hidden />
                      <h3 className="text-small font-semibold">Limits this month</h3>
                    </div>
                    <span className="text-caption text-muted-foreground">
                      Since {displayDate(diagnostics.usagePeriod.start)}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-small">
                      <thead className="text-start text-caption uppercase text-muted-foreground">
                        <tr className="border-b border-border">
                          <th className="py-2 text-start font-medium">Allowance</th>
                          <th className="py-2 text-end font-medium">Current</th>
                          <th className="py-2 text-end font-medium">Limit</th>
                          <th className="py-2 text-end font-medium">State</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {diagnostics.limits.map((item) => (
                          <tr key={item.capability}>
                            <td className="py-2.5 font-medium">{item.label}</td>
                            <td className="py-2.5 text-end font-mono">{displayCount(item.current)}</td>
                            <td className="py-2.5 text-end font-mono">{displayCount(item.limit)}</td>
                            <td className="py-2.5 text-end">
                              <Badge variant={stateVariant(item.state)}>{stateLabel(item.state)}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="px-4 py-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <MessageSquareWarning className="size-4 text-muted-foreground" aria-hidden />
                      <h3 className="text-small font-semibold">Recent failures</h3>
                    </div>
                    <span className="text-caption text-muted-foreground">Last 30 days</span>
                  </div>
                  {diagnostics.recentFailures.length === 0 ? (
                    <p className="py-3 text-small text-muted-foreground">No recent failures</p>
                  ) : (
                    <div className="divide-y divide-border border-y border-border">
                      {diagnostics.recentFailures.map((failure, index) => (
                        <div key={`${failure.occurredAt}-${index}`} className="grid gap-1 py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:gap-3">
                          <p className="text-caption font-medium text-muted-foreground">{failure.source}</p>
                          <p className="text-small">{failure.reason}</p>
                          <p className="text-caption text-muted-foreground">{displayDate(failure.occurredAt)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
