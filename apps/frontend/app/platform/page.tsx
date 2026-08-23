'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  Building2,
  Clock,
  CreditCard,
  RefreshCw,
  Settings2,
  Users,
  Wallet,
  WifiOff,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What the platform owner sees first.
 *
 * There was no such page. Signing in as the owner dropped you straight into a
 * subscriber table — a list sorted by nothing in particular, with no answer to
 * the only question worth asking on arrival: is anything wrong right now.
 *
 * Every figure here is a link into the thing it counts. A dashboard that
 * reports a problem and gives you no way to reach it is a dashboard that makes
 * you open another tab.
 *
 * ## Nothing here is computed twice
 *
 * The tiles read the same endpoints the subscriber table reads. A second
 * "dashboard" query with its own definition of "active" is how a console comes
 * to disagree with itself, and the owner is left deciding which page is lying.
 */

type Subscriber = {
  id: string;
  name: string;
  status: string;
  tier: string;
  suspendAt: string | null;
  emailVerifiedAt: string | null;
  subscriptions: Array<{ planCode: string; status: string; trialEndsAt: string | null }>;
  invoices: Array<{ id: string; status: string; amountDueCents: number | null }>;
  channels?: Array<{ provisioningState: string; status: string }>;
};

type BillingSummary = {
  mrrCents: number;
  activeSubscriptions: number;
  trials: { open: number; expired: number; potentialCents: number };
  byTier: Record<string, number>;
};

function money(cents: number): string {
  return `${(cents / 100).toLocaleString('en-US')} USD`;
}

/** Hours and minutes left, or null when this subscriber is not on a trial. */
function trialMsLeft(subscriber: Subscriber): number | null {
  const raw = subscriber.subscriptions[0];
  if (!raw || raw.status !== 'TRIALING' || !raw.trialEndsAt) return null;
  const parsed = new Date(raw.trialEndsAt).getTime();
  return Number.isFinite(parsed) ? parsed - Date.now() : null;
}

export default function PlatformHome() {
  const router = useRouter();
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, billing] = await Promise.all([
        api.get('/api/platform/subscribers'),
        api.get('/api/platform/billing/summary'),
      ]);
      setSubscribers(Array.isArray(list.data) ? list.data : (list.data?.subscribers ?? []));
      setSummary(billing.data);
    } catch (error: any) {
      if (error?.response?.status === 401 || error?.response?.status === 403) {
        router.replace('/login');
        return;
      }
      toast.error('Could not load the console');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = subscribers ?? [];

  /*
   * Derived here rather than asked of the server, because these are questions
   * about the same list the table below already shows. A separate endpoint
   * would be a second definition of "expiring today".
   */
  const trialsEndingSoon = rows.filter((s) => {
    const ms = trialMsLeft(s);
    return ms !== null && ms > 0 && ms < 24 * 3600_000;
  });
  const trialsExpired = rows.filter((s) => {
    const ms = trialMsLeft(s);
    return ms !== null && ms <= 0;
  });
  const suspended = rows.filter((s) => s.status === 'SUSPENDED');
  const gatewaysDown = rows.filter((s) =>
    (s.channels ?? []).some((c) => c.provisioningState === 'FAILED'),
  );
  const unpaid = rows.filter((s) => (s.invoices ?? []).some((i) => i.status === 'OPEN'));
  const unverified = rows.filter((s) => !s.emailVerifiedAt);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Platform control</h1>
          <p className="mt-1 text-caption text-muted-foreground">
            Everything that needs a person, in one place.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={cn('me-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/platform/staff">
              <Users className="me-1.5 h-3.5 w-3.5" />
              Staff
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/platform/settings">
              <Settings2 className="me-1.5 h-3.5 w-3.5" />
              Settings
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/platform/subscribers">
              <Building2 className="me-1.5 h-3.5 w-3.5" />
              Subscribers
            </Link>
          </Button>
        </div>
      </div>

      {/*
        Money first, and the two numbers kept apart. Trial value is what this
        would be worth if every open trial converted, which is not revenue and
        must never be added to it.
      */}
      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Monthly recurring revenue"
          value={summary ? money(summary.mrrCents) : '—'}
          hint={summary ? `${summary.activeSubscriptions} paying` : undefined}
          icon={<Wallet className="h-4 w-4" />}
        />
        <Tile
          label="Open trials"
          value={summary ? String(summary.trials.open) : '—'}
          hint={summary && summary.trials.potentialCents > 0 ? `${money(summary.trials.potentialCents)} if all convert` : undefined}
          icon={<Clock className="h-4 w-4" />}
          href="/platform/subscribers"
        />
        <Tile
          label="Subscribers"
          value={String(rows.length)}
          hint={unverified.length > 0 ? `${unverified.length} email unverified` : undefined}
          icon={<Building2 className="h-4 w-4" />}
          href="/platform/subscribers"
        />
        <Tile
          label="Unpaid invoices"
          value={String(unpaid.length)}
          tone={unpaid.length > 0 ? 'warning' : undefined}
          icon={<CreditCard className="h-4 w-4" />}
          href="/platform/subscribers"
        />
      </div>

      {/*
        What needs a person today. Each block renders only when it has
        something in it — a permanent "0 gateways down" is a row that never
        earns its line, and a console full of zeroes trains you to skim past
        the one that isn't.
      */}
      <section className="mt-8">
        <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
          Needs attention
        </h2>

        {!loading &&
          gatewaysDown.length === 0 &&
          trialsEndingSoon.length === 0 &&
          trialsExpired.length === 0 &&
          suspended.length === 0 &&
          unpaid.length === 0 && (
            <p className="mt-3 rounded-lg border border-border bg-muted/30 p-4 text-caption text-muted-foreground">
              Nothing needs a person right now.
            </p>
          )}

        <div className="mt-3 space-y-3">
          <AttentionBlock
            title="Gateways down"
            tone="danger"
            icon={<WifiOff className="h-4 w-4" />}
            items={gatewaysDown.map((s) => ({ id: s.id, name: s.name, note: 'provisioning failed' }))}
          />
          <AttentionBlock
            title="Trials expiring within a day"
            tone="warning"
            icon={<Clock className="h-4 w-4" />}
            items={trialsEndingSoon.map((s) => {
              const ms = trialMsLeft(s) ?? 0;
              const mins = Math.floor(ms / 60_000);
              return {
                id: s.id,
                name: s.name,
                note: mins < 60 ? `${mins}m left` : `${Math.floor(mins / 60)}h ${mins % 60}m left`,
              };
            })}
          />
          <AttentionBlock
            title="Trials expired, not converted"
            tone="warning"
            icon={<Clock className="h-4 w-4" />}
            items={trialsExpired.map((s) => ({ id: s.id, name: s.name, note: 'locked out' }))}
          />
          <AttentionBlock
            title="Suspended"
            tone="danger"
            icon={<AlertTriangle className="h-4 w-4" />}
            items={suspended.map((s) => ({ id: s.id, name: s.name, note: s.suspendAt ? 'dunning' : 'manual' }))}
          />
          <AttentionBlock
            title="Unpaid invoices"
            tone="warning"
            icon={<CreditCard className="h-4 w-4" />}
            items={unpaid.map((s) => ({
              id: s.id,
              name: s.name,
              note: `${(s.invoices ?? []).filter((i) => i.status === 'OPEN').length} open`,
            }))}
          />
        </div>
      </section>

      {summary && Object.keys(summary.byTier).length > 0 && (
        <section className="mt-8">
          <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
            Paying subscribers by plan
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(summary.byTier).map(([plan, count]) => (
              <span
                key={plan}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-caption"
              >
                {plan} <b className="numeric ms-1">{count}</b>
              </span>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function Tile({
  label,
  value,
  hint,
  icon,
  href,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  href?: string;
  tone?: 'warning';
}) {
  const body = (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 transition-colors',
        href && 'hover:border-primary/40',
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-caption">{label}</span>
      </div>
      <p className={cn('numeric mt-2 text-2xl font-bold', tone === 'warning' && 'text-warning')}>
        {value}
      </p>
      {/* A hint that isn't there renders as nothing, never as an empty line. */}
      {hint && <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p>}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function AttentionBlock({
  title,
  items,
  icon,
  tone,
}: {
  title: string;
  items: Array<{ id: string; name: string; note: string }>;
  icon: React.ReactNode;
  tone: 'warning' | 'danger';
}) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p
        className={cn(
          'flex items-center gap-2 font-semibold',
          tone === 'danger' ? 'text-danger' : 'text-warning',
        )}
      >
        {icon}
        {title}
        <span className="numeric ms-auto text-caption text-muted-foreground">{items.length}</span>
      </p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 text-caption">
            {/* Straight to the row that can fix it. */}
            <Link href="/platform/subscribers" className="truncate hover:text-primary">
              {item.name}
            </Link>
            <span className="shrink-0 text-micro text-muted-foreground">{item.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
