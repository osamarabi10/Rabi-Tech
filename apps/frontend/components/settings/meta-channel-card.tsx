'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Cloud, Loader2, Radio, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  connectMetaChannel,
  disconnectMetaChannel,
  fetchMetaChannel,
  setActiveChannel,
  type MetaChannel,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DangerZone } from '@/components/ui/feedback-primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PermissionNotice } from '@/components/permission-notice';

/**
 * Connecting a Meta WhatsApp Cloud API number.
 *
 * Kept in its own file rather than inlined into WorkspaceChannels because the
 * two channels share a page and nothing else: OpenWA is paired by scanning a
 * QR, Meta by pasting its identifiers and token, and the states they can be in do not
 * overlap at all.
 */

/**
 * Server failure code to dictionary key.
 *
 * The API also returns a human `message`, but it is Arabic regardless of who is
 * reading — so the code is what gets rendered, and the server's copy is only
 * the fallback for a code this build has not heard of yet. That fallback is why
 * an older frontend against a newer backend degrades to "an unfamiliar message
 * in one language" rather than to a blank error.
 */
const PROBLEM_TEXT: Record<string, string> = {
  META_VAULT_LOCKED:
    'Meta credentials cannot be saved while the platform is running with insecure secrets. Contact the platform administrator.',
  META_MISSING_FIELDS: 'All four fields are required.',
  META_PHONE_NUMBER_INVALID:
    'The Phone Number ID is wrong, or the token cannot reach it. Copy it from WhatsApp → API setup in Meta Business Suite — it is a long number, not the phone number itself.',
  META_WABA_ACCESS_DENIED:
    'The token has no management access to that WhatsApp Business Account. Check the System User is added to the account with the whatsapp_business_management permission.',
  META_WABA_PHONE_MISMATCH:
    'That phone number does not belong to the WhatsApp Business Account you entered. The two IDs come from different accounts.',
  META_SUBSCRIBE_FAILED:
    'The webhook could not be subscribed. Without it you could send but never receive a single message, so nothing was saved.',
  META_SUBSCRIBE_REFUSED:
    'Meta refused the webhook subscription without giving a reason. Try again, and if it persists check the app is added to your WhatsApp Business Account.',
  META_NUMBER_ALREADY_CLAIMED:
    'This number is already connected to another workspace. The same number cannot be linked twice, because inbound messages would not know where to go.',
  META_STANDING_UNAVAILABLE:
    'Connected, but the messaging tier and quality rating could not be read. The channel works; the values appear after the next successful refresh.',
};

const EMPTY_FORM = { phoneNumberId: '', wabaId: '', businessPortfolioId: '', accessToken: '' };

export function MetaChannelCard({ canManage, resolutionCode, refreshToken, onChannelChanged }: {
  canManage: boolean;
  resolutionCode: string | null;
  refreshToken: number;
  onChannelChanged: () => Promise<void>;
}) {
  const { t } = useT();
  const [channel, setChannel] = useState<MetaChannel | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmActivate, setConfirmActivate] = useState(false);
  const canSubmit = Boolean(
    form.phoneNumberId.trim()
    && form.wabaId.trim()
    && form.businessPortfolioId.trim()
    && form.accessToken.trim(),
  );

  const load = useCallback(async () => {
    if (!canManage) { setLoading(false); return; }
    try {
      setChannel(await fetchMetaChannel());
    } catch {
      // Reading the channel is not the point of this page. A failure here shows
      // as "not connected" rather than as an error state that would also hide
      // the OpenWA channels the admin came to look at.
      setChannel(null);
    } finally {
      setLoading(false);
    }
  }, [canManage, refreshToken]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await connectMetaChannel({
        phoneNumberId: form.phoneNumberId.trim(),
        wabaId: form.wabaId.trim(),
        businessPortfolioId: form.businessPortfolioId.trim(),
        accessToken: form.accessToken.trim(),
      });
      setChannel(result.channel);
      setForm(EMPTY_FORM);
      setOpen(false);
      await onChannelChanged();
      toast.success(t('Meta channel connected'));
      // A connection that succeeded with a caveat still succeeded, so this is a
      // second notice rather than an error: the channel is live either way.
      if (result.warning) {
        toast.warning(t(PROBLEM_TEXT[result.warning.code] || result.warning.message));
      }
    } catch (error: any) {
      const code = error?.response?.data?.code;
      const serverMessage = error?.response?.data?.error;
      // Stays in the dialog, deliberately. Every one of these is a value in the
      // form that has to be corrected, and a toast disappears before the admin
      // has finished re-reading which of the three fields is wrong.
      setProblem(
        (code && PROBLEM_TEXT[code] && t(PROBLEM_TEXT[code]))
        || serverMessage
        || t('Could not connect the Meta channel'),
      );
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    setBusy(true);
    try {
      // The kind travels as data, never as a comparison. Which channel this card
      // manages is this component's own subject; what that channel can DO is
      // read from the capability descriptor, never inferred from its name.
      await setActiveChannel('WHATSAPP_CLOUD');
      setConfirmActivate(false);
      await onChannelChanged();
      setChannel(await fetchMetaChannel());
      toast.success(t('This workspace now sends through Meta'));
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not switch the sending channel'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await disconnectMetaChannel();
      setChannel(null);
      setConfirmRemove(false);
      await onChannelChanged();
      toast.success(t('Meta credentials removed'));
    } catch {
      toast.error(t('Could not remove Meta credentials'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 border border-border bg-card p-4 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-info/10 text-info">
          <Cloud className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-small font-semibold">WhatsApp {t('Cloud API')}</h2>
            {loading
              ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
              : <ConnectionPill connected={!!channel} label={channel ? t('Connected') : t('Not connected')} />}
          </div>
          <p className="mt-1 text-caption text-muted-foreground">
            {t('Connect your own Meta WhatsApp Business account. Messaging is billed by Meta directly to you.')}
          </p>
        </div>
      </div>

      {!canManage ? (
        <PermissionNotice action={t('Connect Meta channel')} className="mt-4" />
      ) : channel ? (
        <>
          <dl className="mt-5 grid gap-x-4 gap-y-2 text-caption sm:grid-cols-2">
            <Row label={t('Linked number')} value={channel.displayPhoneNumber} ltr />
            <Row label={t('Verified name')} value={channel.verifiedName} />
            <Row label={t('Quality rating')} value={channel.qualityRating} fallback={t('Not yet read')} />
            <Row label={t('Messaging tier')} value={channel.messagingTier} fallback={t('Not yet read')} />
            <Row label={t('Phone Number ID')} value={channel.phoneNumberId} ltr mono />
            <Row label={t('Graph version')} value={channel.graphVersion} ltr mono />
          </dl>

          {/* A dead token degrades the channel visibly, with the reason the
              server recorded and what to do about it. The alternative is
              messages that quietly stop arriving. */}
          {channel.invalidReason && (
            <p role="alert" className="mt-4 flex items-start gap-2 border-s-2 border-danger bg-danger/5 px-3 py-2 text-caption text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>{channel.invalidReason}</span>
            </p>
          )}

          {(!channel.isActiveChannel || resolutionCode === 'CHANNEL_AMBIGUOUS') && (
            <div className="mt-4 space-y-2">
              <p className="text-micro text-muted-foreground">
                {t('Connected, but this workspace still sends through its other channel.')}
              </p>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmActivate(true)}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Radio className="size-4" />}
                {resolutionCode === 'CHANNEL_AMBIGUOUS' ? t('Use Meta and repair sending') : t('Send through this channel')}
              </Button>
            </div>
          )}

          <DangerZone
            className="mt-5"
            title={t('Meta credentials')}
            description={t('The access token is deleted from RabiTech. Your Meta account and its webhook subscription are left untouched.')}
          >
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="size-4" />{t('Remove Meta credentials')}
            </Button>
          </DangerZone>
        </>
      ) : (
        <div className="mt-5">
          <Button type="button" size="sm" onClick={() => { setProblem(null); setOpen(true); }}>
            <Cloud className="size-4" />{t('Connect Meta number')}
          </Button>
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => { if (!busy) { setOpen(next); if (!next) setProblem(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('Connect Meta number')}</DialogTitle>
            <DialogDescription>{t('Copy all four values from Meta Business Suite, under WhatsApp → API setup.')}</DialogDescription>
          </DialogHeader>

          <form
            className="space-y-4"
            onSubmit={(event) => { event.preventDefault(); if (!busy) submit(); }}
          >
            <Field
              id="meta-phone-number-id"
              label={t('Phone Number ID')}
              value={form.phoneNumberId}
              onChange={(value) => setForm((f) => ({ ...f, phoneNumberId: value }))}
            />
            <Field
              id="meta-waba-id"
              label={t('WhatsApp Business Account ID')}
              value={form.wabaId}
              onChange={(value) => setForm((f) => ({ ...f, wabaId: value }))}
            />
            <Field
              id="meta-business-portfolio-id"
              label={t('Business Portfolio ID')}
              value={form.businessPortfolioId}
              onChange={(value) => setForm((f) => ({ ...f, businessPortfolioId: value }))}
            />
            <div className="space-y-1.5">
              <Label htmlFor="meta-access-token">{t('System User access token')}</Label>
              <Input
                id="meta-access-token"
                type="password"
                dir="ltr"
                className="text-start font-mono"
                autoComplete="off"
                value={form.accessToken}
                onChange={(event) => setForm((f) => ({ ...f, accessToken: event.target.value }))}
              />
              <p className="text-micro text-muted-foreground">{t('Stored encrypted, and never shown again after saving.')}</p>
            </div>

            {problem && (
              <p role="alert" className="border-s-2 border-danger bg-danger/5 px-3 py-2 text-caption text-danger">
                {problem}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                {t('Cancel')}
              </Button>
              <Button type="submit" disabled={busy || !canSubmit}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? t('Checking with Meta…') : t('Connect')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmActivate}
        onOpenChange={setConfirmActivate}
        title={t('Switch sending channel to Meta?')}
        description={t('Future messages and automatic replies will use Meta. Customer messages sent to inactive OpenWA numbers will not reach RabiTech until OpenWA is reactivated. Existing conversations and message history remain saved.')}
        cancelLabel={t('Cancel')}
        confirmLabel={resolutionCode === 'CHANNEL_AMBIGUOUS' ? t('Use Meta and repair sending') : t('Send through this channel')}
        onConfirm={activate}
        busy={busy}
        destructive={false}
      />

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={(next) => { if (!next) setConfirmRemove(false); }}
        title={t('Remove Meta credentials')}
        description={t('The access token is deleted from RabiTech. Your Meta account and its webhook subscription are left untouched.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Remove Meta credentials')}
        onConfirm={remove}
        busy={busy}
        destructive
      />
    </section>
  );
}

function ConnectionPill({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span className={connected
      ? 'inline-flex items-center gap-1.5 text-caption font-medium text-success'
      : 'inline-flex items-center gap-1.5 text-caption font-medium text-muted-foreground'}
    >
      <span className="size-2 rounded-full bg-current" />{label}
    </span>
  );
}

function Row({ label, value, fallback, ltr, mono }: {
  label: string;
  value: string | null;
  fallback?: string;
  ltr?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`min-w-0 truncate font-medium ${mono ? 'font-mono text-micro' : ''}`}
        dir={ltr ? 'ltr' : undefined}
      >
        {value || fallback || '—'}
      </dd>
    </div>
  );
}

function Field({ id, label, value, onChange }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {/* An identifier is a number Meta issued, not prose: it reads left to
          right in every locale this product ships. */}
      <Input
        id={id}
        dir="ltr"
        className="text-start font-mono"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
