'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Braces, Eye, Loader2, LockKeyhole, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { deleteCustomField, fetchContactFields, saveContactFieldView, saveCustomField, type ContactFieldRow } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ListToolbar, RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton, NoResultsState } from '@/components/ui/operational-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

const TYPES = ['text', 'list', 'checkbox', 'email', 'number', 'url', 'date', 'time'] as const;
type FieldForm = { name: string; slug: string; description: string; dataType: typeof TYPES[number]; allowedValues: string };
const EMPTY_FORM: FieldForm = { name: '', slug: '', description: '', dataType: 'text', allowedValues: '' };

function makeSlug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

function storedRole(): string {
  try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}').role || ''; }
  catch { return ''; }
}

export function WorkspaceContactFields() {
  const { t } = useT();
  const [rows, setRows] = useState<ContactFieldRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [canDelete, setCanDelete] = useState(false);
  const [selected, setSelected] = useState<ContactFieldRow | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewRows, setViewRows] = useState<ContactFieldRow[]>([]);
  const [form, setForm] = useState<FieldForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ContactFieldRow | null>(null);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const next = await fetchContactFields();
      setRows(next);
      setViewRows(next);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const role = storedRole();
    setCanManage(['ADMIN', 'SUPERVISOR'].includes(role));
    setCanDelete(role === 'ADMIN');
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => !needle || [row.name, row.slug || '', row.description || '', row.dataType].some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [query, rows]);

  const openEditor = (field?: ContactFieldRow) => {
    setSelected(field || null);
    setForm(field ? {
      name: field.name,
      slug: field.slug || '',
      description: field.description || '',
      dataType: field.dataType as FieldForm['dataType'],
      allowedValues: (field.allowedValues || []).join('\n'),
    } : EMPTY_FORM);
    setEditorOpen(true);
  };

  const persist = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await saveCustomField({
        id: selected?.id,
        name: form.name.trim(),
        ...(!selected ? { slug: form.slug, dataType: form.dataType } : {}),
        description: form.description.trim() || null,
        allowedValues: form.dataType === 'list' ? form.allowedValues.split('\n').map((value) => value.trim()).filter(Boolean) : [],
      });
      toast.success(selected ? t('Contact field updated') : t('Contact field created'));
      setEditorOpen(false);
      await load(false);
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not save Contact field')); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleteTarget?.id) return;
    setSaving(true);
    try { await deleteCustomField(deleteTarget.id); toast.success(t('Contact field deleted')); setDeleteTarget(null); await load(false); }
    catch (error: any) { toast.error(error?.response?.data?.error || t('Could not delete Contact field')); }
    finally { setSaving(false); }
  };

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= viewRows.length) return;
    setViewRows((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const persistView = async () => {
    setSaving(true);
    try {
      await saveContactFieldView(viewRows.map(({ fieldKey, visibility }) => ({ fieldKey, visibility })));
      setRows(viewRows.map((row, sortOrder) => ({ ...row, sortOrder })));
      setViewOpen(false);
      toast.success(t('Contact field view updated'));
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not update Contact field view')); }
    finally { setSaving(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading Contact fields')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load Contact fields')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-4 sm:px-6">
      <div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">{t('Contact fields')}</h1><p className="mt-1 text-caption text-muted-foreground">{t('Define validated Contact data for personalization, filters, and Workflows.')}</p></div>
      {canManage && <div className="flex gap-2"><Button variant="outline" onClick={() => { setViewRows(rows); setViewOpen(true); }}><Settings2 className="size-4" />{t('Customize view')}</Button><Button onClick={() => openEditor()}><Plus className="size-4" />{t('Add custom field')}</Button></div>}
    </header>
    <ListToolbar searchValue={query} onSearchChange={setQuery} searchLabel={t('Search Contact fields')} clearSearchLabel={t('Clear search')} />
    <div className="min-h-0 flex-1 overflow-auto">
      {!rows.length ? <EmptyState icon={Braces} title={t('No Contact fields')} description={t('Standard Contact fields could not be loaded.')} /> : !shown.length ? <NoResultsState title={t('No Contact fields match this search')} clearLabel={t('Clear search')} onClear={() => setQuery('')} /> : <div className="divide-y divide-border border-b border-border">
        {shown.map((field) => <article key={field.fieldKey} className="grid min-h-20 gap-3 bg-card px-4 py-3 sm:grid-cols-[minmax(210px,1fr)_130px_minmax(180px,1fr)_145px_40px] sm:items-center sm:px-6">
          <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate text-small font-semibold" dir="auto">{field.name}</h2><Badge variant={field.kind === 'STANDARD' ? 'secondary' : 'outline'}>{field.kind === 'STANDARD' ? t('Standard') : t('Custom')}</Badge></div><p className="mt-1 truncate font-mono text-micro text-muted-foreground" dir="ltr">{field.kind === 'CUSTOM' ? `$contact.${field.slug}` : field.fieldKey}</p></div>
          <span className="text-caption text-muted-foreground">{t(`Field type: ${field.dataType}`)}</span>
          <p className="line-clamp-2 text-caption text-muted-foreground" dir="auto">{field.description || t('No description')}</p>
          <span className="flex items-center gap-1 text-caption text-muted-foreground"><Eye className="size-3.5" />{t(field.visibility)}</span>
          {canManage && field.kind === 'CUSTOM' ? <RowOverflowMenu label={t('Contact field actions')} actions={[{ label: t('Edit Contact field'), icon: Pencil, onSelect: () => openEditor(field) }, ...(canDelete ? [{ label: t('Delete Contact field'), icon: Trash2, destructive: true, onSelect: () => setDeleteTarget(field) }] : [])]} /> : <LockKeyhole className="size-4 text-muted-foreground" aria-label={t('Standard fields are locked')} />}
        </article>)}
      </div>}
    </div>

    <Drawer open={editorOpen} onOpenChange={setEditorOpen}><DrawerContent closeLabel={t('Close')} className="sm:max-w-lg"><DrawerHeader><DrawerTitle className="text-base font-semibold">{selected ? t('Edit Contact field') : t('Add custom field')}</DrawerTitle><DrawerDescription>{selected ? t('Field ID and type cannot change after creation.') : t('Choose a type that validates the data agents will collect.')}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-5">
      <div className="space-y-1.5"><Label htmlFor="field-name">{t('Name')}</Label><Input id="field-name" value={form.name} maxLength={80} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value, ...(!selected ? { slug: makeSlug(event.target.value) } : {}) }))} /></div>
      <div className="space-y-1.5"><Label htmlFor="field-id">{t('Field ID')}</Label><Input id="field-id" value={form.slug} dir="ltr" disabled={!!selected} onChange={(event) => setForm((value) => ({ ...value, slug: makeSlug(event.target.value) }))} /><p className="text-micro text-muted-foreground">{t('Used by APIs, Workflows, and dynamic variables.')}</p></div>
      <div className="space-y-1.5"><Label>{t('Field type')}</Label><Select value={form.dataType} disabled={!!selected} onValueChange={(dataType) => setForm((value) => ({ ...value, dataType: dataType as FieldForm['dataType'] }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{TYPES.map((type) => <SelectItem key={type} value={type}>{t(`Field type: ${type}`)}</SelectItem>)}</SelectContent></Select></div>
      {form.dataType === 'list' && <div className="space-y-1.5"><Label htmlFor="field-options">{t('List values')}</Label><Textarea id="field-options" value={form.allowedValues} rows={6} dir="auto" placeholder={t('One value per line')} onChange={(event) => setForm((value) => ({ ...value, allowedValues: event.target.value }))} /></div>}
      <div className="space-y-1.5"><Label htmlFor="field-description">{t('Description')}</Label><Textarea id="field-description" value={form.description} maxLength={255} rows={4} dir="auto" onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} /></div>
    </DrawerBody><DrawerFooter><Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button><Button disabled={saving || !form.name.trim() || !form.slug} onClick={() => void persist()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('Save')}</Button></DrawerFooter></DrawerContent></Drawer>

    <Drawer open={viewOpen} onOpenChange={setViewOpen}><DrawerContent closeLabel={t('Close')} className="sm:max-w-xl"><DrawerHeader><DrawerTitle className="text-base font-semibold">{t('Customize Contact field view')}</DrawerTitle><DrawerDescription>{t('This order and visibility applies to every workspace user.')}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-2">{viewRows.map((field, index) => <div key={field.fieldKey} className="grid grid-cols-[minmax(0,1fr)_155px_72px] items-center gap-2 border-b border-border py-2"><div className="min-w-0"><p className="truncate text-small font-medium">{field.name}</p><p className="truncate font-mono text-micro text-muted-foreground" dir="ltr">{field.kind === 'CUSTOM' ? field.slug : field.fieldKey}</p></div><Select value={field.visibility} onValueChange={(visibility) => setViewRows((current) => current.map((row) => row.fieldKey === field.fieldKey ? { ...row, visibility: visibility as ContactFieldRow['visibility'] } : row))}><SelectTrigger aria-label={`${t('Visibility')} ${field.name}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALWAYS_SHOW">{t('ALWAYS_SHOW')}</SelectItem><SelectItem value="HIDE_WHEN_EMPTY">{t('HIDE_WHEN_EMPTY')}</SelectItem><SelectItem value="ALWAYS_HIDE">{t('ALWAYS_HIDE')}</SelectItem></SelectContent></Select><div className="flex"><Button variant="ghost" size="icon" className="size-8" disabled={index === 0} aria-label={`${t('Move up')} ${field.name}`} onClick={() => move(index, -1)}><ArrowUp className="size-4" /></Button><Button variant="ghost" size="icon" className="size-8" disabled={index === viewRows.length - 1} aria-label={`${t('Move down')} ${field.name}`} onClick={() => move(index, 1)}><ArrowDown className="size-4" /></Button></div></div>)}</DrawerBody><DrawerFooter><Button variant="outline" onClick={() => setViewOpen(false)}>{t('Cancel')}</Button><Button disabled={saving} onClick={() => void persistView()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('Save view')}</Button></DrawerFooter></DrawerContent></Drawer>

    <ConfirmDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title={t('Delete Contact field')} description={t('This permanently removes the field and every value stored for it. This cannot be undone.')} cancelLabel={t('Cancel')} confirmLabel={t('Delete Contact field')} onConfirm={remove} busy={saving} />
  </div>;
}
