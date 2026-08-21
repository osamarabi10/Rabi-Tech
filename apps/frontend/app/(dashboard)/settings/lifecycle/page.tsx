'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  createLifecycleStage,
  deleteLifecycleStage,
  fetchLifecycleStages,
  updateLifecycleStage,
  type LifecycleStage,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/lib/i18n';

/**
 * Lifecycle stage settings.
 *
 * The pipeline is the subscriber's, not the product's. Everything on this page
 * exists so a business can describe its own funnel in its own words — which is
 * the whole reason the stage list is data rather than a constant in the
 * frontend.
 *
 * Ordering is by explicit index rather than drag-and-drop. Up/down buttons are
 * keyboard-reachable, work on touch without a long-press, and the list is five
 * or six rows — the case drag-and-drop is worst at.
 */
export default function LifecycleSettingsPage() {
  const { t } = useT();
  const [stages, setStages] = useState<LifecycleStage[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStages(await fetchLifecycleStages());
    } catch {
      toast.error(t('فشل جلب المراحل'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const stage = await createLifecycleStage({ name });
      setStages((prev) => [...prev, stage]);
      setNewName('');
      toast.success(t('تمت الإضافة'));
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('فشل الإنشاء'));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (stage: LifecycleStage, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === stage.name) return;
    try {
      const updated = await updateLifecycleStage(stage.id, { name: trimmed });
      setStages((prev) => prev.map((s) => (s.id === stage.id ? updated : s)));
    } catch (err: unknown) {
      const message = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(message || t('فشل التحديث'));
      // Reload rather than leave the field showing a rename the server rejected.
      load();
    }
  };

  const recolour = async (stage: LifecycleStage, color: string) => {
    try {
      const updated = await updateLifecycleStage(stage.id, { color });
      setStages((prev) => prev.map((s) => (s.id === stage.id ? updated : s)));
    } catch {
      toast.error(t('فشل التحديث'));
    }
  };

  /**
   * Swap a stage with its neighbour.
   *
   * Both rows are written, because order is stored per row — moving one without
   * the other would leave two stages claiming the same index and an order that
   * depends on the tie-break.
   */
  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;

    const a = stages[index];
    const b = stages[target];
    const next = [...stages];
    next[index] = b;
    next[target] = a;
    setStages(next);

    try {
      await Promise.all([
        updateLifecycleStage(a.id, { orderIndex: b.orderIndex }),
        updateLifecycleStage(b.id, { orderIndex: a.orderIndex }),
      ]);
      load();
    } catch {
      toast.error(t('فشل التحديث'));
      load();
    }
  };

  const remove = async (stage: LifecycleStage) => {
    try {
      const result = await deleteLifecycleStage(stage.id);
      setStages((prev) => prev.filter((s) => s.id !== stage.id));
      // Contacts keep the stage name they were stamped with — the column is text,
      // not a foreign key. Saying how many makes that visible instead of leaving
      // the admin to discover orphaned values later.
      if (result.affectedContacts > 0) {
        toast.success(
          `${t('تم الحذف')} · ${result.affectedContacts} ${t('جهة اتصال ما زالت تحمل هذه المرحلة')}`,
        );
      } else {
        toast.success(t('تم الحذف'));
      }
    } catch {
      toast.error(t('فشل الحذف'));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-5">
      <h1 className="mb-1 text-h1 font-extrabold">{t('مراحل العميل')}</h1>
      <p className="mb-4 text-h3 text-muted-foreground">
        {t('عرّف مراحل رحلة العميل كما تناسب عملك')}
      </p>

      <div className="max-w-2xl rounded-lg border border-border bg-card">
        {loading ? (
          <p className="p-6 text-center text-h3 text-muted-foreground">{t('جاري التحميل...')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {stages.map((stage, index) => (
              <li key={stage.id} className="flex items-center gap-2 p-3">
                <input
                  type="color"
                  value={stage.color || '#64748B'}
                  onChange={(e) => recolour(stage, e.target.value)}
                  className="h-7 w-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
                  aria-label={t('اللون')}
                />
                <Input
                  defaultValue={stage.name}
                  onBlur={(e) => rename(stage, e.target.value)}
                  className="h-8 flex-1 text-h3"
                  aria-label={t('اسم المرحلة')}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  title={t('أعلى')}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0"
                  disabled={index === stages.length - 1}
                  onClick={() => move(index, 1)}
                  title={t('أسفل')}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 text-destructive"
                  onClick={() => remove(stage)}
                  title={t('حذف')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}

            {stages.length === 0 && (
              <li className="p-6 text-center text-h3 text-muted-foreground">
                {t('لا توجد مراحل')}
              </li>
            )}
          </ul>
        )}

        <div className="flex items-center gap-2 border-t border-border p-3">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
            placeholder={t('اسم المرحلة')}
            className="h-8 flex-1 text-h3"
            maxLength={40}
          />
          <Button size="sm" onClick={add} disabled={busy || !newName.trim()}>
            <Plus className="me-1.5 h-3.5 w-3.5" />
            {t('إضافة')}
          </Button>
        </div>
      </div>
    </div>
  );
}
