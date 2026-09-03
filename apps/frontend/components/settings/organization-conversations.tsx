'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  createConversationCategory,
  deleteConversationCategory,
  fetchConversationSettings,
  fetchOrganizationUsers,
  updateConversationCategory,
  updateConversationSettings,
  type ClosingNoteMode,
  type ConversationCategory,
  type ConversationSettings,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RowOverflowMenu } from '@/components/ui/list-primitives';
import { EmptyState, ErrorState, LayoutSkeleton } from '@/components/ui/operational-state';
import { Textarea } from '@/components/ui/textarea';
import { SettingsHeader } from './settings-primitives';

type DurationUnit = 'minutes' | 'hours' | 'days';

function splitDuration(minutes: number): { value: number; unit: DurationUnit } {
  if (minutes % 1_440 === 0) return { value: minutes / 1_440, unit: 'days' };
  if (minutes % 60 === 0) return { value: minutes / 60, unit: 'hours' };
  return { value: minutes, unit: 'minutes' };
}

function durationInMinutes(value: number, unit: DurationUnit): number {
  return value * (unit === 'days' ? 1_440 : unit === 'hours' ? 60 : 1);
}

function PolicySwitch({ checked, onCheckedChange, disabled, label }: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'border-primary bg-primary' : 'border-input bg-muted',
      )}
    >
      <span className={cn(
        'absolute top-0.5 size-[18px] rounded-full bg-background shadow-sm transition-[inset-inline-start]',
        checked ? 'start-[1.25rem]' : 'start-0.5',
      )} />
    </button>
  );
}

export function OrganizationConversations() {
  const { t } = useT();
  const [settings, setSettings] = useState<ConversationSettings | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [durationValue, setDurationValue] = useState(24);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('hours');
  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<ConversationCategory | null>(null);
  const [categoryName, setCategoryName] = useState('');
  const [categoryDescription, setCategoryDescription] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ConversationCategory | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);

  const load = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    setFailed(false);
    try {
      const [nextSettings, roster] = await Promise.all([
        fetchConversationSettings(),
        fetchOrganizationUsers(),
      ]);
      setSettings(nextSettings);
      setCanManage(roster.capabilities.canInvite);
      const duration = splitDuration(nextSettings.autoCloseDurationMinutes);
      setDurationValue(duration.value);
      setDurationUnit(duration.unit);
    } catch {
      setFailed(true);
    } finally {
      if (showLoader) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const computedMinutes = useMemo(
    () => durationInMinutes(Number(durationValue) || 0, durationUnit),
    [durationUnit, durationValue],
  );
  const durationValid = !!settings
    && computedMinutes >= settings.limits.minAutoCloseMinutes
    && computedMinutes <= settings.limits.maxAutoCloseMinutes;

  const savePolicy = async () => {
    if (!settings || !durationValid) return;
    setSavingPolicy(true);
    try {
      const next = await updateConversationSettings({
        autoCloseEnabled: settings.autoCloseEnabled,
        autoCloseDurationMinutes: computedMinutes,
        manualClosingNotesEnabled: settings.manualClosingNotesEnabled,
        manualClosingNoteMode: settings.manualClosingNoteMode,
      });
      setSettings(next);
      toast.success(t('Conversation settings saved'));
    } catch {
      toast.error(t('Could not save conversation settings'));
    } finally {
      setSavingPolicy(false);
    }
  };

  const openCreate = () => {
    setEditingCategory(null);
    setCategoryName('');
    setCategoryDescription('');
    setCategoryDialogOpen(true);
  };

  const openEdit = (category: ConversationCategory) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setCategoryDescription(category.description || '');
    setCategoryDialogOpen(true);
  };

  const saveCategory = async () => {
    if (!categoryName.trim()) return;
    setCategoryBusy(true);
    try {
      if (editingCategory) {
        await updateConversationCategory(editingCategory.id, categoryDescription.trim() || null);
        toast.success(t('Closing category saved'));
      } else {
        await createConversationCategory({
          name: categoryName.trim(),
          description: categoryDescription.trim() || null,
        });
        toast.success(t('Closing category created'));
      }
      setCategoryDialogOpen(false);
      await load(false);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('Could not save closing category'));
    } finally {
      setCategoryBusy(false);
    }
  };

  const removeCategory = async () => {
    if (!deleteTarget) return;
    setCategoryBusy(true);
    try {
      await deleteConversationCategory(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t('Closing category deleted'));
      await load(false);
    } catch {
      toast.error(t('Could not delete closing category'));
    } finally {
      setCategoryBusy(false);
    }
  };

  if (loading) return <LayoutSkeleton label={t('Loading conversation settings')} className="m-4" />;
  if (failed || !settings) {
    return <ErrorState title={t('Could not load conversation settings')} retryLabel={t('Try again')} onRetry={load} className="m-4" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <SettingsHeader
      title={t('Conversations')}
      action={<>{!canManage && (
          <span className="flex items-center gap-2 text-caption text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden />
            {t('Only organization owners and managers can change conversation settings.')}
          </span>
        )}</>}
    />

      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-border px-4 py-5 sm:px-6" aria-labelledby="auto-close-title">
          <div className="flex max-w-4xl flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 id="auto-close-title" className="text-small font-semibold">{t('Auto-close inactive conversations')}</h2>
              <p className="mt-1 text-caption text-muted-foreground">
                {t('The timer starts after a successful human reply, pauses for snooze, and is cancelled by a Contact reply.')}
              </p>
            </div>
            <PolicySwitch
              label={t('Auto-close inactive conversations')}
              checked={settings.autoCloseEnabled}
              disabled={!canManage}
              onCheckedChange={(checked) => setSettings({ ...settings, autoCloseEnabled: checked })}
            />
          </div>

          <div className="mt-4 flex max-w-xl flex-wrap items-end gap-2">
            <div className="min-w-32 flex-1 space-y-1.5">
              <Label htmlFor="auto-close-duration">{t('Close after')}</Label>
              <Input id="auto-close-duration" type="number" min="1" value={durationValue}
                disabled={!canManage || !settings.autoCloseEnabled}
                onChange={(event) => setDurationValue(Number(event.target.value))} />
            </div>
            <div className="min-w-36 flex-1 space-y-1.5">
              <Label htmlFor="auto-close-unit">{t('Duration unit')}</Label>
              <select id="auto-close-unit" className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={durationUnit} disabled={!canManage || !settings.autoCloseEnabled}
                onChange={(event) => setDurationUnit(event.target.value as DurationUnit)}>
                <option value="minutes">{t('Minutes')}</option>
                <option value="hours">{t('Hours')}</option>
                <option value="days">{t('Days')}</option>
              </select>
            </div>
          </div>
          {!durationValid && <p className="mt-2 text-caption text-destructive">{t('Duration must be between 30 minutes and 14 days.')}</p>}
        </section>

        <section className="border-b border-border px-4 py-5 sm:px-6" aria-labelledby="closing-note-title">
          <div className="flex max-w-4xl flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <h2 id="closing-note-title" className="text-small font-semibold">{t('Closing notes')}</h2>
              <p className="mt-1 text-caption text-muted-foreground">{t('Ask agents to classify completed work for reporting and quality review.')}</p>
            </div>
            <PolicySwitch label={t('Closing notes')} checked={settings.manualClosingNotesEnabled} disabled={!canManage}
              onCheckedChange={(checked) => setSettings({ ...settings, manualClosingNotesEnabled: checked })} />
          </div>

          <fieldset className="mt-4 max-w-2xl space-y-2" disabled={!canManage || !settings.manualClosingNotesEnabled}>
            {([
              ['OPTIONAL', 'Category and summary are optional'],
              ['CATEGORY_REQUIRED', 'Category is required'],
              ['CATEGORY_AND_SUMMARY_REQUIRED', 'Category and summary are required'],
            ] as Array<[ClosingNoteMode, string]>).map(([mode, label]) => (
              <label key={mode} className="flex min-h-10 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 text-small has-[:checked]:border-primary/50 has-[:checked]:bg-primary/5">
                <input type="radio" name="closing-note-mode" value={mode} checked={settings.manualClosingNoteMode === mode}
                  onChange={() => setSettings({ ...settings, manualClosingNoteMode: mode })} />
                <span>{t(label)}</span>
              </label>
            ))}
          </fieldset>

          {canManage && <Button className="mt-4" onClick={savePolicy} disabled={savingPolicy || !durationValid}>
            {savingPolicy ? t('Saving...') : t('Save settings')}
          </Button>}
        </section>

        <section className="px-4 py-5 sm:px-6" aria-labelledby="categories-title">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="categories-title" className="text-small font-semibold">{t('Closing categories')}</h2>
              <p className="mt-1 text-caption text-muted-foreground">
                {t('Names are permanent. Descriptions can change, and deleted categories remain readable in historical closure records.')}
              </p>
            </div>
            {canManage && <Button size="sm" onClick={openCreate} disabled={settings.categories.length >= settings.limits.maxCategories}>
              <Plus className="me-1 size-4" aria-hidden />{t('Add category')}
            </Button>}
          </div>

          <div className="mt-4 max-w-4xl overflow-hidden rounded-md border border-border">
            {settings.categories.length === 0 ? (
              <EmptyState icon={Clock3} title={t('No closing categories yet')}
                description={t('Create categories such as Resolved, Duplicate, or No response.')} compact />
            ) : settings.categories.map((category, index) => (
              <div key={category.id} className={cn('flex min-h-14 items-center gap-3 px-3 py-2', index > 0 && 'border-t border-border')}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small font-medium">{category.name}</p>
                  <p className="mt-0.5 truncate text-caption text-muted-foreground">{category.description || t('No description')}</p>
                </div>
                {canManage && <RowOverflowMenu label={t('Closing category actions')} actions={[
                  { label: t('Edit description'), icon: Pencil, onSelect: () => openEdit(category) },
                  { label: t('Delete category'), icon: Trash2, destructive: true, onSelect: () => setDeleteTarget(category) },
                ]} />}
              </div>
            ))}
          </div>
        </section>
      </div>

      <Dialog open={categoryDialogOpen} onOpenChange={setCategoryDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t(editingCategory ? 'Edit closing category' : 'Add closing category')}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="closing-category-name">{t('Category name')}</Label>
              <Input id="closing-category-name" maxLength={80} value={categoryName} disabled={!!editingCategory}
                onChange={(event) => setCategoryName(event.target.value)} />
              {editingCategory && <p className="text-caption text-muted-foreground">{t('Category names cannot be changed after creation.')}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="closing-category-description">{t('Description')}</Label>
              <Textarea id="closing-category-description" maxLength={500} rows={4} value={categoryDescription}
                onChange={(event) => setCategoryDescription(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCategoryDialogOpen(false)} disabled={categoryBusy}>{t('Cancel')}</Button>
            <Button onClick={saveCategory} disabled={categoryBusy || !categoryName.trim()}>{categoryBusy ? t('Saving...') : t('Save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('Delete closing category')}
        description={t('The category is removed from future closes. Existing closure history keeps its saved category name.')}
        cancelLabel={t('Cancel')} confirmLabel={t('Delete')} onConfirm={removeCategory} busy={categoryBusy} />
    </div>
  );
}
