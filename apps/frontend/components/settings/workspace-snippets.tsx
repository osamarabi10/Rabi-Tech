'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, File, FileText, Hash, Loader2, Paperclip, Pencil, Plus, ShieldCheck, Tags, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  createSnippetTopic, deleteSnippet, deleteSnippetAttachment, deleteSnippetTopic,
  fetchSnippets, fetchSnippetTopics, fetchWorkspaceUsers, saveSnippet,
  uploadSnippetAttachment, type SnippetAttachment, type SnippetTopic, type Template,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Drawer, DrawerBody, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ListToolbar, RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton, NoResultsState } from '@/components/ui/operational-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SettingsHeader } from './settings-primitives';

type FormState = { title: string; body: string; shortCode: string; topicIds: string[]; isActive: boolean };
const EMPTY_FORM: FormState = { title: '', body: '', shortCode: '', topicIds: [], isActive: true };
const VARIABLES = ['$contact.name', '$contact.firstname', '$contact.lastname', '$contact.email', '$contact.phone', '$contact.country', '$contact.id', '$system.current_date', '$system.current_time', '$system.current_datetime'];

function readableBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toForm(snippet?: Template | null): FormState {
  return snippet ? { title: snippet.title, body: snippet.body, shortCode: snippet.shortCode || '', topicIds: snippet.topics?.map((topic) => topic.id) || [], isActive: snippet.isActive } : EMPTY_FORM;
}

export function WorkspaceSnippets() {
  const { t } = useT();
  const [snippets, setSnippets] = useState<Template[]>([]);
  const [topics, setTopics] = useState<SnippetTopic[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [topicFilter, setTopicFilter] = useState('all');
  const [selected, setSelected] = useState<Template | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null);
  const [topicDialogOpen, setTopicDialogOpen] = useState(false);
  const [newTopic, setNewTopic] = useState('');
  const [topicBusy, setTopicBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [snippetRows, topicRows, roster] = await Promise.all([fetchSnippets(), fetchSnippetTopics(), fetchWorkspaceUsers()]);
      setSnippets(snippetRows); setTopics(topicRows); setCanManage(roster.capabilities.canInvite);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return snippets.filter((snippet) => {
      const topicMatch = topicFilter === 'all' || (topicFilter === '__none__' ? !snippet.topics?.length : snippet.topics?.some((topic) => topic.id === topicFilter));
      return topicMatch && (!needle || [snippet.id, snippet.title, snippet.body, snippet.shortCode || ''].some((value) => value.toLocaleLowerCase().includes(needle)));
    });
  }, [query, snippets, topicFilter]);

  const openEditor = (snippet?: Template) => {
    setSelected(snippet || null); setForm(toForm(snippet)); setQueuedFiles([]); setEditorOpen(true);
  };
  const insertVariable = (variable: string) => {
    const field = textareaRef.current;
    const start = field?.selectionStart ?? form.body.length;
    const end = field?.selectionEnd ?? start;
    setForm((value) => ({ ...value, body: value.body.slice(0, start) + variable + value.body.slice(end) }));
    requestAnimationFrame(() => { field?.focus(); field?.setSelectionRange(start + variable.length, start + variable.length); });
  };
  const queueFiles = (list: FileList | null) => {
    if (!list) return;
    setQueuedFiles((current) => {
      const names = new Set([...(selected?.attachments || []).map((file) => file.fileName.toLocaleLowerCase()), ...current.map((file) => file.name.toLocaleLowerCase())]);
      const next = [...current];
      for (const file of Array.from(list)) {
        if (next.length + (selected?.attachments?.length || 0) >= 5) break;
        if (!names.has(file.name.toLocaleLowerCase())) { names.add(file.name.toLocaleLowerCase()); next.push(file); }
      }
      return next;
    });
  };
  const persist = async () => {
    if (!form.title.trim() || !form.body.trim()) return;
    setSaving(true);
    try {
      let saved = await saveSnippet({ id: selected?.id, ...form, shortCode: form.shortCode || null });
      for (const file of queuedFiles) {
        const attachment = await uploadSnippetAttachment(saved.id, file);
        saved = { ...saved, attachments: [...(saved.attachments || []), attachment] };
      }
      toast.success(selected ? t('Snippet updated') : t('Snippet created'));
      setEditorOpen(false); await load(false);
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not save Snippet')); } finally { setSaving(false); }
  };
  const toggleActive = async (snippet: Template) => {
    try {
      await saveSnippet({ id: snippet.id, title: snippet.title, body: snippet.body, shortCode: snippet.shortCode, topicIds: snippet.topics?.map((topic) => topic.id) || [], isActive: !snippet.isActive });
      await load(false);
    } catch { toast.error(t('Could not update Snippet')); }
  };
  const removeSnippet = async () => {
    if (!deleteTarget) return;
    setSaving(true);
    try { await deleteSnippet(deleteTarget.id); setDeleteTarget(null); toast.success(t('Snippet deleted')); await load(false); }
    catch { toast.error(t('Could not delete Snippet')); } finally { setSaving(false); }
  };
  const removeAttachment = async (attachment: SnippetAttachment) => {
    if (!selected) return;
    try {
      await deleteSnippetAttachment(selected.id, attachment.id);
      setSelected((snippet) => snippet && ({ ...snippet, attachments: snippet.attachments?.filter((file) => file.id !== attachment.id) }));
      toast.success(t('File removed'));
    } catch { toast.error(t('Could not remove file')); }
  };
  const addTopic = async () => {
    if (!newTopic.trim()) return;
    setTopicBusy(true);
    try { const topic = await createSnippetTopic(newTopic); setTopics((rows) => [...rows, topic].sort((a, b) => a.name.localeCompare(b.name))); setNewTopic(''); }
    catch (error: any) { toast.error(error?.response?.data?.error || t('Could not create topic')); } finally { setTopicBusy(false); }
  };
  const removeTopic = async (topic: SnippetTopic) => {
    setTopicBusy(true);
    try {
      await deleteSnippetTopic(topic.id); setTopics((rows) => rows.filter((row) => row.id !== topic.id));
      setSnippets((rows) => rows.map((snippet) => ({ ...snippet, topics: snippet.topics?.filter((row) => row.id !== topic.id) })));
    } catch { toast.error(t('Could not delete topic')); } finally { setTopicBusy(false); }
  };

  if (loading) return <LayoutSkeleton label={t('Loading Snippets')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load Snippets')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return <div className="flex min-h-0 flex-1 flex-col bg-background">
    <SettingsHeader
      title={t('Snippets')}
      description={t('Shared replies for consistent customer conversations.')}
      action={<><div className="flex items-center gap-3"><span className="text-caption text-muted-foreground"><bdi dir="ltr">{snippets.length} / 5000</bdi></span>{canManage ? <Button onClick={() => openEditor()}><Plus className="size-4" />{t('Add Snippet')}</Button> : <span className="flex items-center gap-2 text-caption text-muted-foreground"><ShieldCheck className="size-4" />{t('Only workspace owners and managers can change Snippets.')}</span>}</div></>}
    />
    <ListToolbar searchValue={query} onSearchChange={setQuery} searchLabel={t('Search name, message, shortcut, or ID')} clearSearchLabel={t('Clear search')} filters={<>
      <Select value={topicFilter} onValueChange={setTopicFilter}><SelectTrigger className="w-44" aria-label={t('Filter by topic')}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">{t('All topics')}</SelectItem><SelectItem value="__none__">{t('Without a topic')}</SelectItem>{topics.map((topic) => <SelectItem key={topic.id} value={topic.id}>{topic.name}</SelectItem>)}</SelectContent></Select>
      {canManage && <Button variant="outline" size="sm" onClick={() => setTopicDialogOpen(true)}><Tags className="size-4" />{t('Manage topics')}</Button>}
    </>} />
    <div className="min-h-0 flex-1 overflow-auto">
      {!snippets.length ? <EmptyState icon={FileText} title={t('No Snippets yet')} description={canManage ? t('Create the first shared reply for this workspace.') : t('Workspace owners and managers can create shared replies.')} action={canManage ? <Button onClick={() => openEditor()}><Plus className="size-4" />{t('Add Snippet')}</Button> : undefined} /> : !shown.length ? <NoResultsState title={t('No Snippets match these filters')} clearLabel={t('Clear filters')} onClear={() => { setQuery(''); setTopicFilter('all'); }} /> : <div className="divide-y divide-border border-b border-border">
        {shown.map((snippet) => <article key={snippet.id} className={cn('grid min-h-24 gap-3 bg-card px-4 py-3 sm:grid-cols-[minmax(190px,0.9fr)_minmax(260px,1.7fr)_minmax(150px,0.8fr)_80px_40px] sm:items-center sm:px-6', !snippet.isActive && 'opacity-60')}>
          <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate text-small font-semibold">{snippet.title}</h2>{!snippet.isActive && <Badge variant="secondary">{t('Inactive')}</Badge>}</div><div className="mt-1 flex items-center gap-1 text-micro text-muted-foreground"><Hash className="size-3" /><bdi dir="ltr">/{snippet.shortCode || snippet.title}</bdi></div><div className="mt-1 truncate font-mono text-micro text-muted-foreground" dir="ltr">{snippet.id}</div></div>
          <p dir="auto" className="line-clamp-3 whitespace-pre-wrap text-caption text-muted-foreground">{snippet.body}</p>
          <div className="flex flex-wrap gap-1">{snippet.topics?.length ? snippet.topics.map((topic) => <Badge key={topic.id} variant="outline">{topic.name}</Badge>) : <span className="text-caption text-muted-foreground">{t('No topic')}</span>}</div>
          <span className="flex items-center gap-1 text-caption text-muted-foreground"><Paperclip className="size-3.5" />{snippet.attachments?.length || 0}</span>
          {canManage ? <RowOverflowMenu label={t('Snippet actions')} actions={[{ label: t('Edit Snippet'), icon: Pencil, onSelect: () => openEditor(snippet) }, { label: snippet.isActive ? t('Disable Snippet') : t('Enable Snippet'), icon: Check, onSelect: () => void toggleActive(snippet) }, { label: t('Delete Snippet'), icon: Trash2, destructive: true, onSelect: () => setDeleteTarget(snippet) }]} /> : <span />}
        </article>)}
      </div>}
    </div>

    <Drawer open={editorOpen} onOpenChange={setEditorOpen}><DrawerContent closeLabel={t('Close')} className="sm:max-w-xl"><DrawerHeader><DrawerTitle className="text-base font-semibold">{selected ? t('Edit Snippet') : t('Add Snippet')}</DrawerTitle><DrawerDescription>{t('Snippets are shared with every workspace user.')}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-5">
      <div className="space-y-1.5"><Label htmlFor="snippet-name">{t('Name')}</Label><Input id="snippet-name" value={form.title} maxLength={80} onChange={(event) => setForm((value) => ({ ...value, title: event.target.value }))} /></div>
      <div className="space-y-1.5"><Label htmlFor="snippet-shortcut">{t('Shortcut')}</Label><div className="relative"><span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground">/</span><Input id="snippet-shortcut" dir="ltr" className="ps-7" value={form.shortCode} maxLength={80} onChange={(event) => setForm((value) => ({ ...value, shortCode: event.target.value.replace(/^\/+|\s/g, '') }))} /></div></div>
      <div className="space-y-1.5"><Label htmlFor="snippet-message">{t('Message')}</Label><Textarea ref={textareaRef} id="snippet-message" rows={8} maxLength={3000} dir="auto" value={form.body} onChange={(event) => setForm((value) => ({ ...value, body: event.target.value }))} /><div className="flex flex-wrap gap-1" aria-label={t('Dynamic variables')}>{VARIABLES.map((variable) => <Button key={variable} type="button" variant="outline" size="sm" className="h-7 font-mono text-micro" dir="ltr" onClick={() => insertVariable(variable)}>{variable}</Button>)}</div><p className="text-micro text-muted-foreground">{t('Custom fields use $contact.field_name.')}</p></div>
      <fieldset className="space-y-2"><legend className="text-small font-medium">{t('Topics')} <span className="text-muted-foreground">({form.topicIds.length}/10)</span></legend><div className="grid gap-2 sm:grid-cols-2">{topics.map((topic) => <label key={topic.id} className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-caption hover:bg-accent"><input type="checkbox" className="size-4 accent-primary" checked={form.topicIds.includes(topic.id)} disabled={!form.topicIds.includes(topic.id) && form.topicIds.length >= 10} onChange={() => setForm((value) => ({ ...value, topicIds: value.topicIds.includes(topic.id) ? value.topicIds.filter((id) => id !== topic.id) : [...value.topicIds, topic.id] }))} />{topic.name}</label>)}</div>{!topics.length && <p className="text-caption text-muted-foreground">{t('No topics configured.')}</p>}</fieldset>
      <section className="space-y-2" aria-labelledby="snippet-files"><div className="flex items-center justify-between gap-2"><h2 id="snippet-files" className="text-small font-medium">{t('Files')} <span className="text-muted-foreground">({(selected?.attachments?.length || 0) + queuedFiles.length}/5)</span></h2><><input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { queueFiles(event.target.files); event.target.value = ''; }} /><Button type="button" variant="outline" size="sm" disabled={(selected?.attachments?.length || 0) + queuedFiles.length >= 5} onClick={() => fileRef.current?.click()}><Paperclip className="size-4" />{t('Add file')}</Button></></div><div className="divide-y divide-border border-y border-border">
        {selected?.attachments?.map((attachment) => <div key={attachment.id} className="flex items-center gap-2 py-2"><File className="size-4 text-muted-foreground" /><a href={attachment.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-caption font-medium hover:underline">{attachment.fileName}</a><span className="text-micro text-muted-foreground">{readableBytes(attachment.sizeBytes)}</span><Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('Remove file')} onClick={() => void removeAttachment(attachment)}><X className="size-4" /></Button></div>)}
        {queuedFiles.map((file) => <div key={file.name} className="flex items-center gap-2 py-2"><File className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-caption font-medium">{file.name}</span><span className="text-micro text-muted-foreground">{readableBytes(file.size)}</span><Button type="button" variant="ghost" size="icon" className="size-8" aria-label={t('Remove queued file')} onClick={() => setQueuedFiles((rows) => rows.filter((row) => row !== file))}><X className="size-4" /></Button></div>)}
        {!selected?.attachments?.length && !queuedFiles.length && <p className="py-4 text-center text-caption text-muted-foreground">{t('No files attached')}</p>}
      </div></section>
      <label className="flex items-center gap-3 border-t border-border pt-4"><input type="checkbox" className="size-4 accent-primary" checked={form.isActive} onChange={(event) => setForm((value) => ({ ...value, isActive: event.target.checked }))} /><span><span className="block text-small font-medium">{t('Active Snippet')}</span><span className="block text-caption text-muted-foreground">{t('Inactive Snippets stay saved but do not appear in the Inbox composer.')}</span></span></label>
    </DrawerBody><DrawerFooter><Button variant="outline" onClick={() => setEditorOpen(false)}>{t('Cancel')}</Button><Button disabled={saving || !form.title.trim() || !form.body.trim()} onClick={() => void persist()}>{saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}{t('Save')}</Button></DrawerFooter></DrawerContent></Drawer>

    <Dialog open={topicDialogOpen} onOpenChange={setTopicDialogOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t('Manage Snippet topics')}</DialogTitle></DialogHeader><div className="space-y-4"><div className="flex gap-2"><Input value={newTopic} maxLength={50} placeholder={t('Topic name')} aria-label={t('Topic name')} onChange={(event) => setNewTopic(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addTopic(); } }} /><Button onClick={() => void addTopic()} disabled={topicBusy || !newTopic.trim()}><Plus className="size-4" />{t('Add')}</Button></div><div className="max-h-72 divide-y divide-border overflow-y-auto border-y border-border">{topics.map((topic) => <div key={topic.id} className="flex items-center gap-3 py-2"><Tags className="size-4 text-muted-foreground" /><span className="min-w-0 flex-1 truncate text-small">{topic.name}</span><span className="text-caption text-muted-foreground">{topic.snippetCount || 0}</span><Button variant="ghost" size="icon" className="size-8" aria-label={`${t('Delete topic')} ${topic.name}`} disabled={topicBusy} onClick={() => void removeTopic(topic)}><Trash2 className="size-4" /></Button></div>)}{!topics.length && <p className="py-6 text-center text-caption text-muted-foreground">{t('No topics configured.')}</p>}</div></div><DialogFooter><Button variant="outline" onClick={() => setTopicDialogOpen(false)}>{t('Done')}</Button></DialogFooter></DialogContent></Dialog>
    <ConfirmDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }} title={t('Delete Snippet')} description={t('This removes the shared reply and its files for every workspace user. This cannot be undone.')} cancelLabel={t('Cancel')} confirmLabel={t('Delete Snippet')} onConfirm={removeSnippet} busy={saving} />
  </div>;
}
