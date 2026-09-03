'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Check, FileText, Loader2, Plus, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  archiveMetaMessageTemplate,
  createMetaMessageTemplate,
  fetchMetaMessageTemplates,
  submitMetaMessageTemplate,
  syncMetaMessageTemplates,
  type MetaMessageTemplate,
  type MetaTemplateComponent,
  type MetaTemplateListResponse,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SettingsHeader } from './settings-primitives';

type FormState = {
  name: string;
  language: string;
  category: 'UTILITY' | 'MARKETING';
  header: string;
  body: string;
  footer: string;
  quickReply: string;
  urlText: string;
  url: string;
};

const EMPTY_FORM: FormState = {
  name: '', language: 'ar', category: 'UTILITY', header: '', body: '', footer: '', quickReply: '', urlText: '', url: '',
};

const STATUS_KEYS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PAUSED: 'Paused',
  DISABLED: 'Disabled',
  UNKNOWN: 'Unknown provider status',
};

function componentsFor(form: FormState): MetaTemplateComponent[] {
  const components: MetaTemplateComponent[] = [{ type: 'BODY', text: form.body.trim() }];
  if (form.header.trim()) components.unshift({ type: 'HEADER', format: 'TEXT', text: form.header.trim() });
  if (form.footer.trim()) components.push({ type: 'FOOTER', text: form.footer.trim() });
  const buttons: Array<{ type: string; text: string; url?: string }> = [];
  if (form.quickReply.trim()) buttons.push({ type: 'QUICK_REPLY', text: form.quickReply.trim() });
  if (form.urlText.trim() && form.url.trim()) buttons.push({ type: 'URL', text: form.urlText.trim(), url: form.url.trim() });
  if (buttons.length) components.push({ type: 'BUTTONS', buttons });
  return components;
}

function bodyText(template: MetaMessageTemplate): string {
  const component = template.components.find((item) => item.type === 'BODY');
  return typeof component?.text === 'string' ? component.text : '';
}

function statusLabel(status: string, t: (key: string) => string): string {
  return t(STATUS_KEYS[status] || 'Unknown provider status');
}

export function OrganizationMetaTemplates() {
  const { t } = useT();
  const [state, setState] = useState<MetaTemplateListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<MetaMessageTemplate | null>(null);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try { setState(await fetchMetaMessageTemplates()); } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const templates = useMemo(() => state?.templates || [], [state]);
  const incompleteUrl = Boolean(form.urlText.trim()) !== Boolean(form.url.trim());
  const canCreate = Boolean(state?.canManage && state.wabaId && form.name.trim() && form.body.trim() && !incompleteUrl);

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await createMetaMessageTemplate({ name: form.name.trim(), language: form.language.trim(), category: form.category, components: componentsFor(form) });
      toast.success(t('Meta template draft created')); setEditorOpen(false); setForm(EMPTY_FORM); await load(false);
    } catch { toast.error(t('Could not create Meta template')); } finally { setBusy(false); }
  };

  const submit = async (template: MetaMessageTemplate) => {
    setBusy(true);
    try { await submitMetaMessageTemplate(template.id); toast.success(t('Meta template submitted')); await load(false); }
    catch { toast.error(t('Could not submit Meta template')); } finally { setBusy(false); }
  };

  const sync = async () => {
    setSyncing(true);
    try { await syncMetaMessageTemplates(); toast.success(t('Meta templates synchronized')); await load(false); }
    catch { toast.error(t('Could not synchronize Meta templates')); } finally { setSyncing(false); }
  };

  const archive = async () => {
    if (!archiveTarget) return;
    setBusy(true);
    try { await archiveMetaMessageTemplate(archiveTarget.id); setArchiveTarget(null); toast.success(t('Meta template archived')); await load(false); }
    catch { toast.error(t('Could not archive Meta template')); } finally { setBusy(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading Meta templates')} className="m-4" />;
  if (failed || !state) return <ErrorState title={t('Could not load Meta templates')} retryLabel={t('Try again')} onRetry={() => void load()} className="m-4" />;

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <SettingsHeader
      title={t('Meta templates')}
      description={t('Provider approval status for WhatsApp templates.')}
      action={<><div className="flex flex-wrap items-center gap-2">
        {state.canSync && <Button variant="outline" onClick={() => void sync()} disabled={syncing || !state.wabaId} title={!state.wabaId ? t('Connect Meta before synchronizing templates.') : undefined}><RefreshCw className={cn('size-4', syncing && 'animate-spin')} />{t('Sync now')}</Button>}
        {state.canManage && <Button onClick={() => setEditorOpen(true)} disabled={!state.wabaId} title={!state.wabaId ? t('Connect Meta before creating templates.') : undefined}><Plus className="size-4" />{t('Create draft')}</Button>}
      </div></>}
    />
    {!state.wabaId && <div className="border-b border-warning/30 bg-warning/10 px-4 py-3 text-caption text-warning sm:px-6">{t('Connect an active Meta credential before managing templates.')}</div>}
    {state.wabaId && !state.canManage && <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-caption text-muted-foreground sm:px-6"><ShieldCheck className="size-4" />{t('Only organization owners and managers can change Meta templates.')}</div>}
    <div className="min-h-0 flex-1 overflow-auto">
      {!templates.length ? <EmptyState icon={FileText} title={t('No Meta templates yet')} description={state.wabaId ? t('Create a draft or synchronize templates from Meta.') : t('Meta templates appear after a Meta credential is connected.')} action={state.canManage && state.wabaId ? <Button onClick={() => setEditorOpen(true)}><Plus className="size-4" />{t('Create draft')}</Button> : undefined} /> : <div className="divide-y divide-border border-b border-border">
        {templates.map((template) => <article key={template.id} className={cn('grid min-h-28 gap-3 bg-card px-4 py-4 sm:grid-cols-[minmax(180px,0.9fr)_minmax(240px,1.6fr)_120px_120px_90px] sm:items-center sm:px-6', template.archivedAt && 'opacity-60')}>
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="truncate text-small font-semibold">{template.name}</h2><Badge variant={template.status === 'APPROVED' ? 'default' : 'secondary'}>{statusLabel(template.status, t)}</Badge></div><div className="mt-1 flex flex-wrap gap-x-2 text-micro text-muted-foreground"><bdi dir="ltr">{template.language}</bdi><span>·</span><span>{template.category === 'UTILITY' ? t('Utility') : template.category === 'MARKETING' ? t('Marketing') : template.category}</span></div><div className="mt-1 truncate font-mono text-micro text-muted-foreground" dir="ltr">{template.providerId || t('Local draft')}</div></div>
          <p dir="auto" className="line-clamp-3 whitespace-pre-wrap text-caption text-muted-foreground">{bodyText(template) || template.unsupportedReason || t('No body available')}</p>
          <div className="text-caption text-muted-foreground"><span className="block text-micro">{t('Last synchronized')}</span><span>{template.lastSyncedAt ? new Date(template.lastSyncedAt).toLocaleString() : t('Not synchronized')}</span></div>
          <div className="text-caption text-muted-foreground">{template.rejectionReason || (template.isSupported ? t('Phase 1 supported shape') : template.unsupportedReason || t('Outside phase 1 scope'))}</div>
          <div className="flex items-center justify-end gap-1">{state.canManage && template.status === 'DRAFT' && !template.archivedAt && <Button variant="outline" size="sm" onClick={() => void submit(template)} disabled={busy || !state.wabaId}><Send className="size-4" />{t('Submit')}</Button>}{state.canManage && !template.archivedAt && <Button variant="ghost" size="icon" aria-label={t('Archive Meta template')} title={t('Archive Meta template')} onClick={() => setArchiveTarget(template)} disabled={busy}><Archive className="size-4" /></Button>}</div>
        </article>)}
      </div>}
    </div>

    <Drawer open={editorOpen} onOpenChange={setEditorOpen}><DrawerContent closeLabel={t('Close')} className="sm:max-w-xl"><DrawerHeader><DrawerTitle className="text-base font-semibold">{t('Create Meta template draft')}</DrawerTitle><DrawerDescription>{t('Only Utility and Marketing text templates are available in phase 1.')}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-5">
      <div className="space-y-1.5"><Label htmlFor="meta-template-name">{t('Template name')}</Label><Input id="meta-template-name" dir="ltr" placeholder="order_ready" maxLength={512} value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} /></div>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="meta-template-language">{t('Language')}</Label><Input id="meta-template-language" dir="ltr" placeholder="ar" maxLength={35} value={form.language} onChange={(event) => setForm((value) => ({ ...value, language: event.target.value }))} /></div><div className="space-y-1.5"><Label htmlFor="meta-template-category">{t('Category')}</Label><Select value={form.category} onValueChange={(value: 'UTILITY' | 'MARKETING') => setForm((current) => ({ ...current, category: value }))}><SelectTrigger id="meta-template-category"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="UTILITY">{t('Utility')}</SelectItem><SelectItem value="MARKETING">{t('Marketing')}</SelectItem></SelectContent></Select></div></div>
      <div className="space-y-1.5"><Label htmlFor="meta-template-header">{t('Text header')}</Label><Input id="meta-template-header" dir="auto" value={form.header} onChange={(event) => setForm((value) => ({ ...value, header: event.target.value }))} /></div>
      <div className="space-y-1.5"><Label htmlFor="meta-template-body">{t('Body')}</Label><Textarea id="meta-template-body" rows={7} dir="auto" value={form.body} onChange={(event) => setForm((value) => ({ ...value, body: event.target.value }))} /></div>
      <div className="space-y-1.5"><Label htmlFor="meta-template-footer">{t('Footer')}</Label><Input id="meta-template-footer" dir="auto" value={form.footer} onChange={(event) => setForm((value) => ({ ...value, footer: event.target.value }))} /></div>
      <fieldset className="space-y-3"><legend className="text-small font-medium">{t('Buttons')}</legend><div className="space-y-1.5"><Label htmlFor="meta-template-quick-reply">{t('Quick reply text')}</Label><Input id="meta-template-quick-reply" dir="auto" value={form.quickReply} onChange={(event) => setForm((value) => ({ ...value, quickReply: event.target.value }))} /></div><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-1.5"><Label htmlFor="meta-template-url-text">{t('URL button text')}</Label><Input id="meta-template-url-text" dir="auto" value={form.urlText} onChange={(event) => setForm((value) => ({ ...value, urlText: event.target.value }))} /></div><div className="space-y-1.5"><Label htmlFor="meta-template-url">{t('URL')}</Label><Input id="meta-template-url" dir="ltr" value={form.url} onChange={(event) => setForm((value) => ({ ...value, url: event.target.value }))} /></div></div>{incompleteUrl && <p className="text-caption text-destructive">{t('A URL button needs both text and URL.')}</p>}</fieldset>
    </DrawerBody><DrawerFooter><Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button><Button disabled={busy || !canCreate} onClick={() => void create()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t('Save draft')}</Button></DrawerFooter></DrawerContent></Drawer>
    <ConfirmDialog open={!!archiveTarget} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }} title={t('Archive Meta template')} description={t('This keeps the provider record for history but removes the template from active lifecycle management.')} cancelLabel={t('Cancel')} confirmLabel={t('Archive Meta template')} onConfirm={archive} busy={busy} />
  </div>;
}
