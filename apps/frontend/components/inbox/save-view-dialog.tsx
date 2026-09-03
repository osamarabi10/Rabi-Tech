'use client';

import { useEffect, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PermissionNotice } from '@/components/permission-notice';
import { useT } from '@/lib/i18n';

/**
 * Naming a view, and deciding who else gets it.
 *
 * Used for both creating and renaming, because they ask the same two questions
 * and a second dialog would be the same fields with a different title.
 *
 * The dialog shows what is about to be saved. An agent who has been narrowing
 * an inbox for a minute cannot be expected to remember every control they
 * touched, and a saved view that turns out to mean something else is worse than
 * no saved view — they will trust it and miss conversations.
 */
export function SaveViewDialog({
  open,
  onOpenChange,
  mode,
  initialName = '',
  initialShared = false,
  describes = [],
  omits = [],
  canShare,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  mode: 'create' | 'edit';
  initialName?: string;
  initialShared?: boolean;
  /** What the saved filter will contain, in words. */
  describes?: string[];
  /** What is on screen but cannot be saved. */
  omits?: string[];
  canShare: boolean;
  onSubmit: (name: string, shared: boolean) => Promise<void>;
}) {
  const { t } = useT();
  const [name, setName] = useState(initialName);
  const [shared, setShared] = useState(initialShared);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed each time it opens: the dialog outlives one use, and editing a
  // second view would otherwise show the first one's name.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setShared(initialShared);
      setError(null);
    }
  }, [open, initialName, initialShared]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('لازم اسم للعرض'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit(trimmed, shared);
      onOpenChange(false);
    } catch (err: any) {
      // The server names the offending key on a bad filter and explains a 409
      // in words. Showing its message beats a generic failure that leaves an
      // agent guessing which part it disliked.
      setError(err?.response?.data?.error ?? t('تعذّر حفظ العرض'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('احفظ هالعرض') : t('عدّل العرض')}</DialogTitle>
          {mode === 'create' && (
            <DialogDescription>{t('بيحفظ الفلاتر اللي مفعّلة هلق.')}</DialogDescription>
          )}
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="view-name">{t('الاسم')}</Label>
            <Input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) submit();
              }}
              maxLength={60}
              placeholder={t('مثلاً: مبيعات ما ردّينا عليها')}
              autoFocus
            />
          </div>

          {mode === 'create' && describes.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 p-2.5">
              <p className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">
                {t('بينحفظ')}
              </p>
              <ul className="mt-1 space-y-0.5 text-caption">
                {describes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {/*
            Named, not hidden. An agent who filtered by mentions or typed a
            search and then saved would otherwise get a view quietly missing
            that part, and would trust it.
          */}
          {mode === 'create' && omits.length > 0 && (
            <p className="text-caption leading-5 text-warning">
              {t('ما بينحفظ:')} {omits.join('، ')}
            </p>
          )}

          {canShare ? (
            <label className="flex items-start gap-2 rounded-md border border-border p-2.5">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <Users className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t('شاركه مع الفريق')}
                </span>
                <span className="mt-0.5 block text-caption text-muted-foreground">
                  {t('رح يشوفوه كل أعضاء المؤسسة بصندوق الوارد عندهم.')}
                </span>
              </span>
            </label>
          ) : (
            /*
              Shown rather than removed. A missing checkbox is indistinguishable
              from a feature that does not exist, and this one does — it just is
              not this agent's to use.
            */
            <PermissionNotice action="مشاركة عرض مع الفريق" who="مدير المؤسسة أو المشرف" />
          )}

          {error && <p className="text-caption text-danger">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('إلغاء')}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('حفظ')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
