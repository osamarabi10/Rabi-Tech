'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Search, Tag, X } from 'lucide-react';
import { toast } from 'sonner';
import { assignContactTag, fetchContactTagAssignments, fetchCrmTags, removeContactTag, type ContactTagAssignment, type CrmTag } from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

function canTagContacts(): boolean {
  try { return ['ADMIN', 'SUPERVISOR', 'AGENT'].includes(JSON.parse(localStorage.getItem('rabitech_user') || '{}').role || ''); }
  catch { return false; }
}

export function ContactTagsSection({ contactId }: { contactId: string }) {
  const { t } = useT();
  const [assigned, setAssigned] = useState<ContactTagAssignment[]>([]);
  const [available, setAvailable] = useState<CrmTag[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    setAllowed(canTagContacts());
    let cancelled = false;
    Promise.all([fetchContactTagAssignments(contactId), fetchCrmTags()])
      .then(([nextAssigned, nextAvailable]) => { if (!cancelled) { setAssigned(nextAssigned); setAvailable(nextAvailable); } })
      .catch(() => { if (!cancelled) { setAssigned([]); setAvailable([]); } });
    return () => { cancelled = true; };
  }, [contactId]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return available.filter((tag) => !needle || tag.name.toLocaleLowerCase().includes(needle));
  }, [available, query]);
  const assignedIds = new Set(assigned.map((tag) => tag.id));
  const exactExists = available.some((tag) => tag.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase());

  const add = async (tag?: CrmTag) => {
    const marker = tag?.id || query.trim();
    if (!marker) return;
    setBusy(marker);
    try {
      const assignment = await assignContactTag(contactId, tag ? { tagId: tag.id } : { name: query.trim() });
      setAssigned((current) => current.some((row) => row.id === assignment.id) ? current : [...current, assignment]);
      if (!available.some((row) => row.id === assignment.id)) setAvailable((current) => [...current, assignment].sort((a, b) => a.name.localeCompare(b.name)));
      setQuery('');
    } catch (error: any) { toast.error(error?.response?.data?.error || t('Could not assign Tag')); }
    finally { setBusy(null); }
  };

  const remove = async (tag: ContactTagAssignment) => {
    setBusy(tag.id);
    try { await removeContactTag(contactId, tag.id); setAssigned((current) => current.filter((row) => row.id !== tag.id)); }
    catch (error: any) { toast.error(error?.response?.data?.error || t('Could not remove Tag')); }
    finally { setBusy(null); }
  };

  return <section className="border-b border-border p-4" aria-labelledby="contact-tags-heading">
    <div className="mb-2 flex items-center justify-between gap-2"><h2 id="contact-tags-heading" className="text-micro font-semibold uppercase tracking-wider text-muted-foreground">{t('Tags')}</h2>{allowed && <Button variant="ghost" size="icon" className="size-7" aria-label={t('Manage Contact Tags')} onClick={() => setOpen(true)}><Plus className="size-3.5" /></Button>}</div>
    <div className="flex flex-wrap gap-1.5">{assigned.map((tag) => <span key={tag.id} title={`${tag.description || tag.name} · ${t(`Tag source: ${tag.source}`)}${tag.assignedByName ? ` · ${tag.assignedByName}` : ''}`} className="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-0.5 text-micro text-muted-foreground"><span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tag.colorCode || '#64748b' }} />{tag.emoji && <span>{tag.emoji}</span>}<span className="max-w-40 truncate" dir="auto">{tag.name}</span>{allowed && <button type="button" className="rounded-full hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label={`${t('Remove Tag')} ${tag.name}`} disabled={busy === tag.id} onClick={() => void remove(tag)}>{busy === tag.id ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}</button>}</span>)}{!assigned.length && <p className="text-caption text-muted-foreground">{t('No Tags assigned')}</p>}</div>

    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{t('Manage Contact Tags')}</DialogTitle></DialogHeader><div className="space-y-3"><div className="relative"><Search className="absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} className="ps-9" placeholder={t('Search or create a Tag')} onChange={(event) => setQuery(event.target.value)} /></div><div className="max-h-72 divide-y divide-border overflow-y-auto border-y border-border">{shown.map((tag) => { const active = assignedIds.has(tag.id); return <button key={tag.id} type="button" disabled={busy === tag.id} onClick={() => active ? void remove(assigned.find((row) => row.id === tag.id)!) : void add(tag)} className="flex w-full items-center gap-3 px-1 py-2 text-start hover:bg-accent"><span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: tag.colorCode || '#64748b' }} /><span className="min-w-0 flex-1 truncate text-small" dir="auto">{tag.emoji ? `${tag.emoji} ` : ''}{tag.name}</span>{busy === tag.id ? <Loader2 className="size-4 animate-spin" /> : active ? <Check className="size-4 text-success" /> : <Plus className="size-4 text-muted-foreground" />}</button>; })}{query.trim() && !exactExists && <button type="button" disabled={!!busy} onClick={() => void add()} className="flex w-full items-center gap-3 px-1 py-3 text-start text-small font-medium text-primary hover:bg-accent"><Tag className="size-4" />{t('Create and assign Tag')} <span dir="auto">“{query.trim()}”</span></button>}{!shown.length && (!query.trim() || exactExists) && <p className="py-6 text-center text-caption text-muted-foreground">{t('No Tags match this search')}</p>}</div></div></DialogContent></Dialog>
  </section>;
}
