import { expect, test, type Page } from '@playwright/test';

const session = {
  token: 'campaigns-e2e-token',
  user: {
    id: 'campaigns-user',
    name: 'Campaigns Operator',
    email: 'campaigns@rabitech.test',
    role: 'ADMIN',
    permissions: [],
    organizationId: 'campaigns-org',
    scope: 'ORGANIZATION',
    locale: 'en',
    theme: 'light',
  },
};

const scheduledAt = new Date().toISOString();
const campaigns = [
  {
    id: 'campaign-1',
    title: 'August follow-up',
    status: 'SCHEDULED',
    scheduledAt,
    createdAt: scheduledAt,
    sentAt: null,
    audienceLabel: 'All contacts',
    _count: { recipients: 9 },
  },
];

const report = {
  campaign: {
    id: 'campaign-1',
    title: 'August follow-up',
    status: 'SENT',
    sentAt: scheduledAt,
    scheduledAt: null,
  },
  total: 9,
  counts: { pending: 0, sent: 2, delivered: 4, read: 3, failed: 0 },
  failures: [],
};

async function installRoutes(page: Page, failCampaigns = false) {
  let shouldFail = failCampaigns;
  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: session.user });
    if (pathname.endsWith('/billing/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    if (pathname.endsWith('/billing/trial')) return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: scheduledAt } });
    if (pathname.endsWith('/billing/summary')) {
      return route.fulfill({
        json: {
          plan: { code: 'GROWTH', name: 'Growth' },
          entitlements: { monthlyCampaignSendsLimit: 5000, customDomain: false, whiteLabel: false, autoProvisionGateway: true },
          seats: { used: 1, limit: 5 },
        },
      });
    }
    if (pathname.endsWith('/notifications')) return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    if (pathname === '/api/templates') return route.fulfill({ json: [] });
    if (pathname === '/api/campaigns') {
      if (shouldFail) {
        shouldFail = false;
        return route.fulfill({ status: 503, json: { error: 'temporary' } });
      }
      return route.fulfill({ json: campaigns });
    }
    if (pathname === '/api/campaigns/campaign-1/report') return route.fulfill({ json: report });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('rabitech_token', token);
    localStorage.setItem('rabitech_user', JSON.stringify(user));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, session);
}

test('broadcast list, calendar, and URL detail stay connected', async ({ page }) => {
  await installRoutes(page);
  await page.goto('/campaigns');

  await expect(page.getByRole('heading', { level: 1, name: 'Campaigns & broadcasts' })).toBeVisible();
  await expect(page.getByText('August follow-up')).toBeVisible();
  await page.getByRole('button', { name: 'Calendar view' }).click();
  await expect(page.locator('div.grid.grid-cols-7')).toHaveCount(2);
  await page.getByRole('button', { name: 'List view' }).click();
  await page.getByRole('link', { name: /August follow-up/ }).click();

  await expect(page).toHaveURL(/\/campaigns\/campaign-1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'August follow-up' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Delivery analytics' })).toBeVisible();
  await expect(page.getByText('44.4%')).toBeVisible();
});

test('broadcast failure is visibly distinct and retryable', async ({ page }) => {
  await installRoutes(page, true);
  await page.goto('/campaigns');

  await expect(page.getByRole('heading', { name: 'Could not load campaigns' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('August follow-up')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Could not load campaigns' })).toHaveCount(0);
});
