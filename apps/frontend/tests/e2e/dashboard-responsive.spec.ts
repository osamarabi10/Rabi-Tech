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

async function installRoutes(page: Page, failSummary = false) {
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
    if (pathname.endsWith('/campaigns')) return route.fulfill({ json: campaigns });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(({ session }) => {
    localStorage.setItem('rabitech_token', 'dashboard-e2e-token');
    localStorage.setItem('rabitech_user', JSON.stringify(session));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, { session: user });
}

test('dashboard composes scoped summary cards and conversation chart', async ({ page }) => {
  await installRoutes(page);
  await page.goto('/overview');

  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();
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
