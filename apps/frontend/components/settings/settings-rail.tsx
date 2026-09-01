'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Bell, Braces, Building2, Cable, ContactRound, FileUp, FileText, GitBranch, KeyRound, MessageCircleMore, MessageSquareText, Paperclip, Plug, Tags, Users, UserRound, Webhook, Workflow } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/*
  Grouped to mirror Respond.io's workspace settings, deliberately.

  Theirs is a flat list of 18 articles; ours groups them, because a flat list of
  eighteen in three languages is a wall. What matches is the *membership and
  order* — which screen sits with which, and in what sequence — because that is
  what someone moving between the two products is navigating by. API keys and
  webhooks live under Integrations for exactly that reason: it is where their
  users look for them, and matching where people look is most of what an
  information architecture is for.

  Screens they have and we do not are absent rather than stubbed. A greyed-out
  nav entry is indistinguishable from a broken one.
*/
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
    label: 'القنوات والتكاملات',
    items: [
      { href: '/settings/channels', label: 'القنوات', icon: Cable },
      { href: '/settings/meta-templates', label: 'قوالب Meta', icon: FileText },
      { href: '/settings/integrations', label: 'التكاملات', icon: Plug },
      { href: '/settings/api', label: 'مفاتيح API', icon: KeyRound },
      { href: '/settings/webhooks', label: 'ويب هوكس', icon: Webhook },
    ],
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
    label: 'البيانات والملفات',
    items: [
      { href: '/contacts/import', label: 'استيراد جهات الاتصال', icon: FileUp },
      { href: '/settings/files', label: 'الملفات', icon: Paperclip },
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
