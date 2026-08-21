'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  Languages,
  LogOut,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  FileText,
  Settings,
  Users,
  UsersRound,
  ChevronRight,
  Moon,
  Sun,
  SunMedium,
  CreditCard,
  Building2,
  Workflow,
} from 'lucide-react';
import { NotificationBell } from '@/components/notification-bell';
import { useTheme, type Theme } from '@/lib/theme';
import { BrandLogo } from '@/components/brand-logo';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Respond.io information architecture: five top-level destinations.
 * Everything an admin configures lives inside Settings tabs, not in the rail —
 * agents see the four surfaces they work in, admins find the rest in one place.
 */
const NAV_ITEMS = [
  { href: '/inbox',      icon: MessageSquare,   label: 'المحادثات' },
  { href: '/contacts',   icon: Users,           label: 'جهات الاتصال' },
  { href: '/campaigns',  icon: Megaphone,       label: 'البث' },
  { href: '/automations', icon: Workflow,       label: 'الأتمتة' },
  { href: '/reports',    icon: LayoutDashboard, label: 'التقارير' },
  { href: '/settings',   icon: Settings,        label: 'الإعدادات' },
];

/** Shown only to the RabiTech platform owner, never to subscribers. */
const PLATFORM_ITEM = { href: '/platform/subscribers', icon: Building2, label: 'المشتركون' };

/** Per-user display preference. `system` follows the OS and is the default. */
const THEMES: Array<{ value: Theme; label: string }> = [
  { value: 'light', label: 'فاتح' },
  { value: 'dark', label: 'داكن' },
  { value: 'system', label: 'حسب النظام' },
];

/**
 * `open`/`onClose` drive the mobile drawer only. From `md` up the rail is
 * always a static column and these are ignored.
 */
export function AppSidebar({ open = false, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const router   = useRouter();
  const { t, locale, setLocale } = useT();
  const { theme, resolved: resolvedTheme, setTheme } = useTheme();
  const branding = useBranding();
  const [isAway, setIsAway] = useState(false);
  const [awayLoading, setAwayLoading] = useState(false);

  // Tapping a destination on a phone should dismiss the drawer, not leave it
  // covering the page the user just navigated to.
  useEffect(() => { onClose?.(); }, [pathname]);

  const user = (() => {
    try {
      return JSON.parse(localStorage.getItem('rabitech_user') || '{}');
    } catch {
      return {};
    }
  })();

  // Platform owner sees the subscriber console; subscribers never do.
  const isPlatformOwner = user.platformRole === 'OWNER' || user.scope === 'PLATFORM';
  const [viewAs, setViewAs] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { setViewAs(getViewAsOrg()); }, [pathname]);

  const exitViewAs = () => {
    setViewAsOrg(null);
    setViewAs(null);
    router.push('/platform/subscribers');
  };

  // A platform owner only has tenant pages to visit while viewing a subscriber;
  // without one every tenant endpoint refuses them, so the links would be dead.
  const navItems = isPlatformOwner
    ? (viewAs ? [...NAV_ITEMS, PLATFORM_ITEM] : [PLATFORM_ITEM])
    : NAV_ITEMS;

  useEffect(() => {
    // Sync away state from server on mount
    import('@/lib/api').then(({ default: api }) =>
      api.get('/api/auth/me').then((r) => setIsAway(!!r.data.isAway)).catch(() => {})
    );
  }, []);

  const toggleAway = async () => {
    setAwayLoading(true);
    try {
      const res = await setAgentAway(!isAway);
      setIsAway(res.isAway);
    } catch {}
    finally { setAwayLoading(false); }
  };

  return (
    <TooltipProvider delayDuration={0}>
      {/* Drawer backdrop — phones only; the rail is static from md up. */}
      {open && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          aria-hidden
        />
      )}
      <aside
        className={cn(
          'relative flex w-[220px] shrink-0 flex-col overflow-hidden',
          // The rail stays dark navy against the light workspace canvas.
          'nav-surface border-s border-nav-border',
          // Phone: slide-over anchored to the right (RTL). Desktop: static column.
          'fixed inset-y-0 right-0 z-50 transition-transform duration-200 md:static md:z-auto md:translate-x-0',
          open ? 'translate-x-0' : 'translate-x-full md:translate-x-0',
        )}
      >
        {/* ── Logo ───────────────────────────────────────── */}
        <Link
          href="/inbox"
          className="group flex items-center gap-3 border-b border-nav-border px-4 py-[18px]"
        >
          <BrandLogo size="sm" showText={false} />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-bold tracking-wide text-nav-foreground">
              {branding.productName}
            </p>
            <p className="text-[10px] text-nav-muted">{t('لوحة التحكم')}</p>
          </div>
        </Link>

        {/*
          Looking at someone else's live customer data is not a state to infer
          from context — name the subscriber and keep the way out one click away.
        */}
        {viewAs && (
          <div className="mx-3 mt-3 rounded-md border border-warning/40 bg-warning/15 px-2.5 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-warning/90">
              {t('تعرض بيانات مشترك')}
            </p>
            <p className="mt-0.5 truncate text-[12px] font-semibold text-warning" title={viewAs.name}>
              {viewAs.name}
            </p>
            <p className="mt-0.5 text-[10px] text-warning/70">{t('للقراءة فقط')}</p>
            <button
              onClick={exitViewAs}
              className="mt-1.5 w-full rounded border border-warning/40 px-2 py-1 text-[11px] font-medium text-warning transition-colors hover:bg-warning/25"
            >
              {t('إنهاء العرض')}
            </button>
          </div>
        )}

        {/* ── Nav sections ───────────────────────────────── */}
        <nav className="flex-1 overflow-y-auto py-3">
          <div className="px-3">
            {/*
              The platform owner is not a tenant: they have no organization, so
              every tenant page returns "Organization access required" for them.
              Showing those links produced a dashboard where nothing worked.
              They get the subscriber console instead.
            */}
            {navItems
              .map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(item.href + '/');
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-[6px] px-3 py-2 text-[13px] font-medium',
                      'transition-all duration-150',
                      active
                        ? 'bg-nav-accent text-nav-foreground'
                        : 'text-nav-muted hover:bg-nav-accent/60 hover:text-nav-foreground',
                    )}
                  >
                    {/* active pill — inline-start edge, so it flips with RTL */}
                    {active && (
                      <span className="absolute start-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                    )}
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0 transition-colors',
                        active ? 'text-primary' : 'text-nav-muted group-hover:text-nav-foreground',
                      )}
                    />
                    <span className="flex-1 truncate">{t(item.label)}</span>
                    {active && (
                      <ChevronRight className="h-3 w-3 shrink-0 text-primary/60" />
                    )}
                  </Link>
                );
              })}
          </div>
        </nav>

        {/* ── Footer ─────────────────────────────────────── */}
        <div className="border-t border-nav-border p-3 space-y-1">
          {/* Language picker */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'flex w-full items-center gap-3 rounded-[6px] px-3 py-2',
                  'text-[13px] font-medium text-nav-muted',
                  'transition-colors hover:bg-nav-accent/60 hover:text-nav-foreground',
                )}
              >
                <Languages className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-right">{t('اللغة')}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="left" align="end" className="w-36">
              {LOCALES.map((l) => (
                <DropdownMenuItem
                  key={l.code}
                  onClick={() => setLocale(l.code)}
                  className={cn(locale === l.code && 'bg-primary/10 text-primary')}
                >
                  {l.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Theme picker. Sits beside the language picker because both are
              per-user display preferences rather than workspace settings. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'flex w-full items-center gap-3 rounded-[6px] px-3 py-2',
                  'text-[13px] font-medium text-nav-muted',
                  'transition-colors hover:bg-nav-accent/60 hover:text-nav-foreground',
                )}
              >
                {resolvedTheme === 'dark'
                  ? <Moon className="h-4 w-4 shrink-0" />
                  : <SunMedium className="h-4 w-4 shrink-0" />}
                <span className="flex-1 text-right">{t('المظهر')}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="left" align="end" className="w-36">
              {THEMES.map((option) => (
                <DropdownMenuItem
                  key={option.value}
                  onClick={() => setTheme(option.value)}
                  className={cn(theme === option.value && 'bg-primary/10 text-primary')}
                >
                  {t(option.label)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Away toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggleAway}
                disabled={awayLoading}
                className={cn(
                  'flex w-full items-center gap-3 rounded-[6px] px-3 py-2',
                  'text-[13px] font-medium transition-colors',
                  isAway
                    ? 'bg-warning/15 text-warning hover:bg-warning/25'
                    : 'text-nav-muted hover:bg-nav-accent/60 hover:text-nav-foreground',
                )}
              >
                {isAway ? <Moon className="h-4 w-4 shrink-0" /> : <Sun className="h-4 w-4 shrink-0" />}
                <span className="flex-1 text-right">{isAway ? t('أنت في وضع الغياب') : t('متاح')}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {isAway ? t('انقر للعودة للعمل — ستُعاد المحادثات إليك') : t('انقر للدخول في وضع الغياب')}
            </TooltipContent>
          </Tooltip>

          {/* User row + logout */}
          <div className="flex items-center gap-2 rounded-[6px] px-3 py-2">
            <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
              {(user?.name || 'م')?.charAt(0)}
              {/* Away indicator dot */}
              <span className={cn(
                'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-nav',
                isAway ? 'bg-warning-vivid' : 'bg-success-vivid',
              )} />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[12px] font-semibold text-nav-foreground">
                {user?.name || t('المستخدم')}
              </p>
              <p className="truncate text-[10px] text-nav-muted">
                {user?.primaryTeam?.name || user?.role || ''}
              </p>
            </div>
            <NotificationBell />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => {
                    localStorage.clear();
                    router.push('/login');
                  }}
                  className="h-6 w-6 shrink-0 rounded text-nav-muted transition-colors hover:text-danger"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left">{t('تسجيل الخروج')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </aside>
    </TooltipProvider>
  );
}
