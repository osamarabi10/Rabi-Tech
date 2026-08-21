'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Tag, UserRound, Columns3, Loader2, Merge, Save } from 'lucide-react';
import { activeRules } from '@/lib/contact-filter';
import { avatarColor } from '@/lib/constants';
import {
  bulkUpdateContacts,
  fetchContactsPage,
  fetchCrmTags,
  fetchCustomFieldDefinitions,
  fetchSystemUsers,
  mergeContacts,
  saveCrmTag,
  updateContact,
  type Contact,
  type ContactFilterDsl,
  type CrmTag,
  type CustomFieldDefinition,
  type SystemUser,
} from '@/lib/data';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { useT } from '@/lib/i18n';

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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selected, setSelected] = useState<Contact | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tags, setTags] = useState<CrmTag[]>([]);
  const [users, setUsers] = useState<SystemUser[]>([]);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ContactFilterDsl>({ $and: [] });
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [nextCursorId, setNextCursorId] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
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
  const [saving, setSaving] = useState(false);

  const activeFilter = useMemo<ContactFilterDsl>(
    () => ({ $and: activeRules(filter.$and) }),
    [filter],
  );

  const load = useCallback(async (cursor: string | null = null) => {
    setLoading(true);
    try {
      const page = await fetchContactsPage({
        search,
        filter: activeFilter.$and?.length ? activeFilter : undefined,
        cursorId: cursor,
        limit: 25,
      });
      setContacts(page.items);
      setSelectedIds([]);
      setCursorId(cursor);
      setNextCursorId(page.pagination.cursorId);
      setHasMore(page.pagination.hasMore);
    } finally {
      setLoading(false);
    }
  }, [activeFilter, search]);

  useEffect(() => {
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

  const mergeSelected = async () => {
    if (!selected || !mergeTargetId.trim()) return;
    setSaving(true);
    try {
      const merged = await mergeContacts(selected.id, mergeTargetId.trim());
      setSelected(merged);
      await load(null);
      setMergeTargetId('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-extrabold">{t('Ø¬Ù‡Ø§Øª Ø§Ù„Ø§ØªØµØ§Ù„')}</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Columns3 className="h-4 w-4" />
              Columns
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

      <Card className="mb-4">
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-3 lg:grid-cols-[1fr_180px]">
            <div className="relative">
              <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="ps-9"
                placeholder={t('بحث في جهات الاتصال')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </div>
          <ContactFilterBuilder value={filter} onChange={setFilter} />
        </CardContent>
      </Card>

      {selectedIds.length > 0 && (
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
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
              Apply to {selectedIds.length}
            </Button>
          </CardContent>
        </Card>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={8} className="h-24 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></TableCell></TableRow>
              )}
              {!loading && contacts.map((contact) => (
                <TableRow key={contact.id} className="cursor-pointer" onClick={() => setSelected(contact)}>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.includes(contact.id)} onChange={() => toggleSelected(contact.id)} />
                  </TableCell>
                  {visibleColumns.name && (
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="text-xs" style={{ backgroundColor: `${avatarColor(contact.phone)}22`, color: avatarColor(contact.phone) }}>
                            {(contact.name || '?').charAt(0)}
                          </AvatarFallback>
                        </Avatar>
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
                        {contact.tags.map((tagName) => <Badge key={tagName} variant="secondary" className="text-[10px]">{tagName}</Badge>)}
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {!loading && contacts.length === 0 && (
                <TableRow><TableCell colSpan={8} className="h-24 text-center text-sm text-muted-foreground">{t('لا توجد جهات اتصال')}</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between border-t border-border p-3">
            <Button variant="outline" size="sm" disabled={!cursorId || loading} onClick={() => load(null)}>First</Button>
            <Button variant="outline" size="sm" disabled={!hasMore || !nextCursorId || loading} onClick={() => load(nextCursorId)}>Next</Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-sm">{t('تفاصيل جهة الاتصال')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="grid max-h-[70vh] gap-3 overflow-y-auto md:grid-cols-2">
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
              <div className="space-y-2 md:col-span-2">
                <Label>Merge secondary contact ID into this contact</Label>
                <div className="flex gap-2">
                  <Input value={mergeTargetId} onChange={(e) => setMergeTargetId(e.target.value)} placeholder="secondary contact id" />
                  <Button variant="outline" onClick={mergeSelected} disabled={saving || !mergeTargetId.trim()}>
                    <Merge className="h-4 w-4" />
                    Merge
                  </Button>
                </div>
              </div>
              <div className="md:col-span-2">
                <Button onClick={saveSelected} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
