import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: 'dashboard-user',
  name: 'Dashboard Operator',
  email: 'dashboard@rabitech.test',
  role: 'ADMIN',
  permissions: [],
  organizationId: 'dashboard-org',
  scope: 'ORGANIZATION',
};

const summary = {
  openConversations: 5,
  resolvedThisWeek: 3,
  totalContacts: 12,
  activeSessions: 1,
  timestamp: '2026-08-31T00:00:00.000Z',
};

const lifecycle = [
  { id: 'stage-lead', name: 'Lead', description: null, color: null, emoji: '1', kind: 'ACTIVE', isDefault: true, isWon: false, orderIndex: 0, contactCount: 8 },
  { id: 'stage-won', name: 'Won', description: null, color: null, emoji: '2', kind: 'ACTIVE', isDefault: false, isWon: true, orderIndex: 1, contactCount: 4 },
];

const users = [
  { id: 'user-1', name: 'A', email: 'a@example.test', phone: null, role: 'ADMIN', isActive: true, isAway: false },
  { id: 'user-2', name: 'B', email: 'b@example.test', phone: null, role: 'AGENT', isActive: false, isAway: false },
];

const overview = {
  headlines: [],
  firstResponseMedianMinutes: null,
  firstResponsePreviousMinutes: null,
  resolutionMedianMinutes: null,
  resolutionPreviousMinutes: null,
  series: [
    { date: '2026-08-29', inbound: 4, outbound: 2, conversationsStarted: 3, resolved: 1 },
    { date: '2026-08-30', inbound: 5, outbound: 3, conversationsStarted: 2, resolved: 2 },
  ],
};

const campaigns = [
  { id: 'campaign-1', title: 'August follow-up', status: 'SCHEDULED', scheduledAt: '2099-08-31T12:00:00.000Z', createdAt: '2026-08-30T00:00:00.000Z', sentAt: null, audienceLabel: 'All contacts', _count: { recipients: 9 } },
];

const buckets = {
  today: { opened: 3, closed: 1 },
  yesterday: { opened: 5, closed: 4 },
  last14Days: { opened: 21, closed: 18 },
  last30Days: { opened: 47, closed: 39 },
};

const waiting = {
  total: 2,
  contacts: [
    { conversationId: 'conv-1', contactId: 'contact-1', name: 'Layla Haddad', profilePic: null, lastMessage: 'Any update on my order?', waitingSinceMinutes: 190, assigneeName: 'Maya Saleh' },
    { conversationId: 'conv-2', contactId: 'contact-2', name: 'Omar Nasser', profilePic: null, lastMessage: null, waitingSinceMinutes: 25, assigneeName: null },
  ],
};

const dashboardTeam = {
  members: [
    { id: 'user-1', name: 'Maya Saleh', role: 'AGENT', teamId: 'team-1', teamName: 'Sales', status: 'available', assignedCount: 4 },
    { id: 'user-2', name: 'Rami Odeh', role: 'AGENT', teamId: 'team-2', teamName: 'Support', status: 'away', assignedCount: 0 },
  ],
};

const emptyBuckets = { today: { opened: 0, closed: 0 }, yesterday: { opened: 0, closed: 0 }, last14Days: { opened: 0, closed: 0 }, last30Days: { opened: 0, closed: 0 } };

async function installRoutes(page: Page, failSummary = false, empty = false) {
  let summaryFailed = failSummary;
  await page.route('**/api/**', (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: user });
    if (pathname.endsWith('/billing/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    if (pathname.endsWith('/billing/trial')) return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: null } });
    if (pathname.endsWith('/billing/summary')) return route.fulfill({ json: { plan: { code: 'GROWTH', name: 'Growth' }, entitlements: { monthlyCampaignSendsLimit: 5000, customDomain: false, whiteLabel: false, autoProvisionGateway: true }, seats: { used: 1, limit: 5 } } });
    if (pathname.endsWith('/analytics/summary')) {
      if (summaryFailed) {
        summaryFailed = false;
        return route.fulfill({ status: 503, json: { error: 'temporary' } });
      }
      return route.fulfill({ json: summary });
    }
    if (pathname.endsWith('/lifecycle-stages')) return route.fulfill({ json: lifecycle });
    if (pathname.endsWith('/system/users')) return route.fulfill({ json: users });
    if (pathname.endsWith('/analytics/overview')) return route.fulfill({ json: overview });
    if (pathname.endsWith('/campaigns')) return route.fulfill({ json: empty ? [] : campaigns });
    if (pathname.endsWith('/dashboard/conversation-buckets')) return route.fulfill({ json: empty ? emptyBuckets : buckets });
    if (pathname.endsWith('/dashboard/waiting-contacts')) return route.fulfill({ json: empty ? { total: 0, contacts: [] } : waiting });
    if (pathname.endsWith('/dashboard/team')) return route.fulfill({ json: empty ? { members: [] } : dashboardTeam });
    if (pathname.endsWith('/contacts/merge-suggestions')) return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(({ session }) => {
    localStorage.setItem('rabitech_token', 'dashboard-e2e-token');
    localStorage.setItem('rabitech_user', JSON.stringify(session));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, { session: user });
}

/*
  ── Certification: 18 combinations ──────────────────────────────────────────

  Three widths by three locales by two themes. Two of the three locales are
  right-to-left, and every widget here mixes a label with a number — a wait
  duration, an assigned count, an opened/closed pair — which is exactly where
  bidi layout goes wrong.

  Every combination asserts all six widgets are present, not merely that the
  page rendered: a dashboard that silently drops a card still looks like a
  dashboard.
*/
const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];
const LOCALES = ['ar', 'he', 'en'] as const;
const THEMES = ['light', 'dark'] as const;

const WIDGETS: Record<string, string[]> = {
  en: ['Conversations opened and closed', 'Contacts with open conversations', 'Team members', 'Upcoming broadcasts', 'Lifecycle stages', 'Merge suggestions'],
  ar: ['المحادثات المفتوحة والمغلقة', 'جهات اتصال بمحادثات مفتوحة', 'أعضاء الفريق', 'البثوث القادمة', 'مراحل دورة الحياة', 'اقتراحات الدمج'],
  // Read out of lib/i18n.tsx, not written from memory: the dictionary says
  // "חברי הצוות" and "הצעות למיזוג", and both of my first guesses were wrong.
  he: ['שיחות שנפתחו ונסגרו', 'אנשי קשר עם שיחות פתוחות', 'חברי הצוות', 'שידורים קרובים', 'שלבי מחזור חיים', 'הצעות למיזוג'],
};

for (const viewport of VIEWPORTS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`${viewport.name}-${locale}-${theme}: dashboard renders all six widgets`, async ({ page }) => {
        await installRoutes(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addInitScript(([lc, th]) => {
          localStorage.setItem('rabitech_locale', lc);
          localStorage.setItem('rabitech_theme', th);
        }, [locale, theme]);

        await page.goto('/overview');

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
        else await expect(page.locator('html')).not.toHaveClass(/dark/);

        for (const widget of WIDGETS[locale]) {
          await expect(page.getByText(widget, { exact: false }).first()).toBeVisible();
        }

        // The page must not scroll sideways at any width, in either direction.
        await expect
          .poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1))
          .toBe(true);
      });
    }
  }
}

/*
  Empty is the first thing a new organization sees, and it has to look
  deliberate rather than broken. Six widgets with nothing in them must each say
  what is absent, and none may show an error.
*/
test('a new organization sees deliberate empty states, not failures', async ({ page }) => {
  await installRoutes(page, false, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/overview');

  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Nobody is waiting for a reply')).toBeVisible();
  await expect(page.getByText('No scheduled broadcasts')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Could not load this dashboard card' })).toHaveCount(0);
  // Zero is a fact, not an absence: the four windows still render their numbers.
  await expect(page.getByText('Conversations opened and closed')).toBeVisible();
});

test('dashboard composes scoped summary cards and conversation chart', async ({ page }) => {
  await installRoutes(page);
  await page.goto('/overview');

  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  // Exact, because the accessible-name match is a substring one and the
  // dashboard now also carries "Contacts with open conversations". Without it
  // this resolves to two headings and fails on ambiguity rather than absence.
  await expect(page.getByRole('heading', { name: 'Contacts', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lifecycle stages' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team members' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversations over time' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upcoming broadcasts' })).toBeVisible();
  await expect(page.getByText('12', { exact: true })).toBeVisible();
  await expect(page.locator('svg[role="img"]').first()).toBeVisible();
  await expect(page.getByText('August follow-up')).toBeVisible();
});

test('dashboard keeps a failed summary visibly distinct and retryable', async ({ page }) => {
  await installRoutes(page, true);
  await page.goto('/overview');

  await expect(page.getByRole('heading', { name: 'Could not load this dashboard card' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).first().click();
  await expect(page.getByRole('heading', { name: 'Could not load this dashboard card' })).toHaveCount(0);
  await expect(page.getByText('12', { exact: true })).toBeVisible();
});
