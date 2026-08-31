'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { Tag, UserRound, Columns3, Edit3, Loader2, Merge, Save, BookmarkPlus, Upload, Users, Download } from 'lucide-react';
import { activeFilter } from '@/lib/contact-filter';
import { ContactAvatar } from '@/components/contact-avatar';
import {
  bulkUpdateContacts,
  fetchContact,
  fetchContactMergeSuggestions,
  fetchContactsPage,
  fetchCrmTags,
  fetchCustomFieldDefinitions,
  fetchCurrentProfile,
  fetchSystemUsers,
  exportContacts,
  mergeContacts,
  saveCrmTag,
  updateContact,
  type Contact,
  type ContactMergeSuggestion,
  type ContactFilterDsl,
  type CrmTag,
  type CustomFieldDefinition,
  type SystemUser,
  fetchSegments,
  type Segment,
} from '@/lib/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ContactFilterBuilder } from '@/components/contacts/contact-filter-builder';
import { SegmentChips } from '@/components/contacts/segment-chips';
import { SaveGroupDialog } from '@/components/contacts/save-group-dialog';
import { SaveSegmentDialog } from '@/components/contacts/save-segment-dialog';
import { MergeSuggestions } from '@/components/contacts/merge-suggestions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useT } from '@/lib/i18n';
import { BulkActionBar, ListToolbar, Pager, RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, NoResultsState, SkeletonBlock } from '@/components/ui/operational-state';

const COLUMNS = [
  { id: 'name', label: 'الاسم' },
  { id: 'phone', label: 'الهاتف' },
  { id: 'email', label: 'البريد الإلكتروني' },
  { id: 'stage', label: 'المرحلة' },
  { id: 'assignee', label: 'المسؤول' },
  { id: 'tags', label: 'الوسوم' },
] as const;

type ColumnId = (typeof COLUMNS)[number]['id'];

export default function ContactsPage() {
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ContactFilterDsl>({ $and: [] });
  const [segments, setSegments] = useState<Segment[]>([]);
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null);
  const [saveSegmentOpen, setSaveSegmentOpen] = useState(false);
  const [saveGroupOpen, setSaveGroupOpen] = useState(false);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [nextCursorId, setNextCursorId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [visibleColumns, setVisibleColumns] = useState<Record<ColumnId, boolean>>({
    name: true,
    phone: true,
    email: true,
    stage: true,
    assignee: true,
    tags: true,
  });
  const [bulkTag, setBulkTag] = useState('');
  const [bulkAssigneeId, setBulkAssigneeId] = useState('__none__');
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [mergeConfirmOpen, setMergeConfirmOpen] = useState(false);
  const [permissions, setPermissions] = useState<string[] | null>(null);
  const [mergeSuggestions, setMergeSuggestions] = useState<ContactMergeSuggestion[]>([]);
  const [mergeSuggestionsLoading, setMergeSuggestionsLoading] = useState(false);
  const [mergeSuggestionsError, setMergeSuggestionsError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);

  // Unfinished rules are stripped before every request, so a half-typed filter
  // never widens the list behind the user's back.
  const appliedFilter = useMemo(() => activeFilter(filter), [filter]);
  const canMerge = permissions?.includes('contact:update') === true;
  const canExport = permissions?.includes('contact:export') === true;

  const loadMergeSuggestions = useCallback(async () => {
    setMergeSuggestionsLoading(true);
    setMergeSuggestionsError(false);
    try {
      setMergeSuggestions(await fetchContactMergeSuggestions());
    } catch {
      setMergeSuggestionsError(true);
    } finally {
      setMergeSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentProfile()
      .then((profile) => setPermissions(profile.permissions || []))
      .catch(() => setPermissions([]));
  }, []);

  useEffect(() => {
    if (canMerge) void loadMergeSuggestions();
  }, [canMerge, loadMergeSuggestions]);

  const loadSegments = useCallback(() => {
    fetchSegments().then(setSegments).catch(() => setSegments([]));
  }, []);
  useEffect(() => { loadSegments(); }, [loadSegments]);

  /** Load a saved filter into the builder, or clear back to all contacts. */
  const applySegment = useCallback((segment: Segment | null) => {
    setActiveSegmentId(segment?.id ?? null);
    setFilter(segment ? segment.filter : { $and: [] });
  }, []);

  const load = useCallback(async (cursor: string | null = null) => {
    setLoading(true);
    setLoadError(false);
    try {
      const page = await fetchContactsPage({
        search,
        filter: appliedFilter || undefined,
        cursorId: cursor,
        limit: 25,
      });
      setContacts(page.items);
      setSelectedIds([]);
      setCursorId(cursor);
      setNextCursorId(page.pagination.cursorId);
      setHasMore(page.pagination.hasMore);
      // During a rolling deployment the frontend can briefly run against the
      // previous cursor response, which did not include `total`. Keep the
      // range useful until the backend instance catches up.
      setTotal(Number.isFinite(page.pagination.total) ? page.pagination.total : page.items.length);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [appliedFilter, search]);

  const setContactRoute = useCallback((contactId: string | null) => {
    const next = new URLSearchParams(searchParams.toString());
    if (contactId) next.set('contact', contactId);
    else next.delete('contact');
    const query = next.toString();
    router.replace(query ? `/contacts?${query}` : '/contacts', { scroll: false });
  }, [router, searchParams]);

  const openContact = useCallback((contact: Contact) => {
    setSelected(contact);
    setContactRoute(contact.id);
  }, [setContactRoute]);

  const closeContact = useCallback(() => {
    setSelected(null);
    setContactRoute(null);
  }, [setContactRoute]);

  useEffect(() => {
    const ref = searchParams.get('contact');
    if (!ref) {
      setSelected(null);
      return;
    }
    if (selected?.id === ref) return;
    const loaded = contacts.find((contact) => contact.id === ref);
    if (loaded) {
      setSelected(loaded);
      return;
    }
    fetchContact(ref).then(setSelected).catch(() => setContactRoute(null));
  }, [contacts, searchParams, selected?.id, setContactRoute]);

  useEffect(() => {
    setCursorHistory([]);
    const timer = setTimeout(() => load(null), 250);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    Promise.all([
      fetchCrmTags().then(setTags),
      fetchSystemUsers().then(setUsers),
      fetchCustomFieldDefinitions().then(setCustomFields),
    ]).catch(() => undefined);
  }, []);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  };

  const applyBulk = async () => {
    if (!selectedIds.length) return;
    setSaving(true);
    try {
      if (bulkTag.trim()) await saveCrmTag({ name: bulkTag.trim() });
      await bulkUpdateContacts({
        contactIds: selectedIds,
        tagName: bulkTag.trim() || undefined,
        assigneeId: bulkAssigneeId === '__none__' ? undefined : bulkAssigneeId || null,
      });
      setBulkTag('');
      await fetchCrmTags().then(setTags);
      await load(cursorId);
    } finally {
      setSaving(false);
    }
  };

  const saveSelected = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const saved = await updateContact(selected.id, selected);
      setSelected(saved);
      setContacts((current) => current.map((contact) => (contact.id === saved.id ? saved : contact)));
    } finally {
      setSaving(false);
    }
  };

  const requestMerge = () => {
    if (!selected || !mergeTargetId.trim()) return;
    setMergeConfirmOpen(true);
  };

  const mergeSelected = async () => {
    if (!selected || !mergeTargetId.trim()) return;
    setSaving(true);
    try {
      const merged = await mergeContacts(selected.id, mergeTargetId.trim());
      setSelected(merged);
      await load(null);
      await loadMergeSuggestions();
      setMergeTargetId('');
      setMergeConfirmOpen(false);
    } catch {
      toast.error(t('تعذّر دمج جهات الاتصال'));
    } finally {
      setSaving(false);
    }
  };

  const reviewMergeSuggestion = async (suggestion: ContactMergeSuggestion) => {
    try {
      const primary = contacts.find((contact) => contact.id === suggestion.primary.id)
        || await fetchContact(suggestion.primary.id);
      setMergeTargetId(suggestion.secondary.id);
      openContact(primary);
    } catch {
      toast.error(t('تعذّر فتح اقتراح الدمج'));
    }
  };

  const downloadExport = async () => {
    setExporting(true);
    try {
      const blob = await exportContacts({ search, filter: appliedFilter || undefined });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'contacts.csv';
      link.click();
      URL.revokeObjectURL(url);
      toast.success(t('تم تصدير جهات الاتصال'));
    } catch {
      toast.error(t('تعذّر تصدير جهات الاتصال'));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-extrabold">{t('جهات الاتصال')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {canExport && (
            <Button type="button" variant="outline" size="sm" onClick={() => void downloadExport()} disabled={exporting}>
              {exporting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
              {t('تصدير جهات الاتصال')}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 className="h-4 w-4" aria-hidden />
                {t('الأعمدة')}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {COLUMNS.map((column) => (
                <DropdownMenuItem key={column.id} onSelect={(event) => event.preventDefault()}>
                  <label className="flex w-full items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={visibleColumns[column.id]}
                      onChange={(event) => setVisibleColumns((current) => ({ ...current, [column.id]: event.target.checked }))}
                    />
                    {t(column.label)}
                  </label>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {canMerge && (
        <MergeSuggestions
          suggestions={mergeSuggestions}
          loading={mergeSuggestionsLoading}
          error={mergeSuggestionsError}
          onRetry={() => void loadMergeSuggestions()}
          onReview={(suggestion) => void reviewMergeSuggestion(suggestion)}
        />
      )}

      <Card className="mb-4">
        <CardContent className="space-y-4 p-4">
          <ListToolbar
            className="-mx-4 -mt-4"
            searchValue={search}
            onSearchChange={setSearch}
            searchLabel={t('بحث في جهات الاتصال')}
            clearSearchLabel={t('مسح التصفية')}
          />
          <ContactFilterBuilder
            value={filter}
            onChange={(next) => {
              setFilter(next);
              // Editing a loaded segment means the view is no longer that
              // segment; keeping the chip highlighted would be a lie.
              setActiveSegmentId(null);
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentChips
              segments={segments}
              activeId={activeSegmentId}
              onSelect={applySegment}
              onChanged={loadSegments}
            />
            <Button size="sm" variant="outline" asChild>
              <Link href="/contacts/import">
                <Upload className="h-3.5 w-3.5" />
                {t('استيراد')}
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              // activeFilter() returns null when nothing is filled in. Saving
              // "everyone" under a name is what the server rejects, so the
              // button says so before the round trip.
              disabled={!appliedFilter}
              onClick={() => setSaveSegmentOpen(true)}
            >
              <BookmarkPlus className="h-3.5 w-3.5" />
              {t('حفظ كشريحة')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <BulkActionBar
          className="mb-4 rounded-md border border-primary/20"
          countLabel={`${selectedIds.length} ${t('جهة اتصال')}`}
          actions={<>
            <div className="space-y-1">
              <Label>{t('وسم جماعي')}</Label>
              <Input value={bulkTag} onChange={(event) => setBulkTag(event.target.value)} placeholder="priority-customer" />
            </div>
            <div className="w-56 space-y-1">
              <Label>{t('تعيين')}</Label>
              <Select value={bulkAssigneeId} onValueChange={setBulkAssigneeId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No change</SelectItem>
                  {users.map((user) => <SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={applyBulk} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Tag className="h-4 w-4" />}
              {t('طبّق على')} {selectedIds.length}
            </Button>

            {/*
              Saving a *selection* as a group. "Save as segment" above saves a
              filter and is disabled until there is one, which covers
              "everyone in Nablus who bought last month" and not "these eleven
              are our VIPs" — the more common ask, and the one that cannot be
              written as a rule.
            */}
            <Button variant="outline" onClick={() => setSaveGroupOpen(true)} disabled={saving}>
              <Users className="h-4 w-4" />
              {t('حفظ كمجموعة')}
            </Button>
          </>}
        />
      )}

      <Card>
        <CardHeader className="border-b border-border py-3 text-xs text-muted-foreground">
          {loading ? t('جاري التحميل...') : `${contacts.length} ${t('جهة اتصال')}`}
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                {visibleColumns.name && <TableHead>{t('الاسم')}</TableHead>}
                {visibleColumns.phone && <TableHead>{t('الهاتف')}</TableHead>}
                {visibleColumns.email && <TableHead>{t('البريد الإلكتروني')}</TableHead>}
                {visibleColumns.stage && <TableHead>{t('المرحلة')}</TableHead>}
                {visibleColumns.assignee && <TableHead>{t('المسؤول')}</TableHead>}
                {visibleColumns.tags && <TableHead>{t('الوسوم')}</TableHead>}
                <TableHead className="w-10"><span className="sr-only">{t('الإجراءات')}</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={`skeleton-${index}`} aria-hidden>
                  <TableCell colSpan={8}><SkeletonBlock className="h-8 w-full" /></TableCell>
                </TableRow>
              ))}
              {!loading && loadError && (
                <TableRow><TableCell colSpan={8}><ErrorState compact title={t('تعذر تحميل جهات الاتصال')} description={t('جرّب تحديث الصفحة، وإذا استمرت المشكلة تواصل مع الدعم')} retryLabel={t('إعادة المحاولة')} onRetry={() => load(cursorId)} /></TableCell></TableRow>
              )}
              {!loading && !loadError && contacts.map((contact) => (
                <TableRow key={contact.id} className="cursor-pointer" onClick={() => openContact(contact)}>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.includes(contact.id)} onChange={() => toggleSelected(contact.id)} />
                  </TableCell>
                  {visibleColumns.name && (
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ContactAvatar phone={contact.phone} label={contact.name} />
                        <span className="font-medium">{contact.name}</span>
                      </div>
                    </TableCell>
                  )}
                  {visibleColumns.phone && <TableCell className="numeric" dir="ltr">{contact.phone}</TableCell>}
                  {visibleColumns.email && <TableCell>{contact.email || '—'}</TableCell>}
                  {visibleColumns.stage && <TableCell>{contact.lifecycleStage || '—'}</TableCell>}
                  {visibleColumns.assignee && <TableCell>{contact.assigneeName || '—'}</TableCell>}
                  {visibleColumns.tags && (
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {contact.tags.map((tagName) => <Badge key={tagName} variant="secondary" className="text-micro">{tagName}</Badge>)}
                      </div>
                    </TableCell>
                  )}
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <RowOverflowMenu
                      label={`${t('الإجراءات')}: ${contact.name}`}
                      actions={[{ label: t('تعديل'), icon: Edit3, onSelect: () => openContact(contact) }]}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {!loading && !loadError && contacts.length === 0 && (
                <TableRow><TableCell colSpan={8}>
                  {search || appliedFilter ? (
                    <NoResultsState compact title={t('لا توجد نتائج مطابقة')} description={t('جرّب توسيع التصفية أو البحث')} clearLabel={t('مسح التصفية')} onClear={() => { setSearch(''); setFilter({ $and: [] }); setActiveSegmentId(null); }} />
                  ) : (
                    <EmptyState compact icon={UserRound} title={t('لا توجد جهات اتصال')} />
                  )}
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <Pager
            entityLabel={t('جهة اتصال')}
            pageSize={25}
            pageSizeOptions={[25]}
            start={total === 0 ? 0 : cursorHistory.length * 25 + 1}
            end={Math.min(total, cursorHistory.length * 25 + contacts.length)}
            total={total}
            previousLabel={t('السابق')}
            nextLabel={t('التالي')}
            hasPrevious={cursorHistory.length > 0 && !loading}
            hasNext={hasMore && !!nextCursorId && !loading}
            onPageSizeChange={() => undefined}
            onPrevious={() => {
              const previous = cursorHistory[cursorHistory.length - 1] ?? null;
              setCursorHistory((current) => current.slice(0, -1));
              load(previous);
            }}
            onNext={() => {
              if (!nextCursorId) return;
              setCursorHistory((current) => [...current, cursorId]);
              load(nextCursorId);
            }}
          />
        </CardContent>
      </Card>

      <Drawer open={!!selected} onOpenChange={(open) => !open && closeContact()}>
        <DrawerContent className="max-w-2xl" closeLabel={t('إغلاق')}>
          <DrawerHeader>
            <DrawerTitle className="text-sm font-semibold">{t('تفاصيل جهة الاتصال')}</DrawerTitle>
          </DrawerHeader>
          {selected && (
            <DrawerBody>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2"><Label>Name</Label><Input value={selected.name || ''} onChange={(e) => setSelected({ ...selected, name: e.target.value })} /></div>
              <div className="space-y-2"><Label>Email</Label><Input value={selected.email || ''} onChange={(e) => setSelected({ ...selected, email: e.target.value })} /></div>
              <div className="space-y-2"><Label>First name</Label><Input value={selected.firstName || ''} onChange={(e) => setSelected({ ...selected, firstName: e.target.value })} /></div>
              <div className="space-y-2"><Label>Last name</Label><Input value={selected.lastName || ''} onChange={(e) => setSelected({ ...selected, lastName: e.target.value })} /></div>
              <div className="space-y-2"><Label>Language</Label><Input value={selected.language || ''} onChange={(e) => setSelected({ ...selected, language: e.target.value })} /></div>
              <div className="space-y-2"><Label>Country code</Label><Input value={selected.countryCode || ''} onChange={(e) => setSelected({ ...selected, countryCode: e.target.value })} /></div>
              <div className="space-y-2"><Label>Lifecycle stage</Label><Input value={selected.lifecycleStage || ''} onChange={(e) => setSelected({ ...selected, lifecycleStage: e.target.value })} /></div>
              <div className="space-y-2">
                <Label>Assignee</Label>
                <Select value={selected.assigneeId || '__unassigned__'} onValueChange={(value) => setSelected({ ...selected, assigneeId: value === '__unassigned__' ? null : value })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned__">Unassigned</SelectItem>
                    {users.map((user) => <SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 md:col-span-2"><Label>Profile picture URL</Label><Input dir="ltr" value={selected.profilePic || ''} onChange={(e) => setSelected({ ...selected, profilePic: e.target.value })} /></div>
              <div className="space-y-2 md:col-span-2"><Label>Notes</Label><Input value={selected.notes || ''} onChange={(e) => setSelected({ ...selected, notes: e.target.value })} /></div>
              <div className="space-y-2 md:col-span-2">
                <Label>Tags by name</Label>
                <div className="flex flex-wrap gap-1">{tags.map((tagRow) => <Badge key={tagRow.id} variant="secondary">{tagRow.emoji}{tagRow.name}</Badge>)}</div>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label>Custom fields</Label>
                <div className="grid gap-2 md:grid-cols-2">
                  {customFields.map((field) => (
                    <div key={field.id} className="rounded-md border border-border p-2 text-xs">
                      <p className="font-medium">{field.name}</p>
                      <p className="text-muted-foreground">{selected.customFields?.[field.slug] || '—'}</p>
                    </div>
                  ))}
                </div>
              </div>
              {canMerge && (
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="merge-secondary-contact">{t('جهة الاتصال الثانوية')}</Label>
                  <div className="flex gap-2">
                    <Input id="merge-secondary-contact" value={mergeTargetId} onChange={(e) => setMergeTargetId(e.target.value)} placeholder={t('معرّف جهة الاتصال الثانوية')} />
                    <Button type="button" variant="outline" onClick={requestMerge} disabled={saving || !mergeTargetId.trim()}>
                      <Merge className="size-4" aria-hidden />
                      {t('مراجعة الدمج')}
                    </Button>
                  </div>
                </div>
              )}
              <div className="md:col-span-2">
                <Button onClick={saveSelected} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
              </div>
            </div>
            </DrawerBody>
          )}
        </DrawerContent>
      </Drawer>

      <SaveGroupDialog
        open={saveGroupOpen}
        contactIds={selectedIds}
        onClose={() => setSaveGroupOpen(false)}
        onSaved={(segment, tagName) => {
          toast.success(`${t('تم إنشاء المجموعة')} ${segment.name}`);
          // Reload so the new tag shows on the rows it was just applied to,
          // and clear the selection: it has become the group.
          setSelectedIds([]);
          load();
        }}
      />

      <SaveSegmentDialog
        open={saveSegmentOpen}
        filter={appliedFilter}
        onClose={() => setSaveSegmentOpen(false)}
        onSaved={(segment) => {
          loadSegments();
          setActiveSegmentId(segment.id);
        }}
      />

      <ConfirmDialog
        open={mergeConfirmOpen}
        onOpenChange={setMergeConfirmOpen}
        title={t('تأكيد دمج جهات الاتصال')}
        description={t('سيتم نقل محادثات جهة الاتصال الثانوية ووسومها وحقولها إلى جهة الاتصال الأساسية ثم أرشفتها. لا يمكن التراجع عن هذا الإجراء.')}
        cancelLabel={t('إلغاء')}
        confirmLabel={t('دمج جهات الاتصال')}
        onConfirm={() => void mergeSelected()}
        busy={saving}
      />
    </div>
  );
}
