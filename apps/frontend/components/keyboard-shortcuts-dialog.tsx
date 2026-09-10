'use client';

import { Keyboard } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';

interface KeyboardShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: KeyboardShortcutsDialogProps) {
  const { t } = useT();
  const groups = [
    {
      title: t('عام وتنقل'),
      shortcuts: [
        { keys: ['Ctrl / Cmd', 'K'], label: t('فتح لوحة الأوامر السريعة') },
        { keys: ['?'], label: t('عرض دليل اختصارات المفاتيح') },
        { keys: ['Esc'], label: t('إغلاق النوافذ المنبثقة أو إلغاء التحديد') },
      ],
    },
    {
      title: t('صندوق المحادثات (Inbox)'),
      shortcuts: [
        { keys: ['J'], label: t('الانتقال للمحادثة التالية') },
        { keys: ['K'], label: t('الانتقال للمحادثة السابقة') },
        { keys: ['R'], label: t('التركيز الفوري على صندوق الرد') },
        { keys: ['E'], label: t('حل وإغلاق المحادثة الحالية') },
      ],
    },
    {
      title: t('كتابة الرسائل'),
      shortcuts: [
        { keys: ['/'], label: t('استدعاء القوالب والنصوص المحفوظة') },
        { keys: ['@'], label: t('الإشارة إلى زميل في الملاحظات الداخلية') },
        { keys: ['Enter'], label: t('إرسال الرسالة مباشرة') },
        { keys: ['Shift', 'Enter'], label: t('سطر جديد دون إرسال') },
      ],
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-lg overflow-y-auto rounded-lg border-border bg-card p-0 shadow-2xl">
        <DialogHeader className="border-b border-border px-5 py-4 pe-12 text-start">
          <DialogTitle className="flex items-center gap-2 text-base font-bold tracking-normal">
            <Keyboard className="size-5 text-primary" aria-hidden />
            {t('اختصارات لوحة المفاتيح')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t('عرض جميع المفاتيح السريعة')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-4">
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="mb-1.5 text-xs font-bold text-muted-foreground">
                {group.title}
              </h3>
              <div className="divide-y divide-border/60 border-y border-border/60">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={`${group.title}-${shortcut.label}`}
                    className="flex min-h-10 items-center justify-between gap-3 py-2 text-xs"
                  >
                    <span className="min-w-0 text-foreground">{shortcut.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className="flex h-6 min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-semibold text-foreground shadow-sm"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
