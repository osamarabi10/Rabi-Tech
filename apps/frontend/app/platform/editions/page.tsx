'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, History, Info, Loader2, Lock } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState, ErrorState } from '@/components/ui/operational-state';

/**
 * The edition catalogue — the product's offer, not one subscriber's deal.
 *
 * Until now this lived in a TypeScript constant, so changing a price meant a
 * deploy. The per-subscriber overrides on the subscribers page could grant one
 * workspace an exception; nothing could change the menu everyone is sold from.
 *
 * English-only, like the rest of this console. The tenant product is trilingual;
 * the platform console has one operator.
 */

type Edition = {
  id: string;
  code: string;
  name: string;
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
};

/**
 * What a pending change would do, as the server computes it.
 *
 * The two lists are deliberately separate all the way from the endpoint to the
 * screen. `changesNow` reaches existing subscribers at the next catalogue
 * refresh; `changesAtNextActivation` does not reach them at all until their
 * subscription is activated again, because the enforced limits were copied into
 * OrganizationConfig when they were last activated and enforcement reads that
 * copy. Merging the two into one "what changes" list would be the single most
 * misleading thing this screen could do.
 */
type Preview = {
  code: string;
  affectedCount: number;
  organizations: Array<{
    organizationId: string;
    name: string;
    source: string;
    changesNow: Array<{ field: string; before: unknown; after: unknown }>;
    changesAtNextActivation: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
  channelImpact: { removed: string[]; holders: Array<{ organizationId: string; kind: string; status: string }>; effect: string } | null;
  note: string;
};

/** Values are rendered as JSON: a null limit means unlimited and must not read as blank. */
function renderValue(value: unknown): string {
  if (value === null) return 'unlimited';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

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
  const [archiving, setArchiving] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyState, setHistoryState] = useState<'idle' | 'loading' | 'error'>('idle');

  /**
   * What this edition used to be.
   *
   * `Plan.updatedAt` says a change happened and never what it was. Every edition
   * change has always written a full before/after snapshot to the platform audit
   * log; this is the first thing that reads them back.
   */
  const loadHistory = async (code: string) => {
    if (historyFor === code) { setHistoryFor(null); return; }
    setHistoryFor(code);
    setHistoryState('loading');
    try {
      const { data } = await api.get(`/api/platform/editions/history?code=${encodeURIComponent(code)}`);
      setHistory(data.entries ?? []);
      setHistoryState('idle');
    } catch {
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
    setPreviewing(code);
    setPreviewFor(code);
    try {
      const { data } = await api.post(`/api/platform/editions/${code}/preview`, payload);
      setPreview(data);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || 'Could not preview this change');
      setPreview(null);
      setPreviewFor(null);
    } finally {
      setPreviewing(null);
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
    setLoading(true);
    setLoadError(false);
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

  const edit = (code: string, field: string, value: unknown) =>
    setDraft((prev) => ({ ...prev, [code]: { ...prev[code], [field]: value } }));

  const save = async (code: string) => {
    const payload = draft[code];
    if (!payload || !Object.keys(payload).length) return;
    setSaving(code);
    try {
      await api.patch(`/api/platform/editions/${code}`, payload);
      toast.success(`${code} updated. Live now — no deploy, no restart.`);
      await load();
    } catch (error: any) {
      toast.error(error?.response?.data?.error || `Could not update ${code}`);
    } finally {
      setSaving(null);
    }
  };

  /*
    Archived editions are withheld from the list, not from the data. They still
    resolve in full for the subscribers on them - that is the whole point of
    archiving rather than deleting - so this is a display decision and nothing
    else reads it.
  */
  const archivedCount = editions.filter((edition) => edition.archivedAt).length;
  const visible = showArchived ? editions : editions.filter((edition) => !edition.archivedAt);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href="/platform" className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Platform
      </Link>

      <h1 className="text-2xl font-semibold">Editions</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
        The catalogue every subscriber is sold from. Changes take effect without a
        deploy and survive a restart. To grant one workspace an exception instead,
        use the commercial overrides on that subscriber.
      </p>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          Adding a new edition is not available here, and the reason has changed.
          Edition codes are no longer fixed in the server&apos;s type — the catalogue
          can carry codes the code has never heard of. What holds the door shut is
          a deliberate list of creatable codes, because the first edition outside
          the original five is the point past which the change cannot be rolled
          back. Opening it is a decision, not a missing feature.
        </span>
      </div>

      {/*
        Archived editions are hidden by default and counted rather than
        silently dropped. An owner who archived something last month should not
        have to wonder whether it is gone or merely out of sight - and an empty
        screen with no explanation is indistinguishable from a failed load.
      */}
      {archivedCount > 0 ? (
        <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show {archivedCount} archived edition{archivedCount === 1 ? '' : 's'}
        </label>
      ) : null}

      <div className="mt-8 space-y-8">
        {loadError ? (
          <ErrorState
            title="Could not load editions"
            description="The edition catalogue could not be loaded. Check the platform connection and try again."
            retryLabel="Retry"
            onRetry={load}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title="No editions configured"
            description="The edition catalogue is empty. Add an edition through the server configuration before selling it."
          />
        ) : visible.map((edition) => {
          const pending = draft[edition.code] || {};
          const value = <K extends keyof Edition>(field: K): Edition[K] =>
            (pending[field as string] !== undefined ? pending[field as string] : edition[field]) as Edition[K];
          const dirty = Object.keys(pending).length > 0;

          return (
            <section key={edition.code} className="rounded-lg border border-border p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {edition.name}{' '}
                    <span className="font-mono text-sm text-muted-foreground">{edition.code}</span>
                  </h2>
                  {!edition.isActive && (
                    <span className="text-sm text-muted-foreground">
                      Inactive — hidden from pricing. Subscribers already on it keep working.
                    </span>
                  )}
                  {/*
                    Why an edition cannot be sold, not merely that it cannot.

                    This is not a switch on this screen and deliberately has no
                    control beside it - the cause is platform configuration, and
                    the remedy is setting the named secrets, not clicking here.
                    Without the detail line an owner sees an active edition
                    missing from the pricing page and reads it as a bug.
                  */}
                  {edition.offerable === false && (
                    <span className="block text-sm text-warning">
                      Not sellable — {edition.unavailableDetail || 'the channels it permits cannot be operated'}.
                      {' '}Subscribers already on it keep working.
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => edit(edition.code, 'isActive', !value('isActive'))}
                  >
                    {value('isActive') ? 'Deactivate' : 'Activate'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!dirty || previewing === edition.code}
                    onClick={() => loadPreview(edition.code)}
                  >
                    {previewing === edition.code ? 'Checking…' : 'Preview effect'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={archiving === edition.code}
                    onClick={() => setArchived(edition.code, !edition.archivedAt)}
                  >
                    {archiving === edition.code
                      ? 'Working…'
                      : edition.archivedAt ? 'Restore' : 'Archive'}
                  </Button>
                  <Button size="sm" disabled={!dirty || saving === edition.code} onClick={() => save(edition.code)}>
                    {saving === edition.code ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <Label htmlFor={`${edition.code}-price`}>Monthly price (cents)</Label>
                  <Input
                    id={`${edition.code}-price`}
                    inputMode="numeric"
                    dir="ltr"
                    value={String(value('monthlyPriceCents'))}
                    onChange={(e) => edit(edition.code, 'monthlyPriceCents', e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">0 for free or negotiated.</p>
                </div>

                {LIMIT_FIELDS.map((field) => {
                  const current = value(field.key);
                  return (
                    <div key={field.key}>
                      <Label htmlFor={`${edition.code}-${field.key}`}>{field.label}</Label>
                      <Input
                        id={`${edition.code}-${field.key}`}
                        inputMode="numeric"
                        dir="ltr"
                        placeholder="Unlimited"
                        value={current === null ? '' : String(current)}
                        onChange={(e) => edit(edition.code, field.key, e.target.value)}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Empty means unlimited.</p>
                    </div>
                  );
                })}
              </div>

              <div className="mt-5 space-y-2">
                {FLAG_FIELDS.map((flag) => (
                  <label key={flag.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(value(flag.key))}
                      onChange={(e) => edit(edition.code, flag.key, e.target.checked)}
                    />
                    {flag.label}
                  </label>
                ))}

                {/*
                  Disabled with a stated reason, never a bare greyed box. The
                  checkpoint's rule: a control the operator cannot use must say
                  why, or it is indistinguishable from a bug.

                  The reason has changed, and the copy changed with it. Both of
                  these once said "not enforced anywhere yet", which was true when
                  written and became false without anyone noticing: the flag now
                  decides gateway provisioning at activation, and allowedChannels
                  is checked when a channel is connected or made active — the
                  ladder was narrowed on the strength of it, so three editions are
                  Meta-only today.

                  That is the worse half of a stale comment. An operator reading
                  "not enforced" would reasonably treat the channel list as
                  decorative and edit it to tidy the screen, and would be
                  narrowing a live edition. They are read-only here only because
                  this screen has not been wired to send them; the server accepts
                  both.
                */}
                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={edition.autoProvisionGateway} disabled className="mt-1" />
                  <span>
                    <Lock className="mr-1 inline h-3 w-3" />
                    Automatic gateway provisioning — <strong>enforced.</strong> This
                    flag decides whether activating a subscription starts a WhatsApp
                    gateway for that workspace. Read-only on this screen for now;
                    the server accepts it.
                  </span>
                </label>

                {/*
                  Read-only, and each for its own reason.

                  pricingModel is settable through the API but not exposed here
                  yet; it decides whether an edition collects money at all, so
                  it is shown because an operator reading a price needs to know
                  whether it is charged, free or negotiated.

                  currency is deliberately NOT editable, and this is a decision
                  rather than an omission. The create path does not validate it,
                  and Plan.currency is what sellableCurrencies() derives from -
                  so a typo here would become the allowlist that invoices are
                  written against. Making it settable needs validation designed
                  first.
                */}
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    <Lock className="mr-1 inline h-3 w-3" />
                    Pricing: <code dir="ltr">{edition.pricingModel}</code>
                    {' · '}
                    <code dir="ltr">{edition.billingInterval === 'YEARLY' ? 'per year' : 'per month'}</code>
                  </span>
                  <span>
                    <Lock className="mr-1 inline h-3 w-3" />
                    Currency: <code dir="ltr">{edition.currency}</code> — read-only; it is the
                    source the invoicing allowlist is derived from.
                  </span>
                </div>

                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Channels: <code dir="ltr">{edition.allowedChannels.join(', ')}</code> —{' '}
                    <strong>enforced.</strong> A workspace on this edition can connect
                    and switch to these channel kinds and no others. Narrowing this
                    list does not disconnect anyone already sending — it stops them
                    selecting that channel again once they switch away. Read-only on
                    this screen for now; the server accepts it.
                  </span>
                </div>

                {previewFor === edition.code && preview ? (
                  <div className="rounded-md border border-border bg-muted/30 p-4 text-sm">
                    <p className="font-medium">
                      {preview.affectedCount === 0
                        ? 'No current subscriber is on this edition.'
                        : `${preview.affectedCount} subscriber${preview.affectedCount === 1 ? '' : 's'} on this edition.`}
                    </p>

                    {preview.organizations.map((org) => (
                      <div key={org.organizationId} className="mt-3 border-t border-border pt-3">
                        <p className="font-medium">{org.name}</p>

                        {org.changesNow.length > 0 ? (
                          <div className="mt-2">
                            <p className="text-xs font-semibold uppercase tracking-wide">Takes effect immediately</p>
                            <ul className="mt-1 space-y-0.5">
                              {org.changesNow.map((c) => (
                                <li key={c.field} className="flex flex-wrap gap-x-2">
                                  <code dir="ltr">{c.field}</code>
                                  <span dir="ltr">{renderValue(c.before)} → {renderValue(c.after)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {/*
                          Visually separated, not merged. These are the metered
                          limits: the edition changes, and this subscriber does
                          not feel it until something activates their
                          subscription again. Presenting them alongside the
                          immediate set would tell an owner that a quota rise
                          they just granted is already in force, which is the
                          one thing this panel exists to prevent.
                        */}
                        {org.changesAtNextActivation.length > 0 ? (
                          <div className="mt-3 rounded border border-dashed border-border p-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Not until their next activation
                            </p>
                            <ul className="mt-1 space-y-0.5 text-muted-foreground">
                              {org.changesAtNextActivation.map((c) => (
                                <li key={c.field} className="flex flex-wrap gap-x-2">
                                  <code dir="ltr">{c.field}</code>
                                  <span dir="ltr">{renderValue(c.before)} → {renderValue(c.after)}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {org.changesNow.length === 0 && org.changesAtNextActivation.length === 0 ? (
                          <p className="mt-1 text-muted-foreground">Nothing changes for this subscriber.</p>
                        ) : null}
                      </div>
                    ))}

                    {preview.channelImpact ? (
                      <div className="mt-3 border-t border-border pt-3">
                        <p className="text-xs font-semibold uppercase tracking-wide">
                          Channels removed: <code dir="ltr">{preview.channelImpact.removed.join(', ')}</code>
                        </p>
                        <p className="mt-1 text-muted-foreground">{preview.channelImpact.effect}</p>
                        {preview.channelImpact.holders.length > 0 ? (
                          <p className="mt-1 text-muted-foreground">
                            {preview.channelImpact.holders.length} connected channel
                            {preview.channelImpact.holders.length === 1 ? '' : 's'} affected.
                          </p>
                        ) : null}
                      </div>
                    ) : null}

                    <p className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
                      {preview.note}
                    </p>
                  </div>
                ) : null}

                <div className="border-t border-border pt-4">
                  <Button variant="ghost" size="sm" onClick={() => loadHistory(edition.code)}>
                    <History className="me-2 h-4 w-4" />
                    {historyFor === edition.code ? 'Hide history' : 'History'}
                  </Button>

                  {historyFor === edition.code ? (
                    <div className="mt-3 text-sm">
                      {historyState === 'loading' ? (
                        <p className="text-muted-foreground">Loading…</p>
                      ) : historyState === 'error' ? (
                        <p className="text-danger">Could not load this edition&apos;s history.</p>
                      ) : history.length === 0 ? (
                        <p className="text-muted-foreground">
                          No recorded changes. History begins when an edition is first
                          edited — it is not reconstructed from the current values.
                        </p>
                      ) : (
                        <ul className="space-y-3">
                          {history.map((entry) => (
                            <li key={entry.id} className="rounded-md border border-border p-3">
                              <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                                <span dir="ltr">{new Date(entry.at).toLocaleString()}</span>
                                <span>·</span>
                                <span>{entry.actorEmail ?? 'unknown'}</span>
                                <span>·</span>
                                <span>{entry.action.replace('platform.edition.', '')}</span>
                              </div>
                              {entry.changes.length === 0 ? (
                                <p className="mt-2 text-muted-foreground">
                                  No field values differed.
                                </p>
                              ) : (
                                <ul className="mt-2 space-y-1">
                                  {entry.changes.map((change) => (
                                    <li key={change.field} className="flex flex-wrap gap-x-2">
                                      <code dir="ltr">{change.field}</code>
                                      <span className="text-muted-foreground" dir="ltr">
                                        {renderValue(change.before)} → {renderValue(change.after)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
