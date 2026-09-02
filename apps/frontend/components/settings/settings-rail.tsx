'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { Bell, Braces, Building2, Cable, ContactRound, FileUp, FileText, GitBranch, KeyRound, MessageCircleMore, MessageSquareText, Paperclip, Link2, Plug, Tags, Users, UserRound, Webhook, Workflow } from 'lucide-react';
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
      { href: '/settings/growth-widgets', label: 'أدوات النمو', icon: Link2 },
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
    /*
      Wider and quieter than it was.

      Respond.io's settings nav is roomier than ours and sits on the page
      background rather than a raised card — which sounds like nothing and is
      most of why their settings read as calm. The rail is a wayfinding surface,
      not content, so it should recede.

      Still `border-e`, never `border-r`: this is the frame two of three
      languages read from the right.
    */
    <aside className="w-full shrink-0 border-b border-border bg-background lg:w-[248px] lg:border-b-0 lg:border-e" aria-label={t('الإعدادات')}>
      <div ref={railRef} className="flex gap-1 overflow-x-auto p-2 lg:block lg:h-full lg:overflow-y-auto lg:px-3 lg:py-5">
        {GROUPS.filter((group) => group.items.length > 0).map((group, groupIndex) => {
          const groupId = `settings-group-${groupIndex + 1}`;
          return (
          <section key={group.label} className="shrink-0 lg:mb-6" aria-labelledby={groupId}>
            {/* Uppercase, tracked, and quieter than the items under it — a
                group label is a signpost, not a destination. */}
            <h2
              id={groupId}
              className="hidden px-3 pb-1.5 text-micro font-semibold uppercase tracking-wider text-muted-foreground/80 lg:block"
            >
              {t(group.label)}
            </h2>
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
                      'flex min-h-9 items-center gap-2.5 whitespace-nowrap rounded-md px-3 text-caption font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:mb-px lg:min-h-[34px]',
                      /*
                        The active fill is the TENANT's colour, mixed down — not
                        a fixed brand blue. Respond.io can hardcode theirs
                        because every workspace looks the same; a white-label
                        product cannot, and the accent is the one thing a
                        subscriber actually chose. color-mix rather than
                        concatenating alpha onto the hsl string, which is
                        invalid CSS and fails silently.
                      */
                      active && 'bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary',
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
