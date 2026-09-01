'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Check, ChevronDown, Copy, KeyRound, Loader2, PlayCircle,
  Plus, RefreshCw, Trash2, Webhook,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createWebhookEndpoint, deleteWebhookEndpoint, fetchWebhookDeliveries,
  fetchWebhookEndpoints, fetchWebhookEventCatalogue, rotateWebhookSecret,
  testWebhookEndpoint, updateWebhookEndpoint,
  type IssuedConfiguredWebhook, type WebhookDelivery, type ConfiguredWebhook,
} from '@/lib/data';
import { formatDate, formatTimeOfDay } from '@/lib/format-time';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PermissionNotice } from '@/components/permission-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';

/**
 * Outbound webhooks.
 *
 * ## The delivery log is why this screen exists
 *
 * Respond.io ships webhooks without one, and it is an open feature request
 * against them. Without it the only debugging move is "ask support to read the
 * server log", which means the subscriber cannot answer their own question and
 * neither can the person they are integrating with. Every row here carries the
 * status code, the latency, the attempt number and the response body.
 *
 * ## A switched-off endpoint must explain itself
 *
 * When delivery fails persistently the endpoint is turned off automatically.
 * Their version emails you and leaves you to find the switch. This renders the
 * reason and the time on the row itself, with one button to turn it back on —
 * because the question after "it stopped working" is always "why", and an
 * answer that lives in an email nobody kept is not an answer.
 */

type Editing = { id?: string; name: string; url: string; events: string[] };

const EMPTY: Editing = { name: '', url: '', events: [] };

function storedRole(): string {
  try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}').role || ''; }
  catch { return ''; }
}

export function Webhooks() {
  const { t } = useT();
  const [rows, setRows] = useState<ConfiguredWebhook[]>([]);
  const [groups, setGroups] = useState<{ resource: string; events: string[] }[]>([]);
  const [autoDisable, setAutoDisable] = useState({ failures: 30, windowMinutes: 30 });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<Editing>(EMPTY);
  const [saving, setSaving] = useState(false);

  const [issued, setIssued] = useState<{ name: string; secret: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConfiguredWebhook | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ConfiguredWebhook | null>(null);

  const [openLog, setOpenLog] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<Record<string, WebhookDelivery[]>>({});
  const [loadingLog, setLoadingLog] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [endpoints, catalogue] = await Promise.all([
        fetchWebhookEndpoints(),
        fetchWebhookEventCatalogue(),
      ]);
      setRows(endpoints);
      setGroups(catalogue.groups);
      setAutoDisable(catalogue.autoDisable);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setCanManage(storedRole() === 'ADMIN'); void load(); }, [load]);

  const loadLog = useCallback(async (id: string, onlyFailures: boolean) => {
    setLoadingLog(true);
    try {
      setDeliveries((current) => ({ ...current, [id]: [] }));
      const rowsForId = await fetchWebhookDeliveries(id, onlyFailures);
      setDeliveries((current) => ({ ...current, [id]: rowsForId }));
    } catch {
      toast.error(t('Could not load the delivery log'));
    } finally { setLoadingLog(false); }
  }, [t]);

  const toggleLog = (id: string) => {
    if (openLog === id) { setOpenLog(null); return; }
    setOpenLog(id);
    void loadLog(id, failedOnly);
  };

  const toggleEvent = (event: string) => {
    setForm((current) => ({
      ...current,
      events: current.events.includes(event)
        ? current.events.filter((e) => e !== event)
        : [...current.events, event],
    }));
  };

  const save = async () => {
    if (!form.name.trim() || !form.url.trim() || !form.events.length) return;
    setSaving(true);
    try {
      if (form.id) {
        await updateWebhookEndpoint(form.id, {
          name: form.name.trim(), url: form.url.trim(), events: form.events,
        });
        toast.success(t('Webhook updated'));
      } else {
        const created = await createWebhookEndpoint({
          name: form.name.trim(), url: form.url.trim(), events: form.events,
        });
        setIssued({ name: created.name, secret: created.secret });
      }
      setEditorOpen(false);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not save the webhook'));
    } finally { setSaving(false); }
  };

  const setActive = async (row: ConfiguredWebhook, isActive: boolean) => {
    try {
      await updateWebhookEndpoint(row.id, { isActive });
      toast.success(isActive ? t('Webhook re-enabled') : t('Webhook turned off'));
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not change the webhook'));
    }
  };

  const runTest = async (row: ConfiguredWebhook) => {
    try {
      const ok = await testWebhookEndpoint(row.id);
      // Either way the attempt is now in the log, which is where the status
      // code and the response body are — so the toast says what happened and
      // points at where the detail lives.
      if (ok) toast.success(t('Test delivered successfully'));
      else toast.error(t('Test failed — open the delivery log for the response'));
      if (openLog === row.id) await loadLog(row.id, failedOnly);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not send the test'));
    }
  };

  const rotate = async () => {
    if (!rotateTarget) return;
    setSaving(true);
    try {
      const secret = await rotateWebhookSecret(rotateTarget.id);
      setRotateTarget(null);
      setIssued({ name: rotateTarget.name, secret });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not rotate the key'));
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deleteWebhookEndpoint(deleteTarget.id);
      toast.success(t('Webhook deleted'));
      setDeleteTarget(null);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not delete the webhook'));
    } finally { setSaving(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading webhooks')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load webhooks')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold">{t('Webhooks')}</h1>
        <p className="mt-1 text-caption text-muted-foreground">
          {t('Get told when something happens here, so your own software can react to it.')}
        </p>
      </div>
      {canManage
        ? <Button onClick={() => { setForm(EMPTY); setEditorOpen(true); }}><Plus className="size-4" />{t('Add webhook')}</Button>
        : <PermissionNotice action={t('Managing webhooks')} className="self-center" />}
    </header>

    <div className="min-h-0 flex-1 overflow-auto">
      {!rows.length
        ? <EmptyState
            icon={Webhook}
            title={t('No webhooks yet')}
            description={canManage
              ? t('Add an endpoint and we will POST a signed event to it whenever something happens.')
              : t('An organisation admin can add webhook endpoints here.')}
            action={canManage ? <Button onClick={() => { setForm(EMPTY); setEditorOpen(true); }}><Plus className="size-4" />{t('Add webhook')}</Button> : undefined}
          />
        : <div className="divide-y divide-border border-b border-border">
            {rows.map((row) => (
              <article key={row.id} className="bg-card">
                <div className="grid gap-3 px-4 py-3.5 sm:grid-cols-[minmax(200px,1.2fr)_minmax(180px,1fr)_140px_40px] sm:items-center sm:px-6">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-small font-semibold" dir="auto">{row.name}</h2>
                      {row.isActive
                        ? <Badge variant="outline" className="text-success">{t('Active')}</Badge>
                        : <Badge variant="outline" className="text-muted-foreground">{t('Off')}</Badge>}
                    </div>
                    <code className="mt-1 block truncate font-mono text-micro text-muted-foreground" dir="ltr">{row.url}</code>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {row.events.slice(0, 3).map((event) => (
                      <Badge key={event} variant="outline" className="font-mono text-micro" dir="ltr">{event}</Badge>
                    ))}
                    {row.events.length > 3 && (
                      <Badge variant="outline" className="text-micro">+{row.events.length - 3}</Badge>
                    )}
                  </div>

                  <dl className="space-y-0.5 text-micro text-muted-foreground">
                    <div className="flex gap-1.5">
                      <dt>{t('Last success')}:</dt>
                      <dd dir={row.lastSuccessAt ? 'ltr' : 'auto'}>
                        {row.lastSuccessAt ? formatDate(row.lastSuccessAt) : t('never')}
                      </dd>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleLog(row.id)}
                      className="flex items-center gap-1 text-micro text-primary hover:underline"
                    >
                      <ChevronDown className={cn('size-3 transition-transform', openLog === row.id && 'rotate-180')} aria-hidden />
                      {t('Delivery log')}
                    </button>
                  </dl>

                  {canManage
                    ? <RowOverflowMenu
                        label={t('Webhook actions')}
                        actions={[
                          { label: t('Send test'), icon: PlayCircle, onSelect: () => void runTest(row) },
                          { label: t('Edit'), icon: Webhook, onSelect: () => { setForm({ id: row.id, name: row.name, url: row.url, events: row.events }); setEditorOpen(true); } },
                          { label: t('Rotate signing key'), icon: RefreshCw, onSelect: () => setRotateTarget(row) },
                          row.isActive
                            ? { label: t('Turn off'), icon: AlertTriangle, onSelect: () => void setActive(row, false) }
                            : { label: t('Turn back on'), icon: Check, onSelect: () => void setActive(row, true) },
                          { label: t('Delete'), icon: Trash2, destructive: true, onSelect: () => setDeleteTarget(row) },
                        ]}
                      />
                    : <span />}
                </div>

                {/*
                  The auto-deactivation notice. Renders only when there is a
                  real reason — never as a generic "this is off" banner, which
                  would say nothing the badge above has not already said.
                */}
                {!row.isActive && row.disabledReason && (
                  <div className="mx-4 mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 sm:mx-6">
                    <p className="flex items-start gap-1.5 text-micro text-warning">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      <span>
                        {row.disabledReason}
                        {row.disabledAt && (
                          <span className="ms-1 opacity-80" dir="auto">
                            ({formatDate(row.disabledAt)} {formatTimeOfDay(row.disabledAt)})
                          </span>
                        )}
                      </span>
                    </p>
                    {canManage && (
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => void setActive(row, true)}>
                        <Check className="size-3.5" />{t('Turn back on')}
                      </Button>
                    )}
                  </div>
                )}

                {openLog === row.id && (
                  <div className="border-t border-border bg-muted/30 px-4 py-3 sm:px-6">
                    <div className="mb-2 flex flex-wrap items-center gap-3">
                      <span className="text-micro font-semibold">{t('Delivery log')}</span>
                      <label className="flex items-center gap-1.5 text-micro text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={failedOnly}
                          onChange={(event) => {
                            setFailedOnly(event.target.checked);
                            void loadLog(row.id, event.target.checked);
                          }}
                          className="size-3.5 rounded border-input accent-primary"
                        />
                        {t('Failures only')}
                      </label>
                      <Button size="sm" variant="ghost" onClick={() => void loadLog(row.id, failedOnly)}>
                        <RefreshCw className={cn('size-3.5', loadingLog && 'animate-spin')} />{t('Refresh')}
                      </Button>
                    </div>

                    {loadingLog && !(deliveries[row.id] || []).length
                      ? <p className="py-2 text-micro text-muted-foreground">{t('Loading…')}</p>
                      : !(deliveries[row.id] || []).length
                        ? <p className="py-2 text-micro text-muted-foreground">
                            {t('Nothing delivered yet. Send a test to check the endpoint.')}
                          </p>
                        : <div className="overflow-x-auto">
                            <table className="w-full min-w-[560px] text-micro">
                              <thead className="text-muted-foreground">
                                <tr className="border-b border-border">
                                  <th className="py-1.5 text-start font-medium">{t('When')}</th>
                                  <th className="py-1.5 text-start font-medium">{t('Event')}</th>
                                  <th className="py-1.5 text-start font-medium">{t('Result')}</th>
                                  <th className="py-1.5 text-start font-medium">{t('Attempt')}</th>
                                  <th className="py-1.5 text-start font-medium">{t('Took')}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(deliveries[row.id] || []).map((delivery) => (
                                  <tr key={delivery.id} className="border-b border-border/50 last:border-0">
                                    <td className="py-1.5 tabular-nums" dir="ltr">
                                      {formatDate(delivery.createdAt)} {formatTimeOfDay(delivery.createdAt)}
                                    </td>
                                    <td className="py-1.5 font-mono" dir="ltr">{delivery.eventType}</td>
                                    <td className="py-1.5">
                                      <span className={cn('font-mono', delivery.ok ? 'text-success' : 'text-danger')} dir="ltr">
                                        {/* A transport error has no status code at all, and is
                                            still a failure — showing a blank cell there would
                                            read as "nothing happened". */}
                                        {delivery.statusCode ?? t('no response')}
                                      </span>
                                      {delivery.errorMessage && (
                                        <span className="ms-1.5 text-muted-foreground" dir="auto">{delivery.errorMessage}</span>
                                      )}
                                    </td>
                                    <td className="py-1.5 tabular-nums" dir="ltr">{delivery.attempt}</td>
                                    <td className="py-1.5 tabular-nums" dir="ltr">{delivery.durationMs}ms</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>}
                  </div>
                )}
              </article>
            ))}
          </div>}
    </div>

    {/* ── create / edit ──────────────────────────────────────────────────── */}
    <Drawer open={editorOpen} onOpenChange={setEditorOpen}>
      <DrawerContent closeLabel={t('Close')} className="sm:max-w-xl">
        <DrawerHeader>
          <DrawerTitle className="text-base font-semibold">
            {form.id ? t('Edit webhook') : t('Add webhook')}
          </DrawerTitle>
          <DrawerDescription>
            {t('We POST a signed JSON body to your URL. Verify the signature before trusting it.')}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="space-y-6">
          <div className="space-y-1.5">
            <Label htmlFor="hook-name">{t('Name')}</Label>
            <Input
              id="hook-name" value={form.name} maxLength={60} dir="auto"
              placeholder={t('e.g. Order system')}
              onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="hook-url">{t('URL')}</Label>
            <Input
              id="hook-url" value={form.url} dir="ltr" inputMode="url"
              placeholder="https://example.com/hooks/rabitech"
              onChange={(event) => setForm((c) => ({ ...c, url: event.target.value }))}
            />
            <p className="text-micro text-muted-foreground">
              {t('Must be https and reachable from the internet.')}
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-small font-medium">{t('Events')}</legend>
            <p className="text-micro text-muted-foreground">
              {t('Only what you tick is sent. Subscribing to everything means receiving message bodies you may not want.')}
            </p>
            <div className="space-y-2 pt-1">
              {groups.map((group) => (
                <div key={group.resource} className="rounded-md border border-border px-3 py-2">
                  <p className="mb-1.5 font-mono text-caption" dir="ltr">{group.resource}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {group.events.map((event) => {
                      const on = form.events.includes(event);
                      return (
                        <button
                          key={event}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleEvent(event)}
                          dir="ltr"
                          className={cn(
                            'rounded-md border px-2 py-1 font-mono text-micro transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
                          )}
                        >
                          {on ? <Check className="me-1 inline size-3" aria-hidden /> : null}
                          {event.split('.')[1]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          {/*
            Two complete sentences, not one sentence chopped around two numbers.
            A number mid-sentence survives translation — Arabic, Hebrew and
            English all put it in the same place here — but a trailing fragment
            like "minutes." inherits the source language's word order and lands
            wrong in at least one of the other two.
          */}
          <p className="flex items-start gap-1.5 text-micro text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span>
              {t('If delivery keeps failing we turn the webhook off and tell you why here.')}{' '}
              {t('The threshold is')} <bdi dir="ltr">{autoDisable.failures}</bdi>{' '}
              {t('failures within')} <bdi dir="ltr">{autoDisable.windowMinutes}</bdi> {t('minutes')}
            </span>
          </p>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button>
          <Button onClick={() => void save()} disabled={saving || !form.name.trim() || !form.url.trim() || !form.events.length}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('Save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>

    <SecretDialog issued={issued} onDone={() => setIssued(null)} />

    <ConfirmDialog
      open={!!rotateTarget}
      onOpenChange={(open) => { if (!open) setRotateTarget(null); }}
      title={t('Rotate the signing key')}
      description={t('The current key stops working immediately. Any receiver still verifying with it will reject every delivery until you update it.')}
      cancelLabel={t('Cancel')}
      confirmLabel={t('Rotate key')}
      busy={saving}
      onConfirm={() => void rotate()}
    />

    <ConfirmDialog
      open={!!deleteTarget}
      onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      title={t('Delete this webhook')}
      description={t('We stop sending to this URL. The delivery log is kept, so you can still see what was sent before.')}
      cancelLabel={t('Cancel')}
      confirmLabel={t('Delete')}
      busy={saving}
      onConfirm={() => void remove()}
    />
  </div>;
}

/**
 * The signing key, shown once.
 *
 * Same treatment as an API token: no outside-click dismissal, no Escape, no
 * corner X, and Done stays disabled until the key has been copied or explicitly
 * acknowledged. A receiver cannot verify anything without this value and there
 * is no way to retrieve it afterwards.
 */
function SecretDialog({ issued, onDone }: { issued: { name: string; secret: string } | null; onDone: () => void }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => { setAcknowledged(false); setCopied(false); }, [issued?.secret]);

  if (!issued) return null;

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('unavailable');
      await navigator.clipboard.writeText(issued.secret);
      setCopied(true);
      setAcknowledged(true);
    } catch {
      toast.error(t('Could not copy — select the text and copy it manually'));
    }
  };

  return (
    <Dialog open onOpenChange={() => { /* deliberately inert */ }}>
      <DialogContent
        className="sm:max-w-lg"
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            {t('Copy the signing key now')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="flex items-start gap-1.5 text-small text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('This is the only time the key is shown. Your receiver needs it to verify that a delivery really came from us.')}
          </p>

          <div className="space-y-2">
            <Label htmlFor="hook-secret">{issued.name}</Label>
            <div className="flex gap-2">
              <code
                id="hook-secret"
                dir="ltr"
                className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-micro"
              >
                {issued.secret}
              </code>
              <Button type="button" variant="outline" aria-label={t('Copy signing key')} onClick={() => void copy()}>
                {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              </Button>
            </div>
          </div>

          <p className="text-micro text-muted-foreground">
            {t('Signature header')}: <code className="font-mono" dir="ltr">X-RabiTech-Signature: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>
            {' — '}
            {t('the HMAC-SHA256 of "<timestamp>.<body>" with this key. Reject anything older than five minutes.')}
          </p>

          <label className="flex items-start gap-2 text-small">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
            />
            <span>{t('I have saved this key somewhere safe.')}</span>
          </label>
        </div>

        <DialogFooter>
          <Button onClick={onDone} disabled={!acknowledged}>{t('Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
