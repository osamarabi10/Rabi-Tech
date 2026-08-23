'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  Check,
  HelpCircle,
  Languages,
  LogOut,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Moon,
  Settings,
  Sun,
  SunMedium,
  Users,
  Building2,
  Workflow,
} from 'lucide-react';
import { NotificationBell } from '@/components/notification-bell';
import { useTheme, type Theme } from '@/lib/theme';
import { BrandLogo } from '@/components/brand-logo';
import { cn } from '@/lib/utils';
import { useT, LOCALES } from '@/lib/i18n';
import { useBranding } from '@/lib/branding-context';
import { setAgentAway } from '@/lib/data';
import { getViewAsOrg, setViewAsOrg } from '@/lib/api';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The navigation rail.
 *
 * A 48px icon-only rail, matching the respond.io information architecture the
 * product spec recorded: workspace switcher at the top, destinations in the
 * middle, and a cluster of avatar / notifications / help at the bottom.
 *
 * It replaced a 220px labelled column. The width is the point — the inbox is a
 * four-column screen, and 172px given back to the columns that hold
 * conversations is the difference between a comfortable contact panel and a
 * cramped one.
 *
 * Losing the labels costs something, so every destination carries a tooltip on
 * the inline-end side and an `aria-label`. Nothing here relies on the icon
 * alone for a screen reader.
 *
 * Two destinations in their rail are deliberately absent: **Incoming Calls**
 * and **AI Agents**. The first does not exist on a WhatsApp Web gateway; the
 * second is a phase that has not been built, and a rail icon opening onto
 * nothing is worse than one that is not there.
 */
const NAV_ITEMS = [
  { href: '/inbox', icon: MessageSquare, label: 'المحادثات', requires: 'conversation:read' },
  { href: '/contacts', icon: Users, label: 'جهات الاتصال', requires: 'contact:read' },
  { href: '/campaigns', icon: Megaphone, label: 'البث', requires: 'campaign:read' },
  { href: '/automations', icon: Workflow, label: 'الأتمتة', requires: 'workflow:view' },
  { href: '/reports', icon: LayoutDashboard, label: 'التقارير', requires: 'analytics:read' },
  // No permission gate. Settings is the one destination every role has some
  // business in — an agent reads the templates and the auto-replies there —
  // and the page already hides the admin-only sections from its own
  // sub-navigation.
  { href: '/settings', icon: Settings, label: 'الإعدادات' },
];

/** Shown only to the RabiTech platform owner, never to subscribers. */
const PLATFORM_ITEM = { href: '/platform/subscribers', icon: Building2, label: 'المشتركون' };

/** Per-user display preference. `system` follows the OS and is the default. */
const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: 'فاتح' },
  { value: 'dark', label: 'داكن' },
  { value: 'system', label: 'حسب النظام' },
];

export function AppSidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale, setLocale } = useT();
  const { theme, resolved: resolvedTheme, setTheme } = useTheme();
  const branding = useBranding();
  const [isAway, setIsAway] = useState(false);
  const [awayLoading, setAwayLoading] = useState(false);

  useEffect(() => {
    onClose?.();
  }, [pathname]);

  const user = (() => {
    try {
      return JSON.parse(localStorage.getItem('rabitech_user') || '{}');
    } catch {
      return {};
    }
  })();

  const isPlatformOwner = user.platformRole === 'OWNER' || user.scope === 'PLATFORM';
  const [viewAs, setViewAs] = useState<{ id: string; name: string } | null>(null);

  /**
   * What this user is allowed to do, as the server computes it.
   *
   * `null` until the answer arrives, and every destination is shown while it
   * is null. Hiding first and revealing later would flash a shrunken menu at
   * an admin on every page load, and the cost of the other order is that an
   * agent may briefly see a link they cannot use — which the server refuses
   * anyway.
   */
  const [permissions, setPermissions] = useState<string[] | null>(null);
  useEffect(() => {
    setViewAs(getViewAsOrg());
  }, [pathname]);

  const exitViewAs = () => {
    setViewAsOrg(null);
    setViewAs(null);
    router.push('/platform/subscribers');
  };

  /**
   * Destinations this user can actually reach.
   *
   * An agent was shown Broadcasts and Reports and got a refusal from both.
   * That is different from a control inside a page that vanishes for someone
   * without permission — there, the blank space is indistinguishable from an
   * empty card, so the restriction is stated instead. A navigation entry has
   * no such ambiguity: a menu is a list of places you can go, and one that
   * leads nowhere is a worse answer than its absence.
   */
  const permitted = (items: typeof NAV_ITEMS) =>
    permissions === null
      ? items
      : items.filter((item) => !item.requires || permissions.includes(item.requires));

  // A platform owner only has tenant pages to visit while viewing a subscriber;
  // without one every tenant endpoint refuses them, so the links would be dead.
  const navItems = isPlatformOwner
    ? viewAs
      ? [...NAV_ITEMS, PLATFORM_ITEM]
      : [PLATFORM_ITEM]
    : permitted(NAV_ITEMS);


  useEffect(() => {
    import('@/lib/api').then(({ default: api }) =>
      api
        .get('/api/auth/me')
        .then((r) => {
          setIsAway(!!r.data.isAway);
          setPermissions(Array.isArray(r.data.permissions) ? r.data.permissions : null);
        })
        .catch(() => {}),
    );
  }, []);

  const toggleAway = async () => {
    setAwayLoading(true);
    try {
      const res = await setAgentAway(!isAway);
      setIsAway(res.isAway);
    } catch {
      /* the dot simply stays as it was */
    } finally {
      setAwayLoading(false);
    }
  };

  /** Every rail button is the same 40px square inside a 48px rail. */
  const railButton =
    'relative flex h-10 w-10 items-center justify-center rounded-md transition-colors motion-micro';

  return (
    <TooltipProvider delayDuration={0}>
      {open && (
        <div onClick={onClose} className="fixed inset-0 z-40 bg-black/60 md:hidden" aria-hidden />
      )}

      <aside
        className={cn(
          'relative flex w-12 shrink-0 flex-col items-center overflow-visible',
          'nav-surface border-s border-nav-border',
          'fixed inset-y-0 z-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0',
          // Anchored to the inline-start edge, which is the right in Arabic and
          // the left in English — the same physical position respond.io uses in
          // each direction, rather than a hardcoded side.
          'start-0',
          open ? 'translate-x-0' : '-translate-x-full md:translate-x-0 rtl:translate-x-full rtl:md:translate-x-0',
        )}
        aria-label={t('التنقل')}
      >
        {/* ── Workspace switcher ─────────────────────────── */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(railButton, 'mt-2 hover:bg-nav-accent/60')}
              aria-label={t('مساحة العمل')}
            >
              <BrandLogo size="sm" showText={false} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="w-56">
            <DropdownMenuLabel className="truncate">{branding.productName}</DropdownMenuLabel>
            {viewAs && (
              <>
                <DropdownMenuSeparator />
                {/*
                  Looking at someone else's live customer data is not a state to
                  infer from context. It was a banner on the old wide rail; at
                  48px it moves here, but it must stay just as loud.
                */}
                <DropdownMenuLabel className="text-warning">
                  {t('تعرض بيانات مشترك')}: {viewAs.name}
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={exitViewAs} className="text-warning">
                  {t('إنهاء العرض')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/*
          The view-as warning also gets a permanent mark on the rail itself. A
          state this consequential cannot live only behind a menu nobody opens.
        */}
        {viewAs && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={exitViewAs}
                className="mt-1 h-1.5 w-8 rounded-full bg-warning"
                aria-label={`${t('تعرض بيانات مشترك')}: ${viewAs.name}`}
              />
            </TooltipTrigger>
            <TooltipContent side="right">
              {t('تعرض بيانات مشترك')}: {viewAs.name} — {t('إنهاء العرض')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* ── Destinations ───────────────────────────────── */}
        <nav className="mt-3 flex flex-1 flex-col items-center gap-1 overflow-y-auto [&::-webkit-scrollbar]:hidden">
          {navItems.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/');
            const Icon = item.icon;
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger asChild>
                  <Link
                    href={item.href}
                    aria-label={t(item.label)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      railButton,
                      active
                        ? 'bg-nav-accent text-nav-foreground'
                        : 'text-nav-muted hover:bg-nav-accent/60 hover:text-nav-foreground',
                    )}
                  >
                    {/* Active marker on the inline-start edge, so it flips with RTL. */}
                    {active && (
                      <span className="absolute start-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                    )}
                    <Icon className={cn('h-[18px] w-[18px]', active && 'text-primary')} />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{t(item.label)}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>

        {/* ── Bottom cluster: notifications, help, avatar ── */}
        <div className="mb-2 flex flex-col items-center gap-1 border-t border-nav-border pt-2">
          <div className={railButton}>
            <NotificationBell />
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(railButton, 'text-nav-muted hover:bg-nav-accent/60 hover:text-nav-foreground')}
                aria-label={t('مساعدة')}
              >
                <HelpCircle className="h-[18px] w-[18px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" className="w-64">
              <DropdownMenuLabel>{t('اختصارات لوحة المفاتيح')}</DropdownMenuLabel>
              {/* Real shortcuts the composer already implements — not a stub. */}
              <DropdownMenuItem disabled className="justify-between opacity-100">
                <span>{t('إرسال')}</span>
                <span className="numeric text-micro text-muted-foreground" dir="ltr">Enter</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="justify-between opacity-100">
                <span>{t('سطر جديد')}</span>
                <span className="numeric text-micro text-muted-foreground" dir="ltr">Shift+Enter</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="justify-between opacity-100">
                <span>{t('الردود الجاهزة')}</span>
                <span className="numeric text-micro text-muted-foreground" dir="ltr">/</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="justify-between opacity-100">
                <span>{t('ذكر زميل')}</span>
                <span className="numeric text-micro text-muted-foreground" dir="ltr">@</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/*
            Avatar with presence dot. Everything that used to be its own row on
            the wide rail — language, theme, away, sign out — lives in this menu
            now. On a 48px rail they cannot each have a row, and they are all
            per-user preferences, which is what an avatar menu is for.
          */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className={cn(railButton, 'hover:bg-nav-accent/60')} aria-label={t('المستخدم')}>
                <span className="relative flex h-7 w-7 items-center justify-center rounded-full bg-primary text-caption font-bold text-primary-foreground">
                  {(user?.name || 'م')?.charAt(0)}
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full border-2 border-nav',
                      isAway ? 'bg-warning-vivid' : 'bg-success-vivid',
                    )}
                  />
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" className="w-56">
              <DropdownMenuLabel className="leading-tight">
                <span className="block truncate">{user?.name || t('المستخدم')}</span>
                <span className="block truncate text-micro font-normal text-muted-foreground">
                  {user?.primaryTeam?.name || user?.role || ''}
                </span>
              </DropdownMenuLabel>

              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleAway} disabled={awayLoading}>
                {isAway ? <Moon className="me-2 h-4 w-4" /> : <Sun className="me-2 h-4 w-4" />}
                {isAway ? t('أنت في وضع الغياب') : t('متاح')}
              </DropdownMenuItem>

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-micro font-normal text-muted-foreground">
                {t('اللغة')}
              </DropdownMenuLabel>
              {LOCALES.map((l) => (
                <DropdownMenuItem key={l.code} onClick={() => setLocale(l.code)}>
                  <Languages className="me-2 h-4 w-4" />
                  <span className="flex-1">{l.label}</span>
                  {locale === l.code && <Check className="h-3.5 w-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-micro font-normal text-muted-foreground">
                {t('المظهر')}
              </DropdownMenuLabel>
              {THEMES.map((option) => (
                <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
                  {option.value === 'dark' ? (
                    <Moon className="me-2 h-4 w-4" />
                  ) : (
                    <SunMedium className="me-2 h-4 w-4" />
                  )}
                  <span className="flex-1">{t(option.label)}</span>
                  {theme === option.value && <Check className="h-3.5 w-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}

              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => {
                  localStorage.clear();
                  router.push('/login');
                }}
                className="text-destructive"
              >
                <LogOut className="me-2 h-4 w-4" />
                {t('تسجيل الخروج')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </TooltipProvider>
  );
}
