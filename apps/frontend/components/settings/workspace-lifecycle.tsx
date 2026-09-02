'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleX,
  GripVertical,
  Pencil,
  Plus,
  ShieldCheck,
  Star,
  Trash2,
  Trophy,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createLifecycleStage,
  deleteLifecycleStage,
  fetchLifecycleStages,
  fetchWorkspaceUsers,
  reorderLifecycleStages,
  updateLifecycleStage,
  type LifecycleStage,
  type WorkspaceUserCapabilities,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { SettingsHeader } from './settings-primitives';

type StageKind = 'ACTIVE' | 'LOST';
type StageForm = { name: string; description: string; color: string; emoji: string; kind: StageKind };

const EMPTY_CAPABILITIES: WorkspaceUserCapabilities = {
  canInvite: false,
  canManage: false,
  managerInviteRole: 'AGENT',
  maskPhoneAndEmail: false,
  callsAvailable: false,
};
const COLORS = ['#2563EB', '#059669', '#D97706', '#DC2626', '#0891B2', '#7C3AED'];
const EMPTY_FORM: StageForm = { name: '', description: '', color: COLORS[0], emoji: '', kind: 'ACTIVE' };

export function WorkspaceLifecycle() {
  const { t } = useT();
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<LifecycleStage | null>(null);
  const [form, setForm] = useState<StageForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [busyStageId, setBusyStageId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [wonTarget, setWonTarget] = useState<LifecycleStage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LifecycleStage | null>(null);
  const [replacementId, setReplacementId] = useState('__clear__');

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [rows, roster] = await Promise.all([fetchLifecycleStages(), fetchWorkspaceUsers()]);
      setStages(rows);
      setCapabilities(roster.capabilities);
    } catch {
      setFailed(true);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = useMemo(() => stages.filter((stage) => stage.kind === 'ACTIVE').sort(byOrder), [stages]);
  const lost = useMemo(() => stages.filter((stage) => stage.kind === 'LOST').sort(byOrder), [stages]);

  const openCreate = (kind: StageKind) => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, kind, color: kind === 'LOST' ? '#DC2626' : COLORS[0] });
    setFormOpen(true);
  };

  const openEdit = (stage: LifecycleStage) => {
    setEditing(stage);
    setForm({
      name: stage.name,
      description: stage.description || '',
      color: stage.color || COLORS[0],
      emoji: stage.emoji || '',
      kind: stage.kind,
    });
    setFormOpen(true);
  };

  const saveStage = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      if (editing) {
        await updateLifecycleStage(editing.id, {
          name: form.name.trim(),
          description: form.description.trim() || null,
          color: form.color,
          emoji: form.kind === 'LOST' ? form.emoji.trim() || null : null,
          kind: form.kind,
        });
        toast.success(t('Lifecycle stage saved'));
      } else {
        await createLifecycleStage({
          name: form.name.trim(),
          description: form.description.trim() || null,
          color: form.color,
          emoji: form.kind === 'LOST' ? form.emoji.trim() || null : null,
          kind: form.kind,
        });
        toast.success(t('Lifecycle stage created'));
      }
      setFormOpen(false);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.code === 'STAGE_LIMIT' ? t('A workspace can have at most 20 lifecycle stages.') : t('Could not save lifecycle stage'));
    } finally {
      setBusy(false);
    }
  };

  const selectDefault = async (stage: LifecycleStage) => {
    setBusyStageId(stage.id);
    try {
      await updateLifecycleStage(stage.id, { isDefault: true });
      toast.success(t('Default stage updated'));
      await load(false);
    } catch {
      toast.error(t('Could not update lifecycle stage'));
    } finally {
      setBusyStageId(null);
    }
  };

  const selectWon = async () => {
    if (!wonTarget) return;
    setBusy(true);
    try {
      await updateLifecycleStage(wonTarget.id, { isWon: true });
      toast.success(t('Won stage updated'));
      setWonTarget(null);
      await load(false);
    } catch {
      toast.error(t('Could not update lifecycle stage'));
    } finally {
      setBusy(false);
    }
  };

  const persistOrder = async (kind: StageKind, next: LifecycleStage[]) => {
    const previous = stages;
    setStages((rows) => rows.filter((stage) => stage.kind !== kind).concat(next.map((stage, orderIndex) => ({ ...stage, orderIndex }))));
    try {
      await reorderLifecycleStages(kind, next.map((stage) => stage.id));
    } catch {
      setStages(previous);
      toast.error(t('Could not reorder lifecycle stages'));
    }
  };

  const moveStage = (stage: LifecycleStage, direction: -1 | 1) => {
    const column = stage.kind === 'ACTIVE' ? active : lost;
    const index = column.findIndex((row) => row.id === stage.id);
    const target = index + direction;
    if (stage.isWon || target < 0 || target >= column.length || column[target]?.isWon) return;
    const next = [...column];
    [next[index], next[target]] = [next[target], next[index]];
    persistOrder(stage.kind, next);
  };

  const dropStage = (kind: StageKind, targetId: string) => {
    if (!draggedId) return;
    const column = kind === 'ACTIVE' ? active : lost;
    const source = column.find((stage) => stage.id === draggedId);
    const targetIndex = column.findIndex((stage) => stage.id === targetId);
    if (!source || source.isWon || targetIndex < 0) return;
    const next = column.filter((stage) => stage.id !== source.id);
    const insertion = next[targetIndex]?.isWon ? Math.max(0, targetIndex) : targetIndex;
    next.splice(insertion, 0, source);
    const won = next.find((stage) => stage.isWon);
    const normalized = won ? next.filter((stage) => !stage.isWon).concat(won) : next;
    setDraggedId(null);
    persistOrder(kind, normalized);
  };

  const moveColumn = async (stage: LifecycleStage) => {
    setBusyStageId(stage.id);
    try {
      await updateLifecycleStage(stage.id, { kind: stage.kind === 'ACTIVE' ? 'LOST' : 'ACTIVE' });
      toast.success(t('Lifecycle stage moved'));
      await load(false);
    } catch {
      toast.error(t('Could not update lifecycle stage'));
    } finally {
      setBusyStageId(null);
    }
  };

  const removeStage = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await deleteLifecycleStage(deleteTarget.id, { reassignToStageId: replacementId === '__clear__' ? null : replacementId });
      toast.success(t('Lifecycle stage deleted'));
      setDeleteTarget(null);
      await load(false);
    } catch {
      toast.error(t('Could not delete lifecycle stage'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LayoutSkeleton label={t('Loading lifecycle stages')} className="m-4" />;
  if (failed) return <ErrorState title={t('Could not load lifecycle stages')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <SettingsHeader
      title={t('Lifecycle')}
      description={t('Define the path from first contact to conversion and record why opportunities leave the funnel.')}
      action={<><div className="flex items-center gap-3 text-caption text-muted-foreground">
          <span><bdi dir="ltr">{stages.length} / 20</bdi> {t('stages')}</span>
          {!capabilities.canManage && <span className="flex items-center gap-2"><ShieldCheck className="size-4" />{t('Only workspace owners can change lifecycle stages.')}</span>}
        </div></>}
    />

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="grid gap-8 xl:grid-cols-2">
          <StageColumn
            kind="ACTIVE"
            title={t('Lifecycle stages')}
            description={t('Primary stages form the ordered sales funnel. The Won stage always remains last.')}
            stages={active}
            totalCount={stages.length}
            canManage={capabilities.canManage}
            busyStageId={busyStageId}
            activeCount={active.length}
            onAdd={() => openCreate('ACTIVE')}
            onEdit={openEdit}
            onMove={moveStage}
            onMoveColumn={moveColumn}
            onDefault={selectDefault}
            onWon={setWonTarget}
            onDelete={(stage) => { setDeleteTarget(stage); setReplacementId('__clear__'); }}
            onDragStart={setDraggedId}
            onDrop={dropStage}
            t={t}
          />
          <StageColumn
            kind="LOST"
            title={t('Lost stages')}
            description={t('Lost stages end a journey and explain where opportunities dropped out.')}
            stages={lost}
            totalCount={stages.length}
            canManage={capabilities.canManage}
            busyStageId={busyStageId}
            activeCount={active.length}
            onAdd={() => openCreate('LOST')}
            onEdit={openEdit}
            onMove={moveStage}
            onMoveColumn={moveColumn}
            onDefault={selectDefault}
            onWon={setWonTarget}
            onDelete={(stage) => { setDeleteTarget(stage); setReplacementId('__clear__'); }}
            onDragStart={setDraggedId}
            onDrop={dropStage}
            t={t}
          />
        </div>
      </div>

      <Dialog open={formOpen} onOpenChange={(open) => { if (!open) setFormOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{editing ? t('Edit lifecycle stage') : form.kind === 'LOST' ? t('Add lost stage') : t('Add lifecycle stage')}</DialogTitle></DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-2">
              <Label>{t('Stage type')}</Label>
              <div className="grid grid-cols-2 rounded-md border border-border p-1">
                {(['ACTIVE', 'LOST'] as const).map((kind) => <Button key={kind} type="button" variant={form.kind === kind ? 'secondary' : 'ghost'} className="h-8" disabled={!!editing && (editing.isDefault || editing.isWon)} onClick={() => setForm((value) => ({ ...value, kind }))}>{kind === 'ACTIVE' ? t('Primary stage') : t('Lost stage')}</Button>)}
              </div>
              {editing && (editing.isDefault || editing.isWon) && <p className="text-caption text-muted-foreground">{t('Move the default or Won marker before changing this stage type.')}</p>}
            </div>
            <div className="space-y-2"><Label htmlFor="lifecycle-name">{t('Stage name')}</Label><Input id="lifecycle-name" value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} maxLength={40} /></div>
            <div className="space-y-2"><Label htmlFor="lifecycle-description">{t('Description')}</Label><Textarea id="lifecycle-description" value={form.description} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} maxLength={160} rows={3} /></div>
            {form.kind === 'LOST' && <div className="space-y-2"><Label htmlFor="lifecycle-emoji">{t('Emoji or short symbol')}</Label><Input id="lifecycle-emoji" value={form.emoji} onChange={(event) => setForm((value) => ({ ...value, emoji: event.target.value }))} maxLength={12} className="max-w-32" /></div>}
            <div className="space-y-2">
              <Label>{t('Stage color')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                {COLORS.map((color) => <button key={color} type="button" aria-label={`${t('Choose color')} ${color}`} className={cn('flex size-8 items-center justify-center rounded-md border border-border', form.color === color && 'ring-2 ring-primary ring-offset-2 ring-offset-background')} style={{ backgroundColor: color }} onClick={() => setForm((value) => ({ ...value, color }))}>{form.color === color && <Check className="size-4 text-white" />}</button>)}
                <Label className="relative flex size-8 cursor-pointer items-center justify-center overflow-hidden rounded-md border border-border" style={{ backgroundColor: form.color }}><span className="sr-only">{t('Custom color')}</span><input type="color" value={form.color} onChange={(event) => setForm((value) => ({ ...value, color: event.target.value.toUpperCase() }))} className="absolute inset-0 cursor-pointer opacity-0" /></Label>
              </div>
            </div>
          </div>
          <DialogFooter><Button type="button" variant="outline" onClick={() => setFormOpen(false)}>{t('Cancel')}</Button><Button type="button" onClick={saveStage} disabled={busy || !form.name.trim()}>{editing ? t('Save') : t('Add stage')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!wonTarget}
        onOpenChange={(open) => { if (!open) setWonTarget(null); }}
        title={t('Change Won stage')}
        description={t('The Won stage ends a lifecycle journey as a conversion and changes lifecycle reporting. It always remains last.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Set as Won')}
        onConfirm={selectWon}
        busy={busy}
        destructive={false}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('Delete lifecycle stage')}
        description={deleteTarget?.contactCount ? `${deleteTarget.contactCount} ${t('contacts are assigned to this stage. Choose where they should move.')}` : t('No contacts are assigned to this stage.')}
        cancelLabel={t('Cancel')}
        confirmLabel={t('Delete stage')}
        onConfirm={removeStage}
        busy={busy}
      >
        {!!deleteTarget?.contactCount && <div className="space-y-2"><Label>{t('Move assigned contacts to')}</Label><Select value={replacementId} onValueChange={setReplacementId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__clear__">{t('Clear lifecycle stage')}</SelectItem>{stages.filter((stage) => stage.id !== deleteTarget.id).map((stage) => <SelectItem key={stage.id} value={stage.id}>{stage.name}</SelectItem>)}</SelectContent></Select></div>}
      </ConfirmDialog>
    </div>
  );
}

function StageColumn({ kind, title, description, stages, totalCount, canManage, busyStageId, activeCount, onAdd, onEdit, onMove, onMoveColumn, onDefault, onWon, onDelete, onDragStart, onDrop, t }: {
  kind: StageKind;
  title: string;
  description: string;
  stages: LifecycleStage[];
  totalCount: number;
  canManage: boolean;
  busyStageId: string | null;
  activeCount: number;
  onAdd: () => void;
  onEdit: (stage: LifecycleStage) => void;
  onMove: (stage: LifecycleStage, direction: -1 | 1) => void;
  onMoveColumn: (stage: LifecycleStage) => void;
  onDefault: (stage: LifecycleStage) => void;
  onWon: (stage: LifecycleStage) => void;
  onDelete: (stage: LifecycleStage) => void;
  onDragStart: (id: string) => void;
  onDrop: (kind: StageKind, targetId: string) => void;
  t: (key: string) => string;
}) {
  const wonIndex = stages.findIndex((stage) => stage.isWon);
  return <section aria-labelledby={`lifecycle-${kind.toLowerCase()}`}>
    <div className="mb-3 flex items-start gap-3">
      <div className="min-w-0 flex-1"><h2 id={`lifecycle-${kind.toLowerCase()}`} className="text-small font-semibold">{title}</h2><p className="mt-1 text-caption text-muted-foreground">{description}</p></div>
      {canManage && <Button type="button" size="sm" variant="outline" onClick={onAdd} disabled={totalCount >= 20}><Plus className="size-4" />{t('Add stage')}</Button>}
    </div>
    <div className="divide-y divide-border border-y border-border">
      {stages.map((stage, index) => {
        const protectedDelete = stage.isWon || stage.isDefault || (stage.kind === 'ACTIVE' && activeCount <= 1);
        const downBlocked = stage.isWon || index === stages.length - 1 || (wonIndex >= 0 && index === wonIndex - 1);
        return <article
          key={stage.id}
          draggable={canManage && !stage.isWon}
          onDragStart={() => onDragStart(stage.id)}
          onDragOver={(event) => { if (canManage) event.preventDefault(); }}
          onDrop={() => onDrop(kind, stage.id)}
          className="flex min-h-20 items-center gap-2 bg-card px-2 py-3 sm:px-3"
        >
          {canManage && <span className={cn('hidden cursor-grab text-muted-foreground sm:block', stage.isWon && 'cursor-not-allowed opacity-30')} title={stage.isWon ? t('The Won stage must remain last.') : t('Drag to reorder')}><GripVertical className="size-4" /></span>}
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md text-small font-semibold text-white" style={{ backgroundColor: stage.color || '#64748B' }}>{stage.emoji || (stage.kind === 'LOST' ? <CircleX className="size-4" /> : index + 1)}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-small font-semibold">{stage.name}</h3>{stage.isDefault && <Badge variant="secondary"><Star className="me-1 size-3" />{t('Default')}</Badge>}{stage.isWon && <Badge className="bg-success/10 text-success hover:bg-success/10"><Trophy className="me-1 size-3" />{t('Won')}</Badge>}</div>
            <p className="mt-1 line-clamp-2 text-caption text-muted-foreground">{stage.description || t('No description')}</p>
            <p className="mt-1 text-micro text-muted-foreground">{stage.contactCount} {t('contacts')}</p>
          </div>
          {canManage && <div className="flex shrink-0 items-center">
            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={index === 0 || stage.isWon || busyStageId === stage.id} onClick={() => onMove(stage, -1)} aria-label={t('Move up')} title={t('Move up')}><ArrowUp className="size-4" /></Button>
            <Button type="button" variant="ghost" size="icon" className="size-8" disabled={downBlocked || busyStageId === stage.id} onClick={() => onMove(stage, 1)} aria-label={t('Move down')} title={t('Move down')}><ArrowDown className="size-4" /></Button>
            <RowOverflowMenu label={t('Stage actions')} actions={[
              { label: t('Edit stage'), icon: Pencil, onSelect: () => onEdit(stage) },
              ...(stage.kind === 'ACTIVE' && !stage.isDefault && !stage.isWon ? [{ label: t('Set as default'), icon: Star, onSelect: () => onDefault(stage) }] : []),
              ...(stage.kind === 'ACTIVE' && !stage.isWon && !stage.isDefault ? [{ label: t('Set as Won'), icon: Trophy, onSelect: () => onWon(stage) }] : []),
              ...(!stage.isDefault && !stage.isWon ? [{ label: stage.kind === 'ACTIVE' ? t('Move to Lost stages') : t('Move to lifecycle stages'), icon: CircleX, onSelect: () => onMoveColumn(stage) }] : []),
              { label: stage.isWon ? t('Won stage cannot be deleted') : stage.isDefault ? t('Default stage cannot be deleted') : activeCount <= 1 && stage.kind === 'ACTIVE' ? t('The last primary stage cannot be deleted') : t('Delete stage'), icon: Trash2, destructive: !protectedDelete, disabled: protectedDelete, onSelect: () => onDelete(stage) },
            ]} />
          </div>}
        </article>;
      })}
      {!stages.length && <EmptyState icon={kind === 'ACTIVE' ? Star : CircleX} title={kind === 'ACTIVE' ? t('No lifecycle stages configured') : t('No lost stages configured')} compact />}
    </div>
  </section>;
}

function byOrder(a: LifecycleStage, b: LifecycleStage) {
  return a.orderIndex - b.orderIndex || a.name.localeCompare(b.name);
}
