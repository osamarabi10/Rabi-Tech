'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  Clock3,
  CreditCard,
  Layers3,
  ListFilter,
  Radio,
  RefreshCw,
  Wallet,
} from 'lucide-react';
import api from '@/lib/api';
import { SubscriberDrawer, type DrawerSubscriber } from '@/components/platform/subscriber-drawer';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/operational-state';
import { cn } from '@/lib/utils';

type Channel = {
  provisioningState: string;
  status: string;
  provisioningStep?: string | null;
  apiPort?: number | null;
  deploymentName?: string | null;
  failureReason?: string | null;
};

type Subscriber = DrawerSubscriber & {
  tier: string;
  suspendAt: string | null;
  emailVerifiedAt: string | null;
  subscriptions: Array<{ planCode: string; status: string; trialEndsAt: string | null }>;
  invoices: Array<{ id: string; status: string; amountDueCents: number | null }>;
  channels?: Channel[];
};

type BillingSummary = {
  mrrCents: number;
  activeSubscriptions: number;
  trials: { open: number; expired: number; potentialCents: number };
  byTier: Record<string, number>;
};

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function trialMsLeft(subscriber: Subscriber): number | null {
  const subscription = subscriber.subscriptions[0];
  if (!subscription || subscription.status !== 'TRIALING' || !subscription.trialEndsAt) return null;
  const deadline = new Date(subscription.trialEndsAt).getTime();
  return Number.isFinite(deadline) ? deadline - Date.now() : null;
}

export default function PlatformHome() {
  const router = useRouter();
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedSubscriber, setSelectedSubscriber] = useState<Subscriber | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const [subscriberResponse, billingResponse] = await Promise.all([
        api.get('/api/platform/subscribers'),
        api.get('/api/platform/billing/summary'),
      ]);
      setSubscribers(
        Array.isArray(subscriberResponse.data)
          ? subscriberResponse.data
          : (subscriberResponse.data?.subscribers ?? []),
      );
      setSummary(billingResponse.data);
    } catch (error: any) {
      if (error?.response?.status === 401 || error?.response?.status === 403) {
        router.replace('/login');
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = subscribers ?? [];
  const channels = useMemo(() => rows.flatMap((subscriber) => subscriber.channels ?? []), [rows]);
  const gatewayStates = useMemo(() => ({
    active: channels.filter((channel) => channel.provisioningState === 'ACTIVE').length,
    awaiting: channels.filter((channel) => channel.provisioningState === 'AWAITING_QR').length,
    failed: channels.filter((channel) => channel.provisioningState === 'FAILED').length,
    other: channels.filter((channel) => !['ACTIVE', 'AWAITING_QR', 'FAILED'].includes(channel.provisioningState)).length,
  }), [channels]);

  const trialsEndingSoon = useMemo(() => rows.filter((subscriber) => {
    const remaining = trialMsLeft(subscriber);
    return remaining !== null && remaining > 0 && remaining < 24 * 60 * 60 * 1000;
  }), [rows]);
  const trialsExpired = useMemo(() => rows.filter((subscriber) => {
    const remaining = trialMsLeft(subscriber);
    return remaining !== null && remaining <= 0;
  }), [rows]);
  const suspended = useMemo(() => rows.filter((subscriber) => subscriber.status === 'SUSPENDED'), [rows]);
  const gatewaysFailed = useMemo(() => rows.filter((subscriber) =>
    (subscriber.channels ?? []).some((channel) => channel.provisioningState === 'FAILED'),
  ), [rows]);
  const unpaid = useMemo(() => rows.filter((subscriber) =>
    (subscriber.invoices ?? []).some((invoice) => invoice.status === 'OPEN'),
  ), [rows]);
  const unverified = useMemo(() => rows.filter((subscriber) => !subscriber.emailVerifiedAt), [rows]);

  const attentionGroups = [
    {
      title: 'Gateway failures',
      tone: 'danger' as const,
      icon: Radio,
      rows: gatewaysFailed.map((subscriber) => ({ subscriber, detail: 'Provisioning or runtime failed' })),
    },
    {
      title: 'Trials ending within 24 hours',
      tone: 'warning' as const,
      icon: Clock3,
      rows: trialsEndingSoon.map((subscriber) => {
        const minutes = Math.max(0, Math.floor((trialMsLeft(subscriber) ?? 0) / 60_000));
        return {
          subscriber,
          detail: minutes < 60 ? `${minutes} minutes left` : `${Math.floor(minutes / 60)} hours left`,
        };
      }),
    },
    {
      title: 'Expired trials',
      tone: 'warning' as const,
      icon: Clock3,
      rows: trialsExpired.map((subscriber) => ({ subscriber, detail: 'Trial access has ended' })),
    },
    {
      title: 'Suspended subscribers',
      tone: 'danger' as const,
      icon: AlertTriangle,
      rows: suspended.map((subscriber) => ({ subscriber, detail: subscriber.suspendReason || 'Service suspended' })),
    },
    {
      title: 'Open invoices',
      tone: 'warning' as const,
      icon: CreditCard,
      rows: unpaid.map((subscriber) => ({
        subscriber,
        detail: `${subscriber.invoices.filter((invoice) => invoice.status === 'OPEN').length} awaiting payment`,
      })),
    },
  ].filter((group) => group.rows.length > 0);

  return (
    <main className="min-h-full bg-background text-foreground">
      <section className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Operations</p>
            <h1 className="mt-1 text-2xl font-semibold">Platform overview</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Revenue, subscriber health, and channel exceptions from the current platform records.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn('me-2 h-4 w-4', loading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/platform/editions">
                <Layers3 className="me-2 h-4 w-4" aria-hidden />
                Editions
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/platform/subscribers">
                <Building2 className="me-2 h-4 w-4" aria-hidden />
                Subscribers
              </Link>
            </Button>
          </div>
        </header>

        {loadError ? (
          <ErrorState
            className="mt-6"
            title="Could not load the platform console"
            description="The platform records could not be reached. Check the backend connection and retry."
            retryLabel="Retry"
            onRetry={load}
          />
        ) : (
          <>
            <dl className="mt-5 grid grid-cols-2 overflow-hidden rounded-md border border-border bg-card lg:grid-cols-4 lg:divide-x lg:divide-border">
              <Metric
                label="Monthly recurring revenue"
                value={summary ? money(summary.mrrCents) : '---'}
                detail={summary ? `${summary.activeSubscriptions} paying subscriptions` : 'Loading billing records'}
                icon={Wallet}
              />
              <Metric
                label="Open trials"
                value={summary ? String(summary.trials.open) : '---'}
                detail={summary?.trials.potentialCents ? `${money(summary.trials.potentialCents)} potential, not revenue` : 'No trial value recorded'}
                icon={Clock3}
              />
              <Metric
                label="Subscribers"
                value={String(rows.length)}
                detail={unverified.length ? `${unverified.length} awaiting email verification` : 'All recorded emails verified'}
                icon={Building2}
              />
              <Metric
                label="Open invoices"
                value={String(unpaid.length)}
                detail={unpaid.length ? 'Requires billing follow-up' : 'No open invoice records'}
                icon={CreditCard}
                tone={unpaid.length ? 'warning' : undefined}
              />
            </dl>

            <section aria-label="Gateway fleet" className="mt-5 rounded-md border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-semibold">
                    <Radio className="h-4 w-4 text-primary" aria-hidden />
                    Gateway fleet
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Current provisioning state across configured channels.</p>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{channels.length} configured</span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
                <GatewayState label="active" value={gatewayStates.active} tone="success" />
                <GatewayState label="awaiting pairing" value={gatewayStates.awaiting} tone="warning" />
                <GatewayState label="failed" value={gatewayStates.failed} tone="danger" />
                <GatewayState label="other states" value={gatewayStates.other} />
              </div>
            </section>

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.65fr)]">
              <section aria-labelledby="attention-heading" className="min-w-0">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Triage</p>
                    <h2 id="attention-heading" className="mt-1 text-lg font-semibold">Needs attention</h2>
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <Link href="/platform/subscribers">
                      Open subscriber list
                      <ArrowRight className="ms-2 h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Button>
                </div>

                <div className="mt-3 overflow-hidden rounded-md border border-border bg-card">
                  {!loading && attentionGroups.length === 0 ? (
                    <div className="px-4 py-8 text-center">
                      <p className="text-sm font-medium">No recorded exception needs action.</p>
                      <p className="mt-1 text-xs text-muted-foreground">This is a snapshot of the loaded records, not a live service canary.</p>
                    </div>
                  ) : null}
                  {attentionGroups.map((group) => (
                    <AttentionGroup
                      key={group.title}
                      {...group}
                      onInspect={setSelectedSubscriber}
                    />
                  ))}
                </div>
              </section>

              <section aria-labelledby="plan-mix-heading" className="min-w-0">
                <div>
                  <p className="text-xs font-semibold uppercase text-muted-foreground">Commercial mix</p>
                  <h2 id="plan-mix-heading" className="mt-1 text-lg font-semibold">Subscribers by edition</h2>
                </div>
                <div className="mt-3 overflow-hidden rounded-md border border-border bg-card">
                  {summary && Object.keys(summary.byTier).length ? (
                    <dl className="divide-y divide-border">
                      {Object.entries(summary.byTier).map(([edition, count]) => (
                        <div key={edition} className="flex items-center justify-between px-4 py-3">
                          <dt className="text-sm font-medium">{edition}</dt>
                          <dd className="font-mono text-sm font-semibold">{count}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="px-4 py-8 text-center text-xs text-muted-foreground">No paying edition mix recorded.</p>
                  )}
                  <Button asChild variant="ghost" className="w-full justify-between rounded-none border-t border-border">
                    <Link href="/platform/editions">
                      Review catalogue
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </Button>
                </div>
              </section>
            </div>
          </>
        )}
      </section>

      <SubscriberDrawer
        subscriber={selectedSubscriber}
        open={Boolean(selectedSubscriber)}
        onOpenChange={(open) => {
          if (!open) setSelectedSubscriber(null);
        }}
      />
    </main>
  );
}

function Metric({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: typeof Wallet;
  tone?: 'warning';
}) {
  return (
    <div className="min-h-28 border-b border-border px-4 py-4 last:border-b-0 lg:border-b-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        <dt>{label}</dt>
      </div>
      <dd className={cn('mt-2 font-mono text-2xl font-semibold', tone === 'warning' && 'text-warning')} dir="ltr">
        <span>{value}</span>
        <span className="mt-1 block font-sans text-xs font-normal text-muted-foreground">{detail}</span>
      </dd>
    </div>
  );
}

function GatewayState({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'success' | 'warning' | 'danger';
}) {
  return (
    <div className="flex min-h-20 items-center gap-3 px-4 py-3">
      <span
        className={cn(
          'h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/40',
          tone === 'success' && 'bg-success',
          tone === 'warning' && 'bg-warning',
          tone === 'danger' && 'bg-destructive',
        )}
        aria-hidden
      />
      <p className="text-sm">
        <strong className="font-mono font-semibold">{value}</strong>{' '}
        <span className="text-muted-foreground">{label}</span>
      </p>
    </div>
  );
}

function AttentionGroup({
  title,
  rows,
  icon: Icon,
  tone,
  onInspect,
}: {
  title: string;
  rows: Array<{ subscriber: Subscriber; detail: string }>;
  icon: typeof Radio;
  tone: 'warning' | 'danger';
  onInspect: (subscriber: Subscriber) => void;
}) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-2 bg-muted/30 px-4 py-2.5">
        <Icon className={cn('h-3.5 w-3.5', tone === 'danger' ? 'text-destructive' : 'text-warning')} aria-hidden />
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="ms-auto font-mono text-xs text-muted-foreground">{rows.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {rows.map(({ subscriber, detail }) => (
          <li key={subscriber.id}>
            <button
              type="button"
              aria-label={`Inspect ${subscriber.name}: ${title}`}
              onClick={() => onInspect(subscriber)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{subscriber.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{detail}</span>
              </span>
              <ListFilter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
