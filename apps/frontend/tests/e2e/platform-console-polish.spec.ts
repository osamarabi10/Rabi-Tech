import { expect, test, type Page } from '@playwright/test';

type DisplayOptions = {
  width: 375 | 768 | 1440;
  locale: 'ar' | 'he' | 'en';
  theme: 'light' | 'dark';
};

const rawSession = process.env.RABITECH_E2E_SESSION;

function session() {
  if (!rawSession) throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  return JSON.parse(rawSession) as { token: string; user: Record<string, unknown> };
}

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const SUBSCRIBERS = [
  {
    id: 'org-jordan',
    name: 'Jordan Dental Group',
    slug: 'jordan-dental',
    status: 'ACTIVE',
    tier: 'GROWTH',
    emailVerifiedAt: iso(-120 * DAY),
    downgradeGraceEndsAt: null,
    suspendAt: null,
    suspendReason: null,
    planOverride: null,
    overrideExpiresAt: null,
    subscriptions: [{
      planCode: 'GROWTH',
      status: 'ACTIVE',
      provider: 'manual',
      currentPeriodEnd: iso(20 * DAY),
      trialEndsAt: null,
    }],
    createdAt: iso(-180 * DAY),
    _count: { users: 8, whatsappSessions: 1, workspaces: 3 },
    workspaceCount: 3,
    lastInboundAt: iso(-2 * DAY),
    overLimit: false,
    overLimitReasons: [],
    channels: [{
      status: 'ACTIVE',
      provisioningState: 'ACTIVE',
      provisioningStep: null,
      failureReason: null,
      failureStep: null,
      managedByProvisioner: true,
      apiPort: 3101,
      deploymentName: 'tenant-jordan',
      provisionedAt: iso(-160 * DAY),
    }],
    invoices: [],
  },
  {
    id: 'org-cedar',
    name: 'Cedar Studio',
    slug: 'cedar-studio',
    status: 'ACTIVE',
    tier: 'STANDARD',
    emailVerifiedAt: iso(-14 * DAY),
    downgradeGraceEndsAt: null,
    suspendAt: null,
    suspendReason: null,
    planOverride: null,
    overrideExpiresAt: null,
    subscriptions: [{
      planCode: 'STANDARD',
      status: 'TRIALING',
      provider: 'manual',
      currentPeriodEnd: iso(12 * 60 * 60 * 1000),
      trialEndsAt: iso(12 * 60 * 60 * 1000),
    }],
    createdAt: iso(-10 * DAY),
    _count: { users: 2, whatsappSessions: 1, workspaces: 1 },
    workspaceCount: 1,
    lastInboundAt: iso(-1 * DAY),
    overLimit: false,
    overLimitReasons: [],
    channels: [{
      status: 'PENDING',
      provisioningState: 'AWAITING_QR',
      provisioningStep: 'PAIR_DEVICE',
      failureReason: null,
      failureStep: null,
      managedByProvisioner: true,
      apiPort: 3102,
      deploymentName: 'tenant-cedar',
      provisionedAt: null,
    }],
    invoices: [],
  },
  {
    id: 'org-northstar',
    name: 'Northstar Retail',
    slug: 'northstar-retail',
    status: 'SUSPENDED',
    tier: 'BUSINESS',
    emailVerifiedAt: iso(-300 * DAY),
    downgradeGraceEndsAt: null,
    suspendAt: iso(-1 * DAY),
    suspendReason: 'Payment failed',
    planOverride: null,
    overrideExpiresAt: null,
    subscriptions: [{
      planCode: 'BUSINESS',
      status: 'PAST_DUE',
      provider: 'manual',
      currentPeriodEnd: iso(-2 * DAY),
      trialEndsAt: null,
    }],
    createdAt: iso(-360 * DAY),
    _count: { users: 15, whatsappSessions: 1, workspaces: 5 },
    workspaceCount: 5,
    lastInboundAt: iso(-25 * DAY),
    overLimit: false,
    overLimitReasons: [],
    channels: [{
      status: 'FAILED',
      provisioningState: 'FAILED',
      provisioningStep: 'START_CONTAINER',
      failureReason: 'Gateway did not answer its health check',
      failureStep: 'START_CONTAINER',
      managedByProvisioner: true,
      apiPort: 3103,
      deploymentName: 'tenant-northstar',
      provisionedAt: iso(-340 * DAY),
    }],
    invoices: [{ id: 'inv-open', status: 'OPEN', amountDueCents: 14900 }],
  },
];

const EDITIONS = [
  {
    id: 'plan-standard',
    code: 'STANDARD',
    name: 'Standard',
    planVersionId: 'standard-v2',
    version: 2,
    priceId: 'price-standard-v2',
    monthlyPriceCents: 4900,
    currency: 'USD',
    isActive: true,
    archivedAt: null,
    offerable: true,
    unavailableReason: null,
    unavailableDetail: null,
    provisionsForbiddenChannel: false,
    pricingModel: 'FIXED',
    billingInterval: 'MONTHLY',
    sortOrder: 1,
    monthlyActiveContactsLimit: 500,
    monthlyOutboundMessagesLimit: 2500,
    monthlyCampaignSendsLimit: 500,
    customFieldsLimit: 10,
    usersLimit: 5,
    workflowsLimit: 3,
    campaignRateMax: 30,
    campaignRateDurationMs: 60_000,
    customDomain: false,
    whiteLabel: false,
    maskContactDetails: false,
    autoProvisionGateway: true,
    allowedChannels: ['OPENWA'],
    scheduledChanges: null,
    scheduledFrom: null,
  },
  {
    id: 'plan-growth',
    code: 'GROWTH',
    name: 'Growth',
    planVersionId: 'growth-v4',
    version: 4,
    priceId: 'price-growth-v4',
    monthlyPriceCents: 9900,
    currency: 'USD',
    isActive: true,
    archivedAt: null,
    offerable: false,
    unavailableReason: 'CHANNEL_NOT_OPERATIONAL',
    unavailableDetail: 'Cloud API readiness has not been certified.',
    provisionsForbiddenChannel: false,
    pricingModel: 'FIXED',
    billingInterval: 'MONTHLY',
    sortOrder: 2,
    monthlyActiveContactsLimit: 2500,
    monthlyOutboundMessagesLimit: 15000,
    monthlyCampaignSendsLimit: 5000,
    customFieldsLimit: 50,
    usersLimit: 15,
    workflowsLimit: 15,
    campaignRateMax: 60,
    campaignRateDurationMs: 60_000,
    customDomain: true,
    whiteLabel: false,
    maskContactDetails: false,
    autoProvisionGateway: false,
    allowedChannels: ['CLOUD_API'],
    scheduledChanges: { monthlyPriceCents: 10900 },
    scheduledFrom: iso(7 * DAY),
  },
];

const BILLING_SUMMARY = {
  mrrCents: 24800,
  activeSubscriptions: 2,
  trials: { open: 1, expired: 0, potentialCents: 4900 },
  byTier: { STANDARD: 1, GROWTH: 1, BUSINESS: 1 },
};

async function installSession(page: Page, options: DisplayOptions) {
  const auth = session();
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.addInitScript(
    ({ token, user, locale, theme }) => {
      localStorage.setItem('rabitech_token', token);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale);
      localStorage.setItem('rabitech_theme', theme);
    },
    {
      token: auth.token,
      user: {
        ...auth.user,
        name: 'Platform Owner',
        email: 'owner@rabitech.test',
        scope: 'PLATFORM',
        platformRole: 'OWNER',
        platformPermissions: ['subscriber:diagnostics', 'subscriber:view-as', 'billing:view'],
        locale: options.locale,
        theme: options.theme,
      },
      locale: options.locale,
      theme: options.theme,
    },
  );
}

async function installRoutes(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Unmocked API route' } }));
  await page.route('**/api/platform/billing/summary', (route) => route.fulfill({ json: BILLING_SUMMARY }));
  await page.route('**/api/platform/gateway/health', (route) => route.fulfill({ json: { latest: [], alerts: [] } }));
  await page.route('**/api/platform/subscribers/*/usage', (route) => route.fulfill({
    json: {
      asOf: iso(0),
      items: [
        { metric: 'active_contacts', current: 120, limit: 500 },
        { metric: 'messages_outbound', current: 640, limit: 2500 },
        { metric: 'campaign_sends', current: 80, limit: 500 },
      ],
    },
  }));
  await page.route('**/api/platform/subscribers', (route) => route.fulfill({ json: SUBSCRIBERS }));
  await page.route('**/api/platform/editions', (route) => route.fulfill({ json: { editions: EDITIONS } }));
}

async function prepare(page: Page, options: DisplayOptions) {
  await installSession(page, options);
  await installRoutes(page);
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scroll,
    `page width ${dimensions.scroll}px must fit viewport ${dimensions.client}px`,
  ).toBeLessThanOrEqual(dimensions.client + 1);
}

for (const width of [375, 768, 1440] as const) {
  for (const locale of ['ar', 'he', 'en'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      test(`${width}/${locale}/${theme}: overview, Editions, and Subscribers form one responsive console`, async ({ page }) => {
        test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
        await prepare(page, { width, locale, theme });

        await page.goto('/platform', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Gateway fleet' })).toContainText('1 active');
        await expectNoPageOverflow(page);

        await page.goto('/platform/editions', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('group', { name: 'Catalogue view' })).toBeVisible();
        await expect(page.getByText('Current version 4', { exact: true })).toBeVisible();
        await expectNoPageOverflow(page);

        await page.goto('/platform/subscribers', { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('searchbox', { name: 'Search subscribers' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Platform breadcrumb' })).toContainText('Subscribers');
        const planFilterBox = await page.getByLabel('Subscriber plan').boundingBox();
        expect(planFilterBox, 'subscriber plan filter must have a rendered box').not.toBeNull();
        expect(
          (planFilterBox?.x ?? 0) + (planFilterBox?.width ?? 0),
          'subscriber plan filter must not be clipped by the viewport',
        ).toBeLessThanOrEqual(width);
        await expectNoPageOverflow(page);
      });
    }
  }
}

test('overview reports exact gateway states and opens a read-only subscriber drawer', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });
  await page.goto('/platform', { waitUntil: 'domcontentloaded' });

  const fleet = page.getByRole('region', { name: 'Gateway fleet' });
  await expect(fleet).toContainText('1 active');
  await expect(fleet).toContainText('1 awaiting pairing');
  await expect(fleet).toContainText('1 failed');

  await page.getByRole('button', { name: 'Inspect Northstar Retail: Gateway failures' }).click();
  const drawer = page.getByRole('dialog', { name: 'Northstar Retail' });
  await expect(drawer).toContainText('Gateway did not answer its health check');
  await expect(drawer).toContainText('BUSINESS');
  await expect(drawer.getByText('Support Impersonation')).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /Manage \/ View/ })).toHaveCount(0);
});

test('only the current platform destination is marked active', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });
  await page.goto('/platform/subscribers', { waitUntil: 'domcontentloaded' });

  const navigation = page.getByRole('navigation', { name: 'Platform navigation' });
  await expect(navigation.getByRole('link', { name: /Subscribers/ })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('link', { name: /Overview/ })).not.toHaveAttribute('aria-current', 'page');
});

test('subscriber discovery accepts name or slug and composes status with plan', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });
  await page.goto('/platform/subscribers', { waitUntil: 'domcontentloaded' });

  const search = page.getByRole('searchbox', { name: 'Search subscribers' });
  await expect(search).toBeVisible();
  await expect(page.getByRole('article', { name: 'Jordan Dental Group' })).toContainText('Managed gateway');
  await search.fill('northstar-retail');
  await expect(page.getByText('Northstar Retail')).toBeVisible();
  await expect(page.getByText('Jordan Dental Group')).toHaveCount(0);

  await search.fill('');
  await page.getByLabel('Subscriber status').selectOption('ACTIVE');
  await page.getByLabel('Subscriber plan').selectOption('GROWTH');
  await expect(page.getByText('Jordan Dental Group')).toBeVisible();
  await expect(page.getByText('Cedar Studio')).toHaveCount(0);
  await expect(page.getByText('Northstar Retail')).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Showing 1 of 3');
});

test('edition attention is derived from offerability and inert AI token ceilings stay omitted', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });
  await page.goto('/platform/editions', { waitUntil: 'domcontentloaded' });

  const attention = page.getByRole('button', { name: /Needs attention/ });
  await expect(attention).toBeVisible();
  await attention.click();
  await expect(page.getByRole('article', { name: 'Growth edition' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Standard edition' })).toHaveCount(0);
  await expect(page.getByText('Cloud API readiness has not been certified.')).toBeVisible();
  await expect(page.getByText(/AI.*token|token.*AI/i)).toHaveCount(0);
});

test('marking payment failed requires confirmation before the request is sent', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });
  let calls = 0;
  await page.route('**/api/platform/subscribers/org-jordan/billing/mark-failed', (route) => {
    calls += 1;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/platform/subscribers', { waitUntil: 'domcontentloaded' });

  await page.getByTitle('Actions').first().click();
  await page.getByRole('menuitem', { name: 'Mark payment failed' }).click();
  await expect.poll(() => calls).toBe(0);
  const dialog = page.getByRole('dialog', { name: 'Mark payment failed' });
  await expect(dialog).toContainText('suspends service immediately');
  await dialog.getByRole('button', { name: 'Mark payment failed' }).click();
  await expect.poll(() => calls).toBe(1);
});
