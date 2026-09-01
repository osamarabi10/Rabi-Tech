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
          Adding a new edition is not available here. An edition code has to exist
          in the server&apos;s <code>PlanCode</code> type before anything can resolve
          it, so a row created from this page would be a plan no enforcement path
          recognises. Adding one is a code change today.
        </span>
      </div>

      <div className="mt-8 space-y-8">
        {loadError ? (
          <ErrorState
            title="Could not load editions"
            description="The edition catalogue could not be loaded. Check the platform connection and try again."
            retryLabel="Retry"
            onRetry={load}
          />
        ) : editions.length === 0 ? (
          <EmptyState
            title="No editions configured"
            description="The edition catalogue is empty. Add an edition through the server configuration before selling it."
          />
        ) : editions.map((edition) => {
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
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => edit(edition.code, 'isActive', !value('isActive'))}
                  >
                    {value('isActive') ? 'Deactivate' : 'Activate'}
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
                */}
                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={edition.autoProvisionGateway} disabled className="mt-1" />
                  <span>
                    <Lock className="mr-1 inline h-3 w-3" />
                    Automatic gateway provisioning —{' '}
                    <strong>not enforced anywhere yet.</strong> It is reported in the
                    billing summary only, so changing it here would grant nothing.
                  </span>
                </label>

                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    Channels: <code dir="ltr">{edition.allowedChannels.join(', ')}</code> —{' '}
                    <strong>not enforced yet.</strong> No code permits or refuses a
                    channel by edition, and the per-edition rule is still an open
                    product question.
                  </span>
                </div>

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
