'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Building2,
  ChevronRight,
  CreditCard,
  Database,
  FileText,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Shield,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { setViewAsOrg } from '@/lib/api';
import { cn } from '@/lib/utils';

type PlatformSession = {
  name?: string;
  email?: string;
  platformRole?: 'OWNER' | 'SUPPORT';
  platformPermissions?: string[];
};

type NavItem = {
  href: string;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
  ownerOnly?: boolean;
  permission?: string;
  built?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/platform', label: 'Overview', description: 'Health, revenue, and risk', icon: LayoutDashboard, ownerOnly: true, built: true },
  { href: '/platform/subscribers', label: 'Subscribers', description: 'Accounts and gateway fleet', icon: Users, permission: 'subscriber:diagnostics', built: true },
  { href: '/platform/editions', label: 'Editions', description: 'Plan catalogue and quotas', icon: BarChart3, ownerOnly: true, built: true },
  { href: '/platform/finance', label: 'Finance', description: 'Invoices and payments', icon: CreditCard, permission: 'billing:view' },
  { href: '/platform/operations', label: 'Operations', description: 'Gateway cluster and logs', icon: Wrench, permission: 'subscriber:diagnostics' },
  { href: '/platform/data', label: 'Data governance', description: 'Retention and privacy controls', icon: Database, ownerOnly: true },
  { href: '/platform/staff', label: 'Staff', description: 'Platform access and advisors', icon: Shield, ownerOnly: true, built: true },
  { href: '/platform/support', label: 'Support', description: 'Customer diagnostics', icon: HelpCircle, permission: 'subscriber:diagnostics', built: true },
  { href: '/platform/settings', label: 'Settings', description: 'Platform defaults and policy', icon: Settings, ownerOnly: true, built: true },
  { href: '/platform/legal', label: 'Legal', description: 'Terms and compliance', icon: FileText, ownerOnly: true },
];

/** Navigation visibility is presentation; every route remains server-authorized. */
function canSee(item: NavItem, session: PlatformSession | null) {
  if (!session) return true;
  if (session.platformRole === 'OWNER') return true;
  if (item.ownerOnly) return false;
  if (!item.permission) return true;
  if (!Array.isArray(session.platformPermissions)) return true;
  return session.platformPermissions.includes(item.permission);
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const signOut = () => {
    localStorage.removeItem('rabitech_token');
    localStorage.removeItem('rabitech_user');
    setViewAsOrg(null);
    router.push('/login');
  };

  useEffect(() => {
    try {
      setSession(JSON.parse(localStorage.getItem('rabitech_user') || '{}'));
    } catch {
      setSession({});
    }
  }, []);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  const visibleItems = useMemo(() => NAV_ITEMS.filter((item) => canSee(item, session)), [session]);

  const currentNav = useMemo(() => {
    return (
      visibleItems.find(
        (item) => item.href === pathname || (item.href !== '/platform' && pathname.startsWith(item.href))
      ) || visibleItems[0]
    );
  }, [visibleItems, pathname]);

  return (
    <div className="flex min-h-screen bg-background text-foreground selection:bg-primary/20">
      <aside
        className={cn(
          'fixed inset-y-0 start-0 z-40 w-64 shrink-0 flex-col border-e border-border bg-card transition-shadow',
          navOpen ? 'flex shadow-xl' : 'hidden md:flex',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-border px-5">
          <Link href="/platform" className="group flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
              <Building2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-foreground">RabiTech</p>
              <p className="truncate font-mono text-micro uppercase text-muted-foreground">Platform console</p>
            </div>
          </Link>

          {navOpen && (
            <button
              type="button"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent md:hidden"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>

        <nav aria-label="Platform navigation" className="flex-1 space-y-1 overflow-y-auto p-3">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === '/platform'
                ? pathname === '/platform'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex items-center gap-3 rounded-md px-3 py-2.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary font-semibold text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Icon
                  className={cn(
                    'h-4 w-4 shrink-0',
                    active ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground',
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{item.label}</span>
                  <span
                    className={cn(
                      'block truncate text-[11px]',
                      active ? 'text-primary-foreground/80' : 'text-muted-foreground/70',
                    )}
                  >
                    {item.description}
                  </span>
                </span>
                {!item.built && (
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-muted-foreground">
                    Planned
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-2 border-t border-border bg-muted/20 p-3">
          <div className="flex items-center gap-2.5 px-2 py-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-xs">
              {session?.name ? session.name.slice(0, 2).toUpperCase() : 'OW'}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-foreground">
                {session?.name || 'Platform Owner'}
              </p>
              <p className="truncate font-mono text-[10px] text-muted-foreground">
                {session?.platformRole === 'OWNER' ? 'Owner access' : 'Support access'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/40 backdrop-blur-sm md:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col md:ms-64">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b border-border bg-card/95 px-4 shadow-sm backdrop-blur-md sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setNavOpen(true)}
              className="rounded-md p-1.5 text-muted-foreground hover:bg-accent md:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>

            <nav aria-label="Platform breadcrumb" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Link href="/platform" className="hover:text-foreground transition-colors">
                Platform
              </Link>
              <ChevronRight className="h-3 w-3 opacity-40" aria-hidden />
              <span aria-current="page" className="font-semibold text-foreground">{currentNav.label}</span>
            </nav>
          </div>

          <div className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <Shield className="h-3.5 w-3.5" aria-hidden />
            <span>{session?.platformRole === 'SUPPORT' ? 'Support access' : 'Owner access'}</span>
          </div>
        </header>

        <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
