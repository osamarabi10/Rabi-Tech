'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  Check,
  CircleAlert,
  Eye,
  History,
  Layers3,
  Loader2,
  RefreshCw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState } from '@/components/ui/operational-state';
import { cn } from '@/lib/utils';

/**
 * The edition catalogue — the product's offer, not one subscriber's deal.
 *
 * Until now this lived in a TypeScript constant, so changing a price meant a
 * deploy. The per-subscriber overrides on the subscribers page could grant one
 * organization an exception; nothing could change the menu everyone is sold from.
 *
 * English-only, like the rest of this console. The tenant product is trilingual;
 * the platform console has one operator.
 */

type Edition = {
  id: string;
  code: string;
  name: string;
  planVersionId: string;
  version: number;
  priceId: string;
  monthlyPriceCents: number;
  currency: string;
  isActive: boolean;
  /** Set means withdrawn from the catalogue entirely; stronger than !isActive. */
  archivedAt: string | null;

  /**
   * Derived, not stored: whether the platform can operate the channels this
   * edition permits. An edition can be active here and still unsellable.
   */
  offerable?: boolean;
  unavailableReason?: string | null;
  unavailableDetail?: string | null;
  /** autoProvisionGateway is on while allowedChannels excludes OPENWA. */
  provisionsForbiddenChannel?: boolean;
  pricingModel: 'FREE' | 'FIXED' | 'NEGOTIATED';
  billingInterval: 'MONTHLY' | 'YEARLY';
  sortOrder: number;
  monthlyActiveContactsLimit: number | null;
  monthlyOutboundMessagesLimit: number | null;
  monthlyCampaignSendsLimit: number | null;
  customFieldsLimit: number | null;
  usersLimit: number | null;
  workflowsLimit: number | null;
  campaignRateMax: number | null;
  campaignRateDurationMs: number | null;
  customDomain: boolean;
  whiteLabel: boolean;
  maskContactDetails: boolean;
  autoProvisionGateway: boolean;
  allowedChannels: string[];
  scheduledChanges?: Record<string, unknown> | null;
  scheduledFrom?: string | null;
};

/**
 * One recorded change to an edition.
 *
 * The diff is computed by the server, deliberately. Two clients deriving "what
 * changed" separately is how one of them starts showing a field the other does
 * not, and this is the screen an operator would consult to settle exactly that
 * kind of disagreement.
 */
type HistoryEntry = {
  id: string;
  action: string;
  editionCode: string | null;
  at: string;
  actorEmail: string | null;
  reason: string;
  changes: Array<{ field: string; before: unknown; after: unknown }>;
  publication: {
    fromVersion: number;
    toVersion: number;
    pinnedSubscriberCount: number;
    overrideImpactCount: number;
  } | null;
  schedule: {
    currentVersion: number;
    proposedVersion: number;
    effectiveFrom: string;
  } | null;
};

type EditionVersion = {
  version: number;
  planVersionId: string;
  priceId: string;
  isCurrent: boolean;
  publishedAt: string;
  pinnedSubscriberCount: number;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  billingInterval: 'MONTHLY' | 'YEARLY';
  pricingModel: 'FREE' | 'FIXED' | 'NEGOTIATED';
  usersLimit: number | null;
};

/**
 * What a pending change would do, as the server computes it.
 *
 * The two groups are deliberately separate all the way from the endpoint to
 * the screen. Pinned subscriptions retain the exact version and Price they
 * bought. Live plan overrides name an edition rather than a version, so they
 * follow the proposed current version. Merging those into one "affected"
 * number would hide the most important distinction on the screen.
 */
type Preview = {
  code: string;
  currentVersion: { version: number; planVersionId: string; priceId: string };
  proposedVersion: {
    version: number;
    customerTerms: {
      planName: string;
      seats: number | null;
      priceCents: number;
      currency: string;
      billingInterval: 'MONTHLY' | 'YEARLY';
    };
  };
  pinnedSubscribers: {
    count: number;
    organizations: Array<{
      organizationId: string;
      name: string;
      subscriptionId: string;
      planVersionId: string;
      version: number;
      priceId: string;
      isCurrentVersion: boolean;
      effectiveSource: string;
      customerTerms: {
        planName: string;
        seats: number | null;
        priceCents: number;
        currency: string;
        billingInterval: 'MONTHLY' | 'YEARLY';
      };
    }>;
  };
  overrideImpact: {
    count: number;
    organizations: Array<{
      organizationId: string;
      name: string;
      changes: Array<{ field: string; before: unknown; after: unknown }>;
    }>;
  };
  affectedCount: number;
  channelImpact: { removed: string[]; holders: Array<{ organizationId: string; kind: string; status: string }>; effect: string } | null;
  note: string;
};

/** Values are rendered as JSON: a null limit means unlimited and must not read as blank. */
function renderValue(value: unknown): string {
  if (value === null) return 'unlimited';
  if (value === undefined) return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function renderMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

// Only limits with a current server-side producer and guard belong here.
const LIMIT_FIELDS = [
  { key: 'monthlyActiveContactsLimit', label: 'Active contacts / month' },
  { key: 'monthlyOutboundMessagesLimit', label: 'Outbound messages / month' },
  { key: 'monthlyCampaignSendsLimit', label: 'Broadcast sends / month' },
  { key: 'usersLimit', label: 'Users' },
  { key: 'customFieldsLimit', label: 'Custom fields' },
  { key: 'workflowsLimit', label: 'Workflows' },
] as const;

const FLAG_FIELDS = [
  { key: 'whiteLabel', label: 'Remove "Powered by RabiTech"' },
  { key: 'customDomain', label: 'Custom domain' },
  { key: 'maskContactDetails', label: 'Mask contact phone and email' },
] as const;

export default function PlatformEditions() {
  const router = useRouter();
  const [editions, setEditions] = useState<Edition[]>([]);
  const [draft, setDraft] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [catalogueView, setCatalogueView] = useState<'all' | 'sellable' | 'attention'>('all');
  const [archiving, setArchiving] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyVersions, setHistoryVersions] = useState<EditionVersion[]>([]);
  const [historyPinnedCount, setHistoryPinnedCount] = useState(0);
  const [historyOverrideCount, setHistoryOverrideCount] = useState(0);
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'error'>('idle');
  const previewRequest = useRef(0);
  const historyRequest = useRef(0);

  /**
   * What this edition used to be.
   *
   * `Plan.updatedAt` says a change happened and never what it was. Every edition
   * change has always written a full before/after snapshot to the platform audit
   * log; this is the first thing that reads them back.
   */
  const loadHistory = async (code: string) => {
    if (historyFor === code) {
      historyRequest.current += 1;
      setHistoryFor(null);
      return;
    }
    const request = ++historyRequest.current;
    setHistoryFor(code);
    setHistoryState('loading');
    try {
      const { data } = await api.get(`/api/platform/editions/history?code=${encodeURIComponent(code)}`);
      if (historyRequest.current !== request) return;
      setHistory(data.entries ?? []);
      setHistoryVersions(data.versions ?? []);
      setHistoryPinnedCount(Number(data.pinnedSubscriberCount ?? 0));
      setHistoryOverrideCount(Number(data.overrideImpactCount ?? 0));
      setHistoryState('idle');
    } catch {
      if (historyRequest.current !== request) return;
      setHistoryState('error');
    }
  };

  /**
   * Ask the server what the pending edit would do.
   *
   * Sends the same draft the Save button would send, so the answer describes
   * this change and not an approximation of it. The server computes it by
   * running the real entitlement resolver against a hypothetical edition, which
   * is why this is a request rather than something worked out here.
   */
  const loadPreview = async (code: string) => {
    const payload = draft[code];
    if (!payload || !Object.keys(payload).length) return;
    const request = ++previewRequest.current;
    setPreviewing(code);
    setPreviewFor(code);
    try {
      const { data } = await api.post(`/api/platform/editions/${code}/preview`, payload);
      if (previewRequest.current !== request) return;
      setPreview(data);
    } catch (error: any) {
      if (previewRequest.current !== request) return;
      toast.error(error?.response?.data?.error || 'Could not preview this change');
      setPreview(null);
      setPreviewFor(null);
    } finally {
      if (previewRequest.current === request) setPreviewing(null);
    }
  };

  /**
   * Withdraw an edition from the catalogue, or bring it back.
   *
   * Distinct from unticking "sold": archiving removes it from the console and
   * every upgrade prompt, while an archived edition still resolves in full for
   * the subscribers already on it. Nobody loses anything they are paying for.
   *
   * Clearing it restores whatever isActive already said, so an edition that was
   * deactivated before being archived comes back deactivated rather than on
   * sale. One action each way, and neither guesses at the other's intent.
   */
  const setArchived = async (code: string, archived: boolean) => {
    setArchiving(code);
    try {
      await api.patch(`/api/platform/editions/${code}`, { archived });
      toast.success(archived ? `${code} archived` : `${code} restored`);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || `Could not update ${code}`);
    } finally {
      setArchiving(null);
    }
  };

  const load = useCallback(async () => {
    previewRequest.current += 1;
    historyRequest.current += 1;
    setLoading(true);
    setLoadError(false);
    setPreview(null);
    setPreviewFor(null);
    setPreviewing(null);
    setHistoryFor(null);
    setHistory([]);
    setHistoryVersions([]);
    setHistoryState('idle');
    try {
      const { data } = await api.get('/api/platform/editions');
      setEditions(Array.isArray(data.editions) ? data.editions : []);
      setDraft({});
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        router.replace('/login');
        return;
      }
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    load();
  }, [load]);

  const edit = (code: string, field: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [code]: { ...prev[code], [field]: value } }));
    if (previewFor === code) {
      previewRequest.current += 1;
      setPreview(null);
      setPreviewFor(null);
      setPreviewing(null);
    }
  };

  const save = async (code: string) => {
    const payload = draft[code];
    if (!payload || !Object.keys(payload).length) return;
    setSaving(code);
    try {
      const { data } = await api.patch(`/api/platform/editions/${code}`, payload);
      const publication = data.publication;
      toast.success(publication
        ? `${code} version ${publication.toVersion} published.`
        : `${code} already matched that state.`);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || `Could not update ${code}`);
    } finally {
      setSaving(null);
    }
  };

  const archivedCount = editions.filter((edition) => edition.archivedAt).length;
  const activeEditions = editions.filter((edition) => !edition.archivedAt);
  const sellableCount = activeEditions.filter((edition) => edition.isActive && edition.offerable !== false).length;
  const scheduledCount = activeEditions.filter((edition) => edition.scheduledFrom).length;
  const attentionCount = activeEditions.filter(
    (edition) => edition.offerable === false || edition.provisionsForbiddenChannel,
  ).length;
  const visible = editions.filter((edition) => {
    if (!showArchived && edition.archivedAt) return false;
    if (catalogueView === 'sellable') return !edition.archivedAt && edition.isActive && edition.offerable !== false;
    if (catalogueView === 'attention') {
      return !edition.archivedAt && (edition.offerable === false || edition.provisionsForbiddenChannel);
    }
    return true;
  });

  const discardDraft = (code: string) => {
    setDraft((current) => {
      const next = { ...current };
      delete next[code];
      return next;
    });
    if (previewFor === code) {
      previewRequest.current += 1;
      setPreview(null);
      setPreviewFor(null);
      setPreviewing(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center" role="status">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="sr-only">Loading editions</span>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase text-muted-foreground">Billing catalogue</p>
          <h1 className="mt-1 text-2xl font-semibold text-foreground">Editions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Manage offerability, included usage, and versioned plan terms.</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="self-start sm:self-auto">
          <RefreshCw className="me-2 h-4 w-4" />
          Refresh
        </Button>
      </header>

      <dl className="mt-5 grid overflow-hidden rounded-md border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-x-reverse sm:divide-border">
        {[
          { label: 'Current editions', value: activeEditions.length, icon: Layers3 },
          { label: 'Sellable now', value: sellableCount, icon: ShieldCheck },
          { label: 'Scheduled', value: scheduledCount, icon: CalendarClock },
          { label: 'Needs attention', value: attentionCount, icon: CircleAlert },
        ].map((metric) => (
          <div key={metric.label} className="flex min-h-20 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <metric.icon className="h-4 w-4" />
            </span>
            <div>
              <dt className="text-xs text-muted-foreground">{metric.label}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular-nums">{metric.value}</dd>
            </div>
          </div>
        ))}
      </dl>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex w-fit rounded-md border border-border bg-card p-1" role="group" aria-label="Catalogue view">
          {([
            ['all', 'All'],
            ['sellable', 'Sellable'],
            ['attention', 'Needs attention'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={catalogueView === key}
              onClick={() => setCatalogueView(key)}
              className={cn(
                'h-8 rounded px-3 text-sm font-medium transition-colors',
                catalogueView === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {archivedCount > 0 ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => setShowArchived(event.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Include archived ({archivedCount})
          </label>
        ) : null}
      </div>

      <div className="mt-5 space-y-4">
        {loadError ? (
          <ErrorState
            title="Could not load editions"
            description="The edition catalogue could not be loaded. Check the platform connection and try again."
            retryLabel="Retry"
            onRetry={load}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No editions in this view"
            description="Change the catalogue filter to see other editions."
          />
        ) : visible.map((edition) => {
          const pending = draft[edition.code] || {};
          const value = <K extends keyof Edition>(field: K): Edition[K] =>
            (pending[field as string] !== undefined ? pending[field as string] : edition[field]) as Edition[K];
          const dirty = Object.keys(pending).length > 0;
          const isSellable = Boolean(value('isActive')) && edition.offerable !== false && !edition.archivedAt;

          return (
            <article
              key={edition.code}
              aria-label={`${edition.name} edition`}
              className={cn(
                'overflow-hidden rounded-md border bg-card shadow-sm',
                dirty ? 'border-primary/50' : 'border-border',
                edition.archivedAt && 'opacity-75',
              )}
            >
              <div className="flex flex-col gap-4 border-b border-border px-4 py-4 lg:flex-row lg:items-center lg:justify-between lg:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold">{edition.name}</h2>
                    <Badge variant="outline" className="font-mono">{edition.code}</Badge>
                    <Badge variant="outline">Current version {edition.version}</Badge>
                    <span className={cn(
                      'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium',
                      isSellable ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                    )}>
                      {isSellable ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      {isSellable ? 'Sellable' : edition.archivedAt ? 'Archived' : 'Unavailable'}
                    </span>
                    {dirty ? <span className="text-xs font-medium text-primary">Unsaved changes</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{renderMoney(edition.monthlyPriceCents, edition.currency)}</span>
                    <span>{edition.pricingModel.toLowerCase()}</span>
                    <span>{edition.billingInterval === 'YEARLY' ? 'yearly' : 'monthly'}</span>
                    <span>{edition.allowedChannels.join(', ')}</span>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <span>On sale</span>
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${edition.name} on sale`}
                      aria-checked={Boolean(value('isActive'))}
                      onClick={() => edit(edition.code, 'isActive', !value('isActive'))}
                      className={cn(
                        'relative h-6 w-11 rounded-full border transition-colors',
                        value('isActive') ? 'border-primary bg-primary' : 'border-border bg-muted',
                      )}
                    >
                      <span className={cn(
                        'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                        value('isActive') ? 'start-[22px]' : 'start-1',
                      )} />
                    </button>
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-9 p-0"
                    title={edition.archivedAt ? 'Restore edition' : 'Archive edition'}
                    disabled={archiving === edition.code}
                    onClick={() => setArchived(edition.code, !edition.archivedAt)}
                  >
                    {archiving === edition.code ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : edition.archivedAt ? (
                      <ArchiveRestore className="h-4 w-4" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                    <span className="sr-only">{edition.archivedAt ? 'Restore edition' : 'Archive edition'}</span>
                  </Button>
                </div>
              </div>

              {(edition.scheduledFrom || edition.provisionsForbiddenChannel || edition.offerable === false) ? (
                <div className="divide-y divide-border border-b border-border bg-warning/5 px-4 text-sm lg:px-5">
                  {edition.scheduledFrom ? (
                    <p className="flex items-center gap-2 py-2.5 text-muted-foreground">
                      <CalendarClock className="h-4 w-4 shrink-0" />
                      Version {edition.version + 1} scheduled for <span dir="ltr">{new Date(edition.scheduledFrom).toLocaleString()}</span>
                    </p>
                  ) : null}
                  {edition.provisionsForbiddenChannel ? (
                    <p className="flex items-start gap-2 py-2.5 text-warning">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      Gateway provisioning conflicts with the allowed channel list.
                    </p>
                  ) : null}
                  {edition.offerable === false ? (
                    <p className="flex items-start gap-2 py-2.5 text-warning">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      {edition.unavailableDetail || 'The permitted channels are not operational.'}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="grid lg:grid-cols-[minmax(220px,0.8fr)_minmax(360px,1.35fr)_minmax(260px,1fr)] lg:divide-x lg:divide-x-reverse lg:divide-border">
                <div className="p-4 lg:p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Commercial terms</h3>
                    <span className="text-xs text-muted-foreground">New version on publish</span>
                  </div>
                  <Label htmlFor={`${edition.code}-price`}>Price in cents</Label>
                  <Input
                    id={`${edition.code}-price`}
                    className="mt-1.5"
                    inputMode="numeric"
                    dir="ltr"
                    value={String(value('monthlyPriceCents'))}
                    onChange={(event) => edit(edition.code, 'monthlyPriceCents', event.target.value)}
                  />
                  <dl className="mt-4 divide-y divide-border text-sm">
                    <div className="flex items-center justify-between gap-3 py-2">
                      <dt className="text-muted-foreground">Pricing</dt>
                      <dd className="font-medium">{edition.pricingModel}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <dt className="text-muted-foreground">Interval</dt>
                      <dd className="font-medium">{edition.billingInterval}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2">
                      <dt className="text-muted-foreground">Currency</dt>
                      <dd className="font-mono font-medium" dir="ltr">{edition.currency}</dd>
                    </div>
                  </dl>
                </div>

                <div className="border-t border-border p-4 lg:border-t-0 lg:p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Enforced usage and capacity</h3>
                    <span className="text-xs text-muted-foreground">Blank means unlimited</span>
                  </div>
                  <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    {LIMIT_FIELDS.map((field) => {
                      const current = value(field.key);
                      return (
                        <div key={field.key}>
                          <Label htmlFor={`${edition.code}-${field.key}`} className="text-xs">{field.label}</Label>
                          <Input
                            id={`${edition.code}-${field.key}`}
                            className="mt-1 h-9"
                            inputMode="numeric"
                            dir="ltr"
                            placeholder="Unlimited"
                            value={current === null ? '' : String(current)}
                            onChange={(event) => edit(edition.code, field.key, event.target.value)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border p-4 lg:border-t-0 lg:p-5">
                  <h3 className="mb-4 text-sm font-semibold">Capabilities</h3>
                  <div className="space-y-3">
                    {FLAG_FIELDS.map((flag) => (
                      <label key={flag.key} className="flex items-center gap-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(value(flag.key))}
                          onChange={(event) => edit(edition.code, flag.key, event.target.checked)}
                          className="h-4 w-4 rounded border-border accent-primary"
                        />
                        {flag.label}
                      </label>
                    ))}
                  </div>
                  <div className="mt-5 border-t border-border pt-4">
                    <p className="text-xs font-medium text-muted-foreground">Allowed channels</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {edition.allowedChannels.map((channel) => (
                        <Badge key={channel} variant="outline" className="font-mono">{channel}</Badge>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Gateway provisioning: <span className="font-medium text-foreground">{edition.autoProvisionGateway ? 'Automatic' : 'Manual'}</span>
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 border-t border-border bg-muted/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-5">
                <Button variant="ghost" size="sm" onClick={() => loadHistory(edition.code)}>
                  <History className="me-2 h-4 w-4" />
                  {historyFor === edition.code ? 'Hide history' : 'View history'}
                </Button>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {dirty ? (
                    <Button variant="ghost" size="sm" onClick={() => discardDraft(edition.code)}>
                      <X className="me-2 h-4 w-4" />
                      Discard
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dirty || previewing === edition.code}
                    onClick={() => loadPreview(edition.code)}
                  >
                    {previewing === edition.code ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Eye className="me-2 h-4 w-4" />}
                    {previewing === edition.code ? 'Checking' : 'Preview impact'}
                  </Button>
                  <Button size="sm" disabled={!dirty || saving === edition.code} onClick={() => save(edition.code)}>
                    {saving === edition.code ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Save className="me-2 h-4 w-4" />}
                    {saving === edition.code ? 'Publishing' : `Publish v${edition.version + 1}`}
                  </Button>
                </div>
              </div>

              {previewFor === edition.code && preview ? (
                <div className="border-t border-border px-4 py-5 text-sm lg:px-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-xs font-semibold uppercase text-muted-foreground">Publication impact</p>
                      <h3 className="mt-1 font-semibold">Version {preview.currentVersion.version} to {preview.proposedVersion.version}</h3>
                    </div>
                    <div className="text-end">
                      <p className="font-semibold" dir="ltr">
                        {renderMoney(preview.proposedVersion.customerTerms.priceCents, preview.proposedVersion.customerTerms.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {preview.proposedVersion.customerTerms.seats === null
                          ? 'Unlimited seats'
                          : `${preview.proposedVersion.customerTerms.seats} seats`}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-5 border-y border-border py-4 md:grid-cols-2 md:divide-x md:divide-x-reverse md:divide-border">
                    <div className="md:pe-5">
                      <p className="font-medium">{preview.pinnedSubscribers.count} pinned subscription{preview.pinnedSubscribers.count === 1 ? '' : 's'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">These customers retain their purchased version.</p>
                      {preview.pinnedSubscribers.organizations.length > 0 ? (
                        <ul className="mt-3 space-y-2">
                          {preview.pinnedSubscribers.organizations.map((organization) => (
                            <li key={organization.subscriptionId} className="flex items-center justify-between gap-3">
                              <span className="truncate">{organization.name}</span>
                              <span className="shrink-0 text-xs text-muted-foreground" dir="ltr">
                                v{organization.version} / {renderMoney(organization.customerTerms.priceCents, organization.customerTerms.currency)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                    <div className="md:ps-5">
                      <p className="font-medium">{preview.overrideImpact.count} live override{preview.overrideImpact.count === 1 ? '' : 's'}</p>
                      <p className="mt-1 text-xs text-muted-foreground">These customers follow the current edition.</p>
                      {preview.overrideImpact.organizations.map((organization) => (
                        <div key={organization.organizationId} className="mt-3">
                          <p>{organization.name}</p>
                          {organization.changes.map((change) => (
                            <p key={change.field} className="text-xs text-muted-foreground" dir="ltr">
                              {change.field}: {renderValue(change.before)} to {renderValue(change.after)}
                            </p>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>

                  {preview.channelImpact ? (
                    <div className="mt-4 flex items-start gap-2 text-warning">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                      <p>{preview.channelImpact.effect}</p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {historyFor === edition.code ? (
                <div className="border-t border-border px-4 py-5 text-sm lg:px-5">
                  {historyState === 'loading' ? (
                    <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading history</p>
                  ) : historyState === 'error' ? (
                    <p className="text-danger">Could not load this edition&apos;s history.</p>
                  ) : (
                    <div className="grid gap-6 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.4fr)]">
                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">Published versions</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {historyPinnedCount} pinned subscriptions / {historyOverrideCount} live overrides
                        </p>
                        <ul className="mt-3 divide-y divide-border border-y border-border">
                          {historyVersions.map((version) => (
                            <li key={version.planVersionId} className="flex items-center justify-between gap-3 py-2.5">
                              <span className="font-medium">v{version.version}{version.isCurrent ? ' (current)' : ''}</span>
                              <span className="text-xs text-muted-foreground" dir="ltr">
                                {renderMoney(version.monthlyPriceCents, version.currency)} / {version.pinnedSubscriberCount} pinned
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase text-muted-foreground">Change log</p>
                        {history.length === 0 ? (
                          <p className="mt-3 text-muted-foreground">No recorded changes.</p>
                        ) : (
                          <ol className="mt-3 divide-y divide-border border-y border-border">
                            {history.map((entry) => (
                              <li key={entry.id} className="py-3">
                                <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                                  <span dir="ltr">{new Date(entry.at).toLocaleString()}</span>
                                  <span>{entry.actorEmail ?? 'system'}</span>
                                  <Badge variant="outline">{entry.action.replace('platform.edition.', '')}</Badge>
                                </div>
                                <p className="mt-1.5 font-medium">{entry.reason}</p>
                                {entry.changes.map((change) => (
                                  <p key={change.field} className="mt-1 text-xs text-muted-foreground" dir="ltr">
                                    {change.field}: {renderValue(change.before)} to {renderValue(change.after)}
                                  </p>
                                ))}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
