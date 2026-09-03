'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Check, Clock, Copy, EyeOff, KeyRound, Loader2, Plus, ShieldOff, Terminal, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createApiToken, fetchApiTokenScopes, fetchApiTokens, revokeApiToken,
  type ApiTokenRow, type IssuedApiToken,
} from '@/lib/data';
import { formatDate } from '@/lib/format-time';
import { useT } from '@/lib/i18n';
import { getBackendBaseUrl } from '@/lib/runtime-url';
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
import { SettingsHeader } from './settings-primitives';

/**
 * API tokens — the developer surface of the organization.
 *
 * ## The one-time reveal is the whole design problem
 *
 * A secret shown once and never again is the correct storage decision and a
 * hostile interaction: the moment it appears is the only moment it exists, and
 * a stray click destroys it permanently. So the reveal is a modal that does not
 * close on an outside click or Escape, and its only exit is a button that says
 * what dismissing means. Everything else on this screen is ordinary; this part
 * is deliberately harder to dismiss than it is to read.
 *
 * ## Status is computed, never stored
 *
 * A token is expired when its date has passed, not when something wrote
 * "expired" somewhere. Persisting a status means a row that is stale between
 * the moment it expires and the moment a job notices — and the row is what the
 * admin reads when deciding whether a credential is still live.
 */

type Status = 'active' | 'expiring' | 'expired' | 'revoked';

/** Inside this window the row starts warning rather than merely reporting. */
const EXPIRY_WARNING_DAYS = 14;

function statusOf(token: ApiTokenRow, now = Date.now()): Status {
  if (token.revokedAt) return 'revoked';
  if (!token.expiresAt) return 'active';
  const remaining = new Date(token.expiresAt).getTime() - now;
  if (remaining <= 0) return 'expired';
  return remaining <= EXPIRY_WARNING_DAYS * 86_400_000 ? 'expiring' : 'active';
}

function daysUntil(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
}

function storedRole(): string {
  try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}').role || ''; }
  catch { return ''; }
}

/**
 * Copy, and say so.
 *
 * `navigator.clipboard` is unavailable on an insecure origin, which is exactly
 * how this product is reached on a LAN during setup. Failing silently there
 * would leave an admin who has one chance at this secret believing they copied
 * it — so the failure is loud and the text stays selectable either way.
 */
function useCopy() {
  const { t } = useT();
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (value: string) => {
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t('Could not copy — select the text and copy it manually'));
    }
  }, [t]);

  return { copied, copy };
}

/** Scopes grouped by the thing they act on, so the picker reads as a matrix. */
function groupScopes(scopes: string[]): { resource: string; actions: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const scope of scopes) {
    const [resource, action] = scope.split(':');
    groups.set(resource, [...(groups.get(resource) || []), action]);
  }
  return [...groups.entries()].map(([resource, actions]) => ({ resource, actions }));
}

export function ApiTokens() {
  const { t } = useT();
  const [rows, setRows] = useState<ApiTokenRow[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [defaultDays, setDefaultDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('90');
  const [saving, setSaving] = useState(false);

  const [issued, setIssued] = useState<IssuedApiToken | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiTokenRow | null>(null);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [tokens, catalogue] = await Promise.all([fetchApiTokens(), fetchApiTokenScopes()]);
      setRows(tokens);
      setScopes(catalogue.scopes);
      setDefaultDays(catalogue.defaultExpiryDays);
      setExpiry(String(catalogue.defaultExpiryDays));
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setCanManage(storedRole() === 'ADMIN'); void load(); }, [load]);

  const grouped = useMemo(() => groupScopes(scopes), [scopes]);
  const liveCount = useMemo(() => rows.filter((row) => statusOf(row) === 'active' || statusOf(row) === 'expiring').length, [rows]);

  const toggleScope = (scope: string) => {
    setPicked((current) => current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope]);
  };

  const openEditor = () => {
    setName('');
    setPicked([]);
    setExpiry(String(defaultDays));
    setEditorOpen(true);
  };

  const create = async () => {
    if (!name.trim() || !picked.length) return;
    setSaving(true);
    try {
      const token = await createApiToken({
        name: name.trim(),
        scopes: picked,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      });
      setEditorOpen(false);
      // The reveal replaces the editor rather than stacking on it: two open
      // layers over a secret is two ways to lose it.
      setIssued(token);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not create the API key'));
    } finally { setSaving(false); }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setSaving(true);
    try {
      await revokeApiToken(revokeTarget.id);
      toast.success(t('API key revoked'));
      setRevokeTarget(null);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not revoke the API key'));
    } finally { setSaving(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading API keys')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load API keys')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <SettingsHeader
      title={t('API keys')}
      description={t('Let your own software read and send on this organization. Each key carries only the permissions you grant it.')}
      action={canManage
        ? <Button onClick={openEditor}><Plus className="size-4" />{t('Create API key')}</Button>
        : <PermissionNotice action={t('Creating API keys')} className="self-center" />}
    />

    {/* The base URL, where a developer looks first. Read from the same runtime
        configuration the app itself uses, so it is right on a LAN, a laptop and
        a domain without anyone editing a string here. */}
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2.5 sm:px-6">
      <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-micro text-muted-foreground">{t('Base URL')}</span>
      <code className="rounded bg-background px-1.5 py-0.5 font-mono text-micro" dir="ltr">{getBackendBaseUrl()}/api/v1</code>
      <span className="text-micro text-muted-foreground">
        {t('Send the key as')} <code className="font-mono" dir="ltr">Authorization: Bearer …</code>
      </span>
    </div>

    <div className="min-h-0 flex-1 overflow-auto">
      {!rows.length
        ? <EmptyState
            icon={KeyRound}
            title={t('No API keys yet')}
            description={canManage
              ? t('Create a key to connect your own software to this organization.')
              : t('An organisation admin can create keys for developers here.')}
            action={canManage ? <Button onClick={openEditor}><Plus className="size-4" />{t('Create API key')}</Button> : undefined}
          />
        : <div className="divide-y divide-border border-b border-border">
            {rows.map((token) => {
              const status = statusOf(token);
              return <article key={token.id} className="grid gap-3 bg-card px-4 py-3.5 sm:grid-cols-[minmax(200px,1fr)_minmax(200px,1.3fr)_minmax(150px,0.7fr)_40px] sm:items-center sm:px-6">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-small font-semibold" dir="auto">{token.name}</h2>
                    <StatusBadge status={status} token={token} />
                    {/* Not decoration: an integrator seeing •••••• where a phone
                        number should be has no other way to learn why, and the
                        answer is a setting on the person who made the key. */}
                    {token.maskContactDetails && (
                      <Badge variant="outline" className="gap-1 text-muted-foreground">
                        <EyeOff className="size-3" aria-hidden />{t('Contact details masked')}
                      </Badge>
                    )}
                  </div>
                  {/* The prefix identifies the key without revealing anything.
                      It is what an admin matches against a log line. */}
                  <code className="mt-1 block font-mono text-micro text-muted-foreground" dir="ltr">
                    rbt_{token.prefix}_••••
                  </code>
                </div>

                <div className="flex flex-wrap gap-1">
                  {token.scopes.length
                    ? token.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="font-mono text-micro" dir="ltr">{scope}</Badge>
                      ))
                    // Not a rendering gap: the server treats an empty scope list
                    // as "nothing", so saying so is the accurate description.
                    : <span className="text-micro text-muted-foreground">{t('No permissions — this key can do nothing')}</span>}
                </div>

                <dl className="space-y-0.5 text-micro text-muted-foreground">
                  <div className="flex gap-1.5">
                    <dt>{t('Last used')}:</dt>
                    <dd dir={token.lastUsedAt ? 'ltr' : 'auto'}>
                      {token.lastUsedAt ? formatDate(token.lastUsedAt) : t('never')}
                    </dd>
                  </div>
                  <div className="flex gap-1.5">
                    <dt>{t('Expires')}:</dt>
                    <dd dir={token.expiresAt ? 'ltr' : 'auto'}>
                      {token.expiresAt ? formatDate(token.expiresAt) : t('never')}
                    </dd>
                  </div>
                </dl>

                {canManage && !token.revokedAt
                  ? <RowOverflowMenu
                      label={t('API key actions')}
                      actions={[{ label: t('Revoke key'), icon: Trash2, destructive: true, onSelect: () => setRevokeTarget(token) }]}
                    />
                  : <span />}
              </article>;
            })}
          </div>}
    </div>

    {/* ── create ─────────────────────────────────────────────────────────── */}
    <Drawer open={editorOpen} onOpenChange={setEditorOpen}>
      <DrawerContent closeLabel={t('Close')} className="sm:max-w-xl">
        <DrawerHeader>
          <DrawerTitle className="text-base font-semibold">{t('Create API key')}</DrawerTitle>
          <DrawerDescription>{t('The key is shown once, when it is created. It cannot be retrieved afterwards.')}</DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="space-y-6">
          <div className="space-y-1.5">
            <Label htmlFor="token-name">{t('Name')}</Label>
            <Input
              id="token-name" value={name} maxLength={60} dir="auto"
              placeholder={t('e.g. Website order form')}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="text-micro text-muted-foreground">{t('Name it after what will use it, so you know what breaks if you revoke it.')}</p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-small font-medium">{t('Permissions')}</legend>
            <p className="text-micro text-muted-foreground">{t('A key can do only what you tick here. Grant the least it needs.')}</p>
            <div className="space-y-2 pt-1">
              {grouped.map((group) => (
                <div key={group.resource} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                  <span className="me-auto font-mono text-caption" dir="ltr">{group.resource}</span>
                  {group.actions.map((action) => {
                    const scope = `${group.resource}:${action}`;
                    const on = picked.includes(scope);
                    return (
                      <button
                        key={scope}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleScope(scope)}
                        className={cn(
                          'rounded-md border px-2.5 py-1 font-mono text-micro transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent',
                        )}
                        dir="ltr"
                      >
                        {on ? <Check className="me-1 inline size-3" aria-hidden /> : null}{action}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="token-expiry">{t('Expires after')}</Label>
            <select
              id="token-expiry"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-small focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="30">{t('30 days')}</option>
              <option value="90">{t('90 days')}</option>
              <option value="180">{t('180 days')}</option>
              <option value="365">{t('One year')}</option>
              <option value="never">{t('Never expires')}</option>
            </select>
            {expiry === 'never' && (
              <p className="flex items-start gap-1.5 text-micro text-warning">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                {t('A key that never expires stays valid until someone remembers to revoke it. Prefer a date you can renew.')}
              </p>
            )}
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button>
          <Button onClick={() => void create()} disabled={saving || !name.trim() || !picked.length}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('Create API key')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>

    <RevealDialog issued={issued} onDone={() => setIssued(null)} />

    <ConfirmDialog
      open={!!revokeTarget}
      onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
      title={t('Revoke this API key')}
      description={t('Anything using this key stops working immediately, and the key cannot be restored. You will need to issue a new one and update the software that used it.')}
      cancelLabel={t('Cancel')}
      confirmLabel={t('Revoke key')}
      busy={saving}
      onConfirm={() => void revoke()}
    >
      {revokeTarget && (
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
          <p className="text-small font-medium" dir="auto">{revokeTarget.name}</p>
          <code className="font-mono text-micro text-muted-foreground" dir="ltr">rbt_{revokeTarget.prefix}_••••</code>
          <p className="mt-1 text-micro text-muted-foreground">
            {revokeTarget.lastUsedAt
              ? `${t('Last used')} ${formatDate(revokeTarget.lastUsedAt)}`
              : t('This key has never been used.')}
          </p>
        </div>
      )}
    </ConfirmDialog>

    {/* A quiet floor note rather than a banner: it is context, not an alert. */}
    {rows.length > 0 && (
      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2 text-micro text-muted-foreground sm:px-6">
        {/* A count and a sentence, not one sentence split into fragments around
            a number — a fragment pair translates into whichever word order the
            source language happened to have, which is wrong in at least one of
            the other two. */}
        <bdi dir="ltr">{liveCount}/{rows.length}</bdi>
        <span>{t('keys active')}</span>
        <span aria-hidden>·</span>
        <span>{t('Revoked keys stay listed as a record of what existed.')}</span>
      </footer>
    )}
  </div>;
}

function StatusBadge({ status, token }: { status: Status; token: ApiTokenRow }) {
  const { t } = useT();

  if (status === 'revoked') {
    return <Badge variant="outline" className="gap-1 text-muted-foreground"><ShieldOff className="size-3" aria-hidden />{t('Revoked')}</Badge>;
  }
  if (status === 'expired') {
    return <Badge variant="outline" className="gap-1 text-danger"><Clock className="size-3" aria-hidden />{t('Expired')}</Badge>;
  }
  if (status === 'expiring') {
    return (
      <Badge variant="outline" className="gap-1 text-warning">
        <Clock className="size-3" aria-hidden />
        {t('Expires in')} <bdi dir="ltr">{daysUntil(token.expiresAt!)}</bdi> {t('days')}
      </Badge>
    );
  }
  return <Badge variant="outline" className="gap-1 text-success">{t('Active')}</Badge>;
}

/**
 * The one-time reveal.
 *
 * Not dismissible by clicking away or pressing Escape, and the confirm button
 * is disabled until the secret has been copied or explicitly acknowledged. This
 * is the only screen in the product that deliberately makes itself harder to
 * close: everywhere else a mis-click costs a re-open, and here it costs a
 * credential that no longer exists anywhere.
 */
function RevealDialog({ issued, onDone }: { issued: IssuedApiToken | null; onDone: () => void }) {
  const { t } = useT();
  const { copied, copy } = useCopy();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => { setAcknowledged(false); }, [issued?.id]);

  if (!issued) return null;

  return (
    <Dialog open onOpenChange={() => { /* deliberately inert — see the docblock */ }}>
      <DialogContent
        className="sm:max-w-lg"
        // No corner X. With the dismissal paths above disabled it would be a
        // control that looks like it closes the dialog and does not — and a
        // control that does nothing is the one UI failure this codebase treats
        // as a defect rather than a polish item.
        showClose={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            {t('Copy your API key now')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="flex items-start gap-1.5 text-small text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t('This is the only time the key is shown. It is stored hashed, so nobody — including us — can show it to you again.')}
          </p>

          <div className="space-y-2">
            <Label htmlFor="issued-token">{issued.name}</Label>
            <div className="flex gap-2">
              <code
                id="issued-token"
                dir="ltr"
                className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-micro"
              >
                {issued.token}
              </code>
              <Button
                type="button"
                variant="outline"
                aria-label={t('Copy API key')}
                onClick={() => { void copy(issued.token); setAcknowledged(true); }}
              >
                {copied ? <Check className="size-4 text-success" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1">
            {issued.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-mono text-micro" dir="ltr">{scope}</Badge>
            ))}
          </div>

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
