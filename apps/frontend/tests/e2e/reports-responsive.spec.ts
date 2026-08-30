import { expect, test } from '@playwright/test';

const session = {
  token: 'reports-e2e-token',
  user: {
    id: 'reports-user',
    name: 'Reports Operator',
    email: 'reports@rabitech.test',
    role: 'ADMIN',
    permissions: [],
    organizationId: 'reports-org',
    scope: 'ORGANIZATION',
    locale: 'en',
    theme: 'light',
  },
};

const overview = {
  headlines: [
    { key: 'messageVolume', value: 10, previous: 8, changePct: 25 },
    { key: 'conversationsStarted', value: 4, previous: 3, changePct: 33.3 },
    { key: 'conversationsResolved', value: 3, previous: 2, changePct: 50 },
    { key: 'inbound', value: 6, previous: 5, changePct: 20 },
    { key: 'outbound', value: 4, previous: 3, changePct: 33.3 },
  ],
  firstResponseMedianMinutes: 5,
  firstResponsePreviousMinutes: 6,
  resolutionMedianMinutes: 30,
  resolutionPreviousMinutes: 35,
  series: [
    { date: '2026-08-29', inbound: 3, outbound: 2, resolved: 1 },
    { date: '2026-08-30', inbound: 3, outbound: 2, resolved: 2 },
  ],
};

const gateway = {
  sessions: [],
  outbound: { total: 4, failed: 0, failureRatePct: 0 },
  automation: { total: 4, automated: 0, automatedRatePct: 0 },
};

test('report range opens on first click and exposes shared chart actions', async ({ page }) => {
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('rabitech_token', token);
    localStorage.setItem('rabitech_user', JSON.stringify(user));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, session);

  await page.route('**/api/**', (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: session.user });
    if (pathname.endsWith('/billing/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    if (pathname.endsWith('/billing/trial')) return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: null } });
    if (pathname.endsWith('/billing/summary')) return route.fulfill({ json: { plan: { code: 'GROWTH', name: 'Growth' }, entitlements: { monthlyCampaignSendsLimit: 5000, customDomain: false, whiteLabel: false, autoProvisionGateway: true }, seats: { used: 1, limit: 5 } } });
    if (pathname.endsWith('/system/teams')) return route.fulfill({ json: [] });
    if (pathname.endsWith('/analytics/overview')) return route.fulfill({ json: overview });
    if (pathname.endsWith('/analytics/gateway')) return route.fulfill({ json: gateway });
    return route.fulfill({ json: {} });
  });

  await page.goto('/reports');
  await expect(page.getByRole('button', { name: 'Date range' })).toBeVisible();
  await page.getByRole('button', { name: 'Date range' }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(7);
  await expect(page.getByRole('menuitem', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Last month' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Last 90 days' }).click();
  await expect(page.getByRole('button', { name: 'Date range' })).toContainText('Last 90 days');

  await page.getByRole('button', { name: 'Export chart' }).click();
  await expect(page.getByRole('menuitem', { name: 'Export SVG' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Export PNG' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Export CSV' })).toBeVisible();
});
