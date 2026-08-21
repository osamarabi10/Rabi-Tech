'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Plus, Pencil, Trash2, Loader2, Hash } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchTemplates,
  saveTemplate,
  deleteTemplate,
  type Template,
  type Team,
} from '@/lib/data';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Snippet management.
 *
 * The standalone /templates page was folded into Settings during the navigation
 * rework, but its UI was never rebuilt — so snippets could be *used* from the
 * composer and never created or edited anywhere in the product.
 *
 * AUTO_REPLY is deliberately excluded: those are owned by the auto-replies card,
 * where each one is bound to a specific trigger.
 */
const CATEGORIES: Array<{ value: Template['category']; label: string; hint: string }> = [
  { value: 'QUICK_REPLY',  label: 'رد سريع',      hint: 'بيطلع للوكيل بزر وحدة داخل المحادثة' },
  { value: 'CAMPAIGN',     label: 'حملة',          hint: 'بيطلع كقالب جاهز لما تعمل حملة' },
  { value: 'OUT_OF_HOURS', label: 'خارج الدوام',   hint: 'نص جاهز للرد خارج أوقات العمل' },
  { value: 'OUTAGE',       label: 'انقطاع خدمة',   hint: 'إعلان جاهز وقت الأعطال' },
];

const EMPTY = {
  id: undefined as string | undefined,
  title: '',
  body: '',
  category: 'QUICK_REPLY' as Template['category'],
  shortCode: '',
  teamId: '',
  isActive: true,
};

export function SnippetsCard({ isAdmin, teams }: { isAdmin: boolean; teams: Team[] }) {
  const { t } = useT();
  const [items, setItems] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [filter, setFilter] = useState<'ALL' | Template['category']>('ALL');

  const load = useCallback(async () => {
    try {
      const all = await fetchTemplates({ includeInactive: true });
      setItems(all.filter((tpl) => tpl.category !== 'AUTO_REPLY'));
    } catch {
      toast.error(t('فشل تحميل القوالب'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const openNew = () => { setForm(EMPTY); setOpen(true); };
  const openEdit = (tpl: Template) => {
    setForm({
      id: tpl.id,
      title: tpl.title,
      body: tpl.body,
      category: tpl.category,
      shortCode: tpl.shortCode || '',
      teamId: tpl.teamId || '',
      isActive: tpl.isActive,
    });
    setOpen(true);
  };

  const submit = async () => {
    if (!form.title.trim() || !form.body.trim()) {
      toast.error(t('العنوان والنص مطلوبان'));
      return;
    }
    setSaving(true);
    try {
      await saveTemplate({
        id: form.id,
        title: form.title,
        body: form.body,
        category: form.category,
        shortCode: form.shortCode.trim() || null,
        teamId: form.teamId || null,
        isActive: form.isActive,
      });
      toast.success(form.id ? t('تم التحديث') : t('تمت الإضافة'));
      setOpen(false);
      load();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('فشل الحفظ'));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (tpl: Template) => {
    try {
      await saveTemplate({
        id: tpl.id,
        title: tpl.title,
        body: tpl.body,
        category: tpl.category,
        shortCode: tpl.shortCode || null,
        teamId: tpl.teamId || null,
        isActive: !tpl.isActive,
      });
      load();
    } catch {
      toast.error(t('فشل التحديث'));
    }
  };

  const remove = async (tpl: Template) => {
    try {
      await deleteTemplate(tpl.id);
      toast.success(t('تم الحذف'));
      load();
    } catch {
      toast.error(t('فشل الحذف'));
    }
  };

  const shown = filter === 'ALL' ? items : items.filter((i) => i.category === filter);
  const activeCategory = CATEGORIES.find((c) => c.value === form.category);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FileText className="h-4 w-4 text-primary" />
            {t('القوالب والردود السريعة')}
          </CardTitle>
          {isAdmin && (
            <Button size="sm" onClick={openNew}>
              <Plus className="h-3.5 w-3.5" />
              {t('قالب جديد')}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className="text-caption text-muted-foreground">
          {t('اكتب')} <code className="rounded bg-muted px-1">:{t('الرمز')}</code>{' '}
          {t('داخل صندوق الرد ليتوسّع القالب تلقائياً.')}
        </p>

        {/* Category filter */}
        <div className="flex flex-wrap gap-1.5">
          {(['ALL', ...CATEGORIES.map((c) => c.value)] as const).map((key) => {
            const label = key === 'ALL' ? t('الكل') : t(CATEGORIES.find((c) => c.value === key)!.label);
            const count = key === 'ALL' ? items.length : items.filter((i) => i.category === key).length;
            return (
              <button
                key={key}
                onClick={() => setFilter(key as typeof filter)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-caption font-medium transition-colors',
                  filter === key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {label} {count > 0 && <span className="opacity-70">({count})</span>}
              </button>
            );
          })}
        </div>

        {loading && (
          <p className="py-4 text-center text-xs text-muted-foreground">{t('جاري التحميل...')}</p>
        )}

        {!loading && shown.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t('لا توجد قوالب في هذا القسم')}
          </p>
        )}

        {shown.map((tpl) => (
          <div
            key={tpl.id}
            className={cn(
              'rounded-md border border-border px-3 py-2',
              !tpl.isActive && 'opacity-55',
            )}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-xs font-semibold">{tpl.title}</span>
                  {tpl.shortCode && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground" dir="ltr">
                      <Hash className="h-2.5 w-2.5" />{tpl.shortCode}
                    </span>
                  )}
                  <span className="rounded-full border border-border px-1.5 py-0 text-micro text-muted-foreground">
                    {t(CATEGORIES.find((c) => c.value === tpl.category)?.label || tpl.category)}
                  </span>
                  {!tpl.isActive && (
                    <span className="text-micro font-medium text-warning">{t('معطّل')}</span>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-caption text-muted-foreground">
                  {tpl.body}
                </p>
              </div>

              {isAdmin && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    onClick={() => toggleActive(tpl)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    title={tpl.isActive ? t('تعطيل') : t('تفعيل')}
                  >
                    <span className={cn('block h-2 w-2 rounded-full', tpl.isActive ? 'bg-success-vivid' : 'bg-muted-foreground/40')} />
                  </button>
                  <button
                    onClick={() => openEdit(tpl)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    title={t('تعديل')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => remove(tpl)}
                    className="rounded p-1 text-muted-foreground transition-colors hover:text-danger"
                    title={t('حذف')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? t('تعديل القالب') : t('قالب جديد')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('العنوان')}</Label>
              <Input value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t('النوع')}</Label>
                <Select
                  value={form.category}
                  onValueChange={(v) => setForm((p) => ({ ...p, category: v as Template['category'] }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{t(c.label)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t('الرمز المختصر')}</Label>
                <Input
                  dir="ltr"
                  placeholder="hello"
                  value={form.shortCode}
                  onChange={(e) => setForm((p) => ({ ...p, shortCode: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '') }))}
                />
              </div>
            </div>
            {activeCategory && (
              <p className="text-micro text-muted-foreground">{t(activeCategory.hint)}</p>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">{t('النص')}</Label>
              <Textarea
                rows={5}
                value={form.body}
                onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))}
                placeholder={t('استخدم {{contactName}} لاسم العميل')}
              />
              <p className="text-micro text-muted-foreground">
                {t('المتغيرات')}: <code>{'{{contactName}}'}</code> <code>{'{{firstName}}'}</code>
              </p>
            </div>

            {teams.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">{t('الفريق')}</Label>
                <Select
                  value={form.teamId || 'all'}
                  onValueChange={(v) => setForm((p) => ({ ...p, teamId: v === 'all' ? '' : v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('كل الفرق')}</SelectItem>
                    {teams.map((tm) => (
                      <SelectItem key={tm.id} value={tm.id}>{tm.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{t('إلغاء')}</Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('حفظ')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
