'use client';

import { useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import {
  bulkUpdateContacts,
  createSegment,
  type Segment,
} from '@/lib/data';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Turn a hand-picked selection into a reusable group.
 *
 * Saving a segment already existed and could only save a *filter* — the button
 * was disabled until you had built one. That covers "everyone in Nablus who
 * bought last month" and not "these eleven people are our VIPs", which is the
 * more common thing to want and the one nobody can express as a rule.
 *
 * ## Why a tag plus a segment, and not a third model
 *
 * A tag is the membership: it lives on the contact, survives edits, and can be
 * added or removed one person at a time later. The segment is the saved view of
 * that tag — which is what makes the group show up in the campaign composer's
 * audience picker without another line of code, because that picker already
 * reads segments.
 *
 * Inventing a `ContactGroup` model would have meant a fourth way to describe a
 * set of contacts, and a fourth thing for the broadcast audience to learn.
 */
export function SaveGroupDialog({
  open,
  contactIds,
  onClose,
  onSaved,
}: {
  open: boolean;
  contactIds: string[];
  onClose: () => void;
  onSaved: (segment: Segment, tagName: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('اسم المجموعة مطلوب'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // Tag first. If the segment save fails after this, the contacts are still
      // tagged and the group can be rebuilt from the tag — the opposite order
      // would leave a saved view pointing at a tag nobody carries.
      await bulkUpdateContacts({ contactIds, tagName: trimmed });

      const segment = await createSegment({
        name: trimmed,
        filter: {
          $and: [{ category: 'tag', field: trimmed, operator: 'isEqualTo', value: trimmed }],
        },
      });

      onSaved(segment, trimmed);
      setName('');
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? t('تعذّر حفظ المجموعة'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            {t('حفظ كمجموعة')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">{t('اسم المجموعة')}</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && save()}
              placeholder={t('مثال: عملاء VIP')}
              autoFocus
            />
          </div>

          {/*
            Said plainly, because it is the part that surprises people later:
            the group is the tag. Someone tagged VIP tomorrow is in the group
            tomorrow, without anyone reopening this dialog.
          */}
          <p className="text-micro text-muted-foreground">
            {t('رح ينضاف وسم بنفس الاسم لـ')} {contactIds.length}{' '}
            {t('جهة اتصال، والمجموعة رح تتحدث لحالها لما تضيف أو تشيل الوسم.')}
          </p>

          {error && <p className="text-caption text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('إلغاء')}</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('حفظ')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
