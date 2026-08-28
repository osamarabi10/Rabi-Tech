'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Bell, Braces, Building2, Cable, ContactRound, FileUp, GitBranch, MessageCircleMore, MessageSquareText, Tags, Users, UserRound, Workflow } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const GROUPS = [
  {
    label: 'شخصي',
    items: [
      { href: '/settings', label: 'الملف الشخصي', icon: UserRound },
      { href: '/settings/notifications', label: 'إعدادات الإشعارات', icon: Bell },
    ],
  },
  {
    label: 'عام',
    items: [{ href: '/settings/general', label: 'معلومات المؤسسة', icon: Building2 }],
  },
  {
    label: 'المستخدمون والصلاحيات',
    items: [
      { href: '/settings/users', label: 'أعضاء الفريق', icon: Users },
      { href: '/settings/teams', label: 'الفرق', icon: ContactRound },
    ],
  },
  {
    label: 'التطبيقات',
    items: [{ href: '/settings/channels', label: 'القنوات', icon: Cable }],
  },
  {
    label: 'صندوق الوارد',
    items: [
      { href: '/settings/conversations', label: 'Conversations', icon: MessageCircleMore },
      { href: '/settings/contact-fields', label: 'Contact fields', icon: Braces },
      { href: '/settings/lifecycle', label: 'مراحل العميل', icon: GitBranch },
      { href: '/settings/snippets', label: 'الردود الجاهزة', icon: MessageSquareText },
      { href: '/settings/tags', label: 'Tags', icon: Tags },
      { href: '/settings/general#auto-replies', label: 'الأتمتة', icon: Workflow },
    ],
  },
  {
    label: 'البيانات',
    items: [
      { href: '/contacts/import', label: 'استيراد جهات الاتصال', icon: FileUp },
    ],
  },
] as const;

export function SettingsRail() {
  const { t } = useT();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia('(max-width: 1023px)').matches) return;

    const frame = window.requestAnimationFrame(() => {
      railRef.current
        ?.querySelector<HTMLElement>('[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [pathname, query]);

  return (
    <aside className="w-full shrink-0 border-b border-border bg-card lg:w-64 lg:border-b-0 lg:border-e" aria-label={t('الإعدادات')}>
      <div ref={railRef} className="flex gap-1 overflow-x-auto p-2 lg:block lg:h-full lg:overflow-y-auto lg:p-3">
        {GROUPS.filter((group) => group.items.length > 0).map((group, groupIndex) => {
          const groupId = `settings-group-${groupIndex + 1}`;
          return (
          <section key={group.label} className="shrink-0 lg:mb-4" aria-labelledby={groupId}>
            <h2 id={groupId} className="hidden px-2 pb-1 text-micro font-semibold text-muted-foreground lg:block">{t(group.label)}</h2>
            <nav className="flex gap-1 lg:block" aria-label={t(group.label)}>
              {group.items.map((item) => {
                const [hrefPath, suffix = ''] = item.href.split(/(?=[?#])/);
                const active = pathname === hrefPath && (suffix ? suffix === `?${query}` : !query);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-9 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-caption font-medium text-muted-foreground hover:bg-accent hover:text-foreground lg:mb-0.5',
                      active && 'bg-primary/10 text-primary',
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    <span>{t(item.label)}</span>
                  </Link>
                );
              })}
            </nav>
          </section>
          );
        })}
      </div>
    </aside>
  );
}
