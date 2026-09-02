'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Loader2, Pencil, Plus, Tags, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { deleteCrmTag, fetchCrmTags, saveCrmTag, type CrmTag } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ListToolbar, RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton, NoResultsState } from '@/components/ui/operational-state';
import { Textarea } from '@/components/ui/textarea';
import { SettingsListPage } from './settings-primitives';

const COLORS = ['#2563eb', '#0f766e', '#16a34a', '#ca8a04', '#ea580c', '#dc2626', '#db2777', '#7c3aed', '#64748b'];
type TagForm = { name: string; emoji: string; colorCode: string; description: string };
const EMPTY_FORM: TagForm = { name: '', emoji: '', colorCode: '#64748b', description: '' };

function storedRole(): string {
  try { return JSON.parse(localStorage.getItem('rabitech_user') || '{}').role || ''; }
  catch { return ''; }
}

export function WorkspaceTags() {
  const { t } = useT();
  const [rows, setRows] = useState<CrmTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [canManage, setCanManage] = useState(false);
  const [selected, setSelected] = useState<CrmTag | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<TagForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CrmTag | null>(null);
  const [confirmCount, setConfirmCount] = useState('');

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try { setRows(await fetchCrmTags()); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setCanManage(['ADMIN', 'SUPERVISOR'].includes(storedRole())); void load(); }, [load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return rows.filter((row) => !needle || [row.name, row.description || '', row.emoji || '', row.id].some((value) => value.toLocaleLowerCase().includes(needle)));
  }, [query, rows]);

  const openEditor = (tag?: CrmTag) => {
    setSelected(tag || null);
    setForm(tag ? { name: tag.name, emoji: tag.emoji || '', colorCode: tag.colorCode || '#64748b', description: tag.description || '' } : EMPTY_FORM);
    setEditorOpen(true);
  };

  const persist = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await saveCrmTag({ id: selected?.id, name: form.name.trim(), emoji: form.emoji.trim() || null, colorCode: form.colorCode, description: form.description.trim() || null });
      toast.success(selected ? t('Tag updated') : t('Tag created'));
      setEditorOpen(false);
      await load(false);
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not save Tag')); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try {
      await deleteCrmTag(deleteTarget.id, Number(confirmCount));
      toast.success(t('Tag deleted'));
      setDeleteTarget(null);
      setConfirmCount('');
      await load(false);
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not delete Tag')); }
    finally { setSaving(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading Tags')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load Tags')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return <SettingsListPage
    title={t('Tags')}
    description={t('Organize Contacts for filters, Segments, Broadcasts, and Workflows.')}
    action={canManage
      ? <Button onClick={() => openEditor()}><Plus className="size-4" />{t('Create Tag')}</Button>
      : undefined}
    toolbar={<ListToolbar searchValue={query} onSearchChange={setQuery} searchLabel={t('Search Tags')} clearSearchLabel={t('Clear search')} />}
  >
    <div>
      {!rows.length ? <EmptyState icon={Tags} title={t('No Tags yet')} description={canManage ? t('Create the first shared Contact Tag.') : t('Tags created while working with Contacts will appear here.')} action={canManage ? <Button onClick={() => openEditor()}><Plus className="size-4" />{t('Create Tag')}</Button> : undefined} /> : !shown.length ? <NoResultsState title={t('No Tags match this search')} clearLabel={t('Clear search')} onClear={() => setQuery('')} /> : <div className="divide-y divide-border border-b border-border">
        {shown.map((tag) => <article key={tag.id} className="grid min-h-20 gap-3 bg-card px-4 py-3 sm:grid-cols-[minmax(200px,0.9fr)_minmax(260px,1.6fr)_120px_40px] sm:items-center sm:px-6">
          <div className="flex min-w-0 items-center gap-3"><span className="size-3 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: tag.colorCode || '#64748b' }} /><div className="min-w-0"><h2 className="truncate text-small font-semibold" dir="auto">{tag.emoji ? `${tag.emoji} ` : ''}{tag.name}</h2><span className="mt-1 flex items-center gap-1 font-mono text-micro text-muted-foreground" dir="ltr"><Hash className="size-3" />{tag.id}</span></div></div>
          <p className="line-clamp-2 text-caption text-muted-foreground" dir="auto">{tag.description || t('No description')}</p>
          <Badge variant="outline" className="w-fit gap-1"><Users className="size-3" />{tag.contactCount || 0} {t('Contacts')}</Badge>
          {canManage ? <RowOverflowMenu label={t('Tag actions')} actions={[{ label: t('Edit Tag'), icon: Pencil, onSelect: () => openEditor(tag) }, { label: t('Delete Tag'), icon: Trash2, destructive: true, onSelect: () => { setDeleteTarget(tag); setConfirmCount(''); } }]} /> : <span />}
        </article>)}
      </div>}
    </div>

    <Drawer open={editorOpen} onOpenChange={setEditorOpen}><DrawerContent closeLabel={t('Close')} className="sm:max-w-lg"><DrawerHeader><DrawerTitle className="text-base font-semibold">{selected ? t('Edit Tag') : t('Create Tag')}</DrawerTitle><DrawerDescription>{t('The description helps agents apply the Tag consistently.')}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-[1fr_110px]"><div className="space-y-1.5"><Label htmlFor="tag-name">{t('Name')}</Label><Input id="tag-name" value={form.name} maxLength={80} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} /></div><div className="space-y-1.5"><Label htmlFor="tag-emoji">{t('Emoji')}</Label><Input id="tag-emoji" value={form.emoji} maxLength={16} dir="auto" onChange={(event) => setForm((value) => ({ ...value, emoji: event.target.value }))} /></div></div>
      <fieldset className="space-y-2"><legend className="text-small font-medium">{t('Color')}</legend><div className="flex flex-wrap gap-2">{COLORS.map((color) => <button key={color} type="button" aria-label={`${t('Select color')} ${color}`} aria-pressed={form.colorCode === color} onClick={() => setForm((value) => ({ ...value, colorCode: color }))} className={cn('size-8 rounded-md border-2 transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', form.colorCode === color ? 'border-foreground' : 'border-transparent')} style={{ backgroundColor: color }} />)}</div></fieldset>
      <div className="space-y-1.5"><Label htmlFor="tag-description">{t('Description')}</Label><Textarea id="tag-description" value={form.description} maxLength={255} rows={4} dir="auto" onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} /></div>
    </DrawerBody><DrawerFooter><Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button><Button onClick={() => void persist()} disabled={saving || !form.name.trim()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}{t('Save')}</Button></DrawerFooter></DrawerContent></Drawer>

    <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setConfirmCount(''); } }}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t('Delete Tag permanently')}</DialogTitle></DialogHeader><div className="space-y-4"><p className="text-small text-muted-foreground">{t('This removes the Tag from every Contact and may change Segments and Workflows.')}</p><div className="space-y-1.5"><Label htmlFor="tag-delete-count">{t('Enter the assigned Contact count to confirm')}: <bdi dir="ltr">{deleteTarget?.contactCount || 0}</bdi></Label><Input id="tag-delete-count" inputMode="numeric" dir="ltr" value={confirmCount} onChange={(event) => setConfirmCount(event.target.value.replace(/\D/g, ''))} /></div></div><DialogFooter><Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('Cancel')}</Button><Button variant="destructive" disabled={saving || Number(confirmCount) !== (deleteTarget?.contactCount || 0)} onClick={() => void remove()}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}{t('Delete Tag')}</Button></DialogFooter></DialogContent></Dialog>
  </SettingsListPage>;
}
