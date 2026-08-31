'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Building2,
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
} from 'lucide-react';
import { setViewAsOrg } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Navigation chrome for the platform console. Chrome only.
 *
 * This shell does not guard anything. Each platform page keeps its own 401/403
 * redirect, and the API refuses on its own terms — requirePlatformOwner and
 * requirePlatformPermission in platform.routes.ts are the boundary. A second
 * gate here would mean two places to reason about when access changes, and a
 * filtered menu is not access control in any case: these routes stay reachable
 * by typing the URL, which is fine precisely because the server says no.
 *
 * So what follows decides what is shown, never what is allowed.
 */

type PlatformSession = {
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
  /** False marks a route that exists but is a placeholder; the menu says so. */
  built?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: '/platform', label: 'Overview', description: 'Platform health and revenue', icon: LayoutDashboard, ownerOnly: true, built: true },
  { href: '/platform/organizations', label: 'Organizations', description: 'Subscriber workspaces', icon: Building2, permission: 'subscriber:read' },
  { href: '/platform/subscribers', label: 'Subscribers', description: 'Accounts and gateway status', icon: Users, permission: 'subscriber:read', built: true },
  { href: '/platform/editions', label: 'Editions', description: 'Plan catalog and entitlements', icon: BarChart3, ownerOnly: true, built: true },
  { href: '/platform/finance', label: 'Finance', description: 'Invoices and payments', icon: CreditCard, permission: 'billing:view' },
  { href: '/platform/operations', label: 'Operations', description: 'Gateway and service operations', icon: Wrench, permission: 'subscriber:read' },
  { href: '/platform/data', label: 'Data governance', description: 'Retention and data controls', icon: Database, ownerOnly: true },
  { href: '/platform/staff', label: 'Staff', description: 'Platform access and advisors', icon: Shield, ownerOnly: true, built: true },
  { href: '/platform/support', label: 'Support', description: 'Support queue and escalation', icon: HelpCircle, permission: 'subscriber:read' },
  { href: '/platform/settings', label: 'Settings', description: 'Platform defaults and policy', icon: Settings, ownerOnly: true, built: true },
  { href: '/platform/legal', label: 'Legal', description: 'Terms and privacy', icon: FileText, ownerOnly: true },
];

/**
 * Whether to render a destination.
 *
 * A null session means the answer has not been read yet, and everything is
 * shown — the same order app-sidebar.tsx settled on. Hiding first and revealing
 * later flashes a shrunken menu at an owner on every load; the other order can
 * briefly show a support user a link the server will refuse, which is the
 * cheaper mistake.
 *
 * Absent platformPermissions is treated the same way. A session stored before
 * that field shipped carries no array, and an empty sidebar is a worse answer
 * than a permissive one when the server is deciding anyway.
 */
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

  /**
   * Leaving the console.
   *
   * Clears the view-as selection along with the session. A platform user who
   * was viewing a subscriber and then signs out must not leave that subscriber
   * selected for whoever signs in next — the console would open scoped to
   * someone else's workspace with no indication why.
   *
   * Lives here rather than on a page because the sidebar is on every console
   * screen, and a way out that exists on exactly one of them is not a way out.
   */
  const signOut = () => {
    localStorage.removeItem('rabitech_token');
    localStorage.removeItem('rabitech_user');
    setViewAsOrg(null);
    router.push('/login');
  };

  // Read after mount, not during render: localStorage does not exist on the
  // server, and reading it in the component body makes the first client render
  // disagree with the server-rendered one.
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

  return (
    <div className="flex min-h-screen bg-muted text-foreground">
      <aside
        className={cn(
          'fixed inset-y-0 start-0 z-40 w-64 shrink-0 flex-col border-e border-border bg-card',
          navOpen ? 'flex' : 'hidden md:static md:flex',
        )}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-border px-5">
          <div className="rounded-md bg-primary p-2 text-primary-foreground">
            <Building2 className="h-4 w-4" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-small font-semibold">RabiTech</p>
            <p className="truncate text-caption text-muted-foreground">Owner console</p>
          </div>
        </div>

        <nav aria-label="Platform navigation" className="flex-1 overflow-y-auto p-3">
          <div className="space-y-1">
            {visibleItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2.5 text-small transition-colors',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    <span
                      className={cn(
                        'block truncate text-caption',
                        active ? 'text-primary-foreground/70' : 'text-muted-foreground/70',
                      )}
                    >
                      {item.description}
                    </span>
                  </span>
                  {!item.built && (
                    <span className="text-caption font-medium uppercase text-muted-foreground/70">
                      Planned
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="border-t border-border p-3">
          {session?.platformRole && (
            <p className="mb-1 px-3 text-caption text-muted-foreground">
              {session.platformRole === 'OWNER' ? 'Owner access' : 'Support access'}
            </p>
          )}
          <button
            type="button"
            onClick={signOut}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-small text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <LogOut className="h-4 w-4 shrink-0" aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      {navOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          className="fixed inset-0 z-30 bg-foreground/40 md:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setNavOpen(true)}
            className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Menu className="h-5 w-5" aria-hidden />
          </button>
          <span className="text-small font-semibold">Owner console</span>
        </header>
        <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
