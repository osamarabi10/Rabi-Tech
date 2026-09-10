'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Building2,
  Keyboard,
  Languages,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
  Workflow,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/lib/i18n';
import { useTheme, type Theme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  category: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords?: string[];
  action: () => void;
  badge?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShortcuts?: () => void;
}

type StoredUser = {
  platformRole?: string;
  scope?: string;
};

export function CommandPalette({
  open,
  onOpenChange,
  onOpenShortcuts,
}: CommandPaletteProps) {
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const { resolved: resolvedTheme, setTheme } = useTheme();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentUser, setCurrentUser] = useState<StoredUser>({});

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelectedIndex(0);
    try {
      setCurrentUser(JSON.parse(localStorage.getItem('rabitech_user') || '{}'));
    } catch {
      setCurrentUser({});
    }
  }, [open]);

  const isPlatformOwner =
    currentUser.platformRole === 'OWNER' || currentUser.scope === 'PLATFORM';

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [
      {
        id: 'nav-inbox',
        title: t('المحادثات'),
        subtitle: t('صندوق الوارد والرسائل الحية'),
        category: t('التنقل'),
        icon: MessageSquare,
        keywords: ['inbox', 'chat', 'messages', 'whatsapp', 'محادثة', 'رسائل'],
        action: () => router.push('/inbox'),
      },
      {
        id: 'nav-contacts',
        title: t('جهات الاتصال'),
        subtitle: t('إدارة العملاء والتصنيفات والشرائح'),
        category: t('التنقل'),
        icon: Users,
        keywords: ['contacts', 'crm', 'customers', 'عملاء', 'ارقام'],
        action: () => router.push('/contacts'),
      },
      {
        id: 'nav-campaigns',
        title: t('البث والحملات'),
        subtitle: t('إرسال رسائل جماعية وحملات مجدولة'),
        category: t('التنقل'),
        icon: Megaphone,
        keywords: ['broadcast', 'campaigns', 'marketing', 'بث', 'حملات'],
        action: () => router.push('/campaigns'),
      },
      {
        id: 'nav-automations',
        title: t('الأتمتة وسير العمل'),
        subtitle: t('الردود التلقائية وقواعد الكلمات المفتاحية'),
        category: t('التنقل'),
        icon: Workflow,
        keywords: ['automations', 'workflows', 'bot', 'رد تلقائي', 'بوت'],
        action: () => router.push('/automations'),
      },
      {
        id: 'nav-reports',
        title: t('التقارير والإحصائيات'),
        subtitle: t('أداء الفريق وأوقات الاستجابة ومعدلات الإغلاق'),
        category: t('التنقل'),
        icon: LayoutDashboard,
        keywords: ['reports', 'analytics', 'stats', 'احصائيات', 'تقارير'],
        action: () => router.push('/reports'),
      },
      {
        id: 'nav-settings',
        title: t('الإعدادات'),
        subtitle: t('إعدادات الحساب والقنوات والمستخدمين'),
        category: t('التنقل'),
        icon: Settings,
        keywords: ['settings', 'config', 'profile', 'اعدادات'],
        action: () => router.push('/settings'),
      },
    ];

    if (isPlatformOwner) {
      items.push({
        id: 'nav-platform',
        title: t('وحدة إدارة المنصة'),
        subtitle: t('إدارة المشتركين والخطط والفوترة'),
        category: t('التنقل'),
        icon: Building2,
        keywords: ['platform', 'subscribers', 'admin', 'مشتركين', 'منصة'],
        action: () => router.push('/platform/subscribers'),
        badge: t('مالك المنصة'),
      });
    }

    items.push(
      {
        id: 'action-theme-toggle',
        title:
          resolvedTheme === 'dark' ? t('تفعيل الوضع الفاتح') : t('تفعيل الوضع الداكن'),
        subtitle: t('تبديل مظهر واجهة المستخدم'),
        category: t('إجراءات سريعة'),
        icon: resolvedTheme === 'dark' ? Sun : Moon,
        keywords: ['theme', 'dark', 'light', 'مظهر', 'ليلي', 'داكن', 'فاتح'],
        action: () => {
          const next: Theme = resolvedTheme === 'dark' ? 'light' : 'dark';
          setTheme(next);
          toast.success(
            next === 'dark' ? t('تم تفعيل الوضع الداكن') : t('تم تفعيل الوضع الفاتح'),
          );
        },
      },
      {
        id: 'action-lang-ar',
        title: 'العربية (Arabic)',
        category: t('اللغة والواجهة'),
        icon: Languages,
        keywords: ['language', 'arabic', 'ar', 'عربي'],
        action: () => {
          setLocale('ar');
          toast.success('تم تحويل الواجهة إلى العربية');
        },
        badge: locale === 'ar' ? t('الحالية') : undefined,
      },
      {
        id: 'action-lang-he',
        title: 'עברית (Hebrew)',
        category: t('اللغة والواجهة'),
        icon: Languages,
        keywords: ['language', 'hebrew', 'he', 'עברית'],
        action: () => {
          setLocale('he');
          toast.success('שפת הממשק שונתה לעברית');
        },
        badge: locale === 'he' ? t('الحالية') : undefined,
      },
      {
        id: 'action-lang-en',
        title: 'English (US)',
        category: t('اللغة والواجهة'),
        icon: Languages,
        keywords: ['language', 'english', 'en', 'انجليزي'],
        action: () => {
          setLocale('en');
          toast.success('Language changed to English');
        },
        badge: locale === 'en' ? t('الحالية') : undefined,
      },
      {
        id: 'action-shortcuts',
        title: t('اختصارات لوحة المفاتيح'),
        subtitle: t('عرض جميع المفاتيح السريعة'),
        category: t('إجراءات سريعة'),
        icon: Keyboard,
        keywords: ['shortcuts', 'hotkeys', 'keys', 'اختصارات', 'مفاتيح'],
        action: () => window.setTimeout(() => onOpenShortcuts?.(), 0),
      },
    );

    return items;
  }, [
    isPlatformOwner,
    locale,
    onOpenShortcuts,
    resolvedTheme,
    router,
    setLocale,
    setTheme,
    t,
  ]);

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      [command.title, command.subtitle, command.category, ...(command.keywords ?? [])]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(needle)),
    );
  }, [commands, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (command: CommandItem) => {
      onOpenChange(false);
      command.action();
    },
    [onOpenChange],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (filteredCommands.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % filteredCommands.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(
          (index) => (index - 1 + filteredCommands.length) % filteredCommands.length,
        );
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const selected = filteredCommands[selectedIndex];
        if (selected) handleSelect(selected);
      }
    },
    [filteredCommands, handleSelect, selectedIndex],
  );

  const selectedCommand = filteredCommands[selectedIndex];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-xl gap-0 overflow-hidden rounded-lg border-border bg-card p-0 shadow-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>{t('لوحة الأوامر')}</DialogTitle>
          <DialogDescription>{t('ابحث عن شاشة أو إجراء أو اكتب أمراً...')}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-3.5 pe-12">
          <Search className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('ابحث عن شاشة أو إجراء أو اكتب أمراً...')}
            aria-label={t('بحث الأوامر')}
            aria-autocomplete="list"
            aria-controls="dashboard-command-results"
            aria-activedescendant={selectedCommand ? `command-${selectedCommand.id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="hidden rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground shadow-sm sm:inline-flex">
            Esc
          </kbd>
        </div>

        <div
          id="dashboard-command-results"
          role="listbox"
          aria-label={t('نتائج الأوامر')}
          className="max-h-[min(380px,55vh)] overflow-y-auto p-2"
        >
          {filteredCommands.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <p>
                {t('لم يتم العثور على نتائج لـ')} &quot;{query}&quot;
              </p>
              <p className="mt-1 text-xs opacity-75">
                {t('جرب البحث بكلمات أخرى أو تصفح القائمة')}
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {filteredCommands.map((command, index) => {
                const Icon = command.icon;
                const isSelected = index === selectedIndex;
                return (
                  <button
                    id={`command-${command.id}`}
                    key={command.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelect(command)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-start transition-colors',
                      isSelected
                        ? 'bg-primary text-primary-foreground shadow-sm'
                        : 'text-foreground hover:bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-md',
                        isSelected
                          ? 'bg-white/20 text-primary-foreground'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>

                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-xs font-semibold">{command.title}</span>
                        {command.badge && (
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                              isSelected
                                ? 'bg-white/25 text-white'
                                : 'bg-primary/10 text-primary',
                            )}
                          >
                            {command.badge}
                          </span>
                        )}
                      </span>
                      {command.subtitle && (
                        <span
                          className={cn(
                            'truncate text-[11px]',
                            isSelected
                              ? 'text-primary-foreground/85'
                              : 'text-muted-foreground',
                          )}
                        >
                          {command.subtitle}
                        </span>
                      )}
                    </span>

                    <span
                      className={cn(
                        'hidden max-w-28 shrink-0 truncate text-[10px] sm:block',
                        isSelected ? 'text-primary-foreground/70' : 'text-muted-foreground',
                      )}
                    >
                      {command.category}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex min-h-9 items-center justify-between gap-3 border-t border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
          <span className="hidden items-center gap-3 sm:flex">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">Up/Down</kbd>
              {t('للتنقل')}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-[10px]">Enter</kbd>
              {t('للاختيار')}
            </span>
          </span>
          <span className="ms-auto flex items-center gap-1 font-mono text-[10px]">
            <Keyboard className="size-3" aria-hidden />
            Ctrl / Cmd + K
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
