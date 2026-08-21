'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { createSegment, type ContactFilterDsl, type Segment } from '@/lib/data';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/lib/i18n';

/**
 * Name-and-save for the current filter.
 *
 * The duplicate-name error renders **under the field**, not only as a toast: a
 * toast disappears while the user is still looking at the input they have to
 * change, which reads as the save having silently done nothing.
 */
export function SaveSegmentDialog({
  open,
  filter,
  onClose,
  onSaved,
}: {
  open: boolean;
  filter: ContactFilterDsl | null;
  onClose: () => void;
  onSaved: (segment: Segment) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(''); setError(null); }
  }, [open]);

  const save = async () => {
    if (!filter || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const segment = await createSegment({ name: name.trim(), filter });
      toast.success(t('تم حفظ الشريحة'));
      onSaved(segment);
      onClose();
    } catch (err) {
      const response = (err as { response?: { data?: { error?: string; details?: string[] } } })?.response?.data;
      // `details` carries the per-rule filter errors; the first one is the most
      // useful thing to show beside a single-field form.
      setError(response?.details?.[0] || response?.error || t('تعذّر حفظ الشريحة'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('حفظ كشريحة')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-1">
          <Label className="text-xs">{t('اسم الشريحة')}</Label>
          <Input
            autoFocus
            value={name}
            onChange={(event) => { setName(event.target.value); setError(null); }}
            onKeyDown={(event) => { if (event.key === 'Enter') void save(); }}
            placeholder={t('عملاء مميزون')}
            aria-invalid={Boolean(error)}
          />
          {error && <p className="text-caption text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>{t('إلغاء')}</Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="me-1 h-4 w-4 animate-spin" />}
            {t('حفظ')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
