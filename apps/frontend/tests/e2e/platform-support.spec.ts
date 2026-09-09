import { expect, test, type Page } from '@playwright/test';

const rawSession = process.env.RABITECH_E2E_SESSION;

function session() {
  if (!rawSession) throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  return JSON.parse(rawSession) as { token: string; user: Record<string, unknown> };
}

const SEARCH_RESULTS = [
  {
    id: 'org-israel',
    name: 'Israel Support Customer',
    slug: 'israel-support',
    status: 'ACTIVE',
    numbers: [{
      id: 'number-israel', label: 'Sales', phoneNumber: '+972790123456', isActive: true,
      channelKind: 'OPENWA', channelState: 'ACTIVE',
    }],
  },
  {
    id: 'org-jordan',
    name: 'Jordan Support Customer',
    slug: 'jordan-support',
    status: 'ACTIVE',
    numbers: [{
      id: 'number-jordan', label: 'Main line', phoneNumber: '+962790123456', isActive: true,
      channelKind: 'WHATSAPP_CLOUD', channelState: 'ACTIVE',
    }],
  },
  {
    id: 'org-palestine',
    name: 'Palestine Support Customer',
    slug: 'palestine-support',
    status: 'ACTIVE',
    numbers: [{
      id: 'number-palestine', label: 'Support', phoneNumber: '+970790123456', isActive: true,
      channelKind: 'OPENWA', channelState: 'ACTIVE',
    }],
  },
];

const DIAGNOSTICS = {
  capturedAt: '2026-09-09T10:30:00.000Z',
  organization: {
    id: 'org-jordan', name: 'Jordan Support Customer', slug: 'jordan-support', status: 'ACTIVE',
    createdAt: '2026-06-01T08:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z',
  },
  plan: {
    source: 'subscription', code: 'GROWTH', name: 'Growth',
    planVersionId: 'plan-version-growth-7', version: 7, priceId: 'price-growth-7',
    pricingModel: 'FIXED', billingInterval: 'MONTHLY', currency: 'USD',
    listPriceCents: 9900, effectivePriceCents: 9900,
    subscription: {
      id: 'subscription-jordan', status: 'ACTIVE', provider: 'manual',
      currentPeriodStart: '2026-09-01T00:00:00.000Z', currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      trialEndsAt: null, activatedAt: '2026-06-01T08:00:00.000Z',
    },
    override: {
      active: false, plan: null, macQuota: null, discountPercent: null,
      creditCents: 0, reason: null, expiresAt: null, expired: false,
    },
  },
  billing: {
    paymentProvider: 'manual', latestSubscriptionStatus: 'ACTIVE', suspendAt: null,
    suspendReason: null, downgradeGraceEndsAt: null, downgradeGraceReason: null,
  },
  channels: [{
    id: 'channel-jordan', kind: 'WHATSAPP_CLOUD', status: 'ACTIVE', state: 'active',
    provisioningState: 'ACTIVE', provisioningStep: null, failureStep: null,
    managedByProvisioner: false, problem: null, provisionedAt: '2026-06-01T08:10:00.000Z',
    connectedAt: '2026-06-01T08:20:00.000Z', suspendedAt: null,
    lastCheckedAt: '2026-09-09T10:25:00.000Z',
    credential: {
      status: 'ACTIVE', lastValidatedAt: '2026-09-09T10:25:00.000Z',
      displayPhoneNumber: '+962790123456', verifiedName: 'Jordan Support Customer',
      qualityRating: 'GREEN', messagingTier: 'TIER_1K',
    },
  }],
  numbers: [{
    id: 'number-jordan', label: 'Main line', phoneNumber: '+962790123456', isActive: true,
    channelId: 'channel-jordan', channelKind: 'WHATSAPP_CLOUD', state: 'active',
  }],
  lastInboundAt: '2026-09-09T09:45:00.000Z',
  recentFailures: [{
    source: 'Outbound message', occurredAt: '2026-09-09T10:10:00.000Z',
    reason: 'WhatsApp could not send the outbound message.', resolved: false,
  }],
  usagePeriod: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
  limits: [
    { capability: 'seats', label: 'Seats', current: '3', limit: '5', state: 'ok' },
    { capability: 'workspaces', label: 'Workspaces', current: '1', limit: '1', state: 'full' },
    { capability: 'active_contacts', label: 'Monthly active contacts', current: '412', limit: '2500', state: 'ok' },
    { capability: 'messages_outbound', label: 'Outbound messages', current: '830', limit: '10000', state: 'ok' },
  ],
  verdict: 'Recent WhatsApp failures need investigation.',
};

async function prepare(page: Page, width: number) {
  const auth = session();
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('rabitech_token', token);
    localStorage.setItem('rabitech_user', JSON.stringify(user));
  }, {
    token: auth.token,
    user: {
      ...auth.user,
      scope: 'PLATFORM',
      platformRole: 'SUPPORT',
      platformPermissions: ['subscriber:diagnostics'],
    },
  });

  await page.route('**/api/**', (route) => {
    const request = route.request();
    return route.fulfill({
      status: 500,
      json: { error: `Unmocked request: ${request.method()} ${new URL(request.url()).pathname}` },
    });
  });
  await page.route('**/api/platform/subscribers/search?*', (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('q') !== '0790123456') {
      return route.fulfill({ status: 400, json: { error: 'Unexpected search query' } });
    }
    return route.fulfill({ json: { results: SEARCH_RESULTS } });
  });
  await page.route('**/api/platform/subscribers/org-jordan/diagnostics', (route) =>
    route.fulfill({ json: DIAGNOSTICS }));

  await page.goto('/platform/support', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Support', exact: true })).toBeVisible();
}

for (const width of [375, 1440]) {
  test(`${width}: local phone candidates stay human-selected and diagnostics remain content-free`, async ({ page }, testInfo) => {
    test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
    await prepare(page, width);

    await page.getByLabel('Customer name or phone').fill('0790123456');
    await page.getByRole('button', { name: 'Search', exact: true }).click();

    await expect(page.getByText('+962790123456')).toBeVisible();
    await expect(page.getByText('+970790123456')).toBeVisible();
    await expect(page.getByText('+972790123456')).toBeVisible();
    await expect(page.getByText('No customer selected')).toBeVisible();

    await page.getByRole('button', { name: /Jordan Support Customer/ }).click();
    await expect(page.getByRole('status')).toContainText('Recent WhatsApp failures need investigation.');
    await expect(page.getByText('Version 7 · Pinned subscription')).toBeVisible();
    await expect(page.getByText('plan-version-growth-7')).toBeVisible();
    await expect(page.getByText('price-growth-7')).toBeVisible();
    await expect(page.getByText('WhatsApp could not send the outbound message.')).toBeVisible();
    await expect(page.getByText('SESSION_NOT_BOUND')).toHaveCount(0);
    await expect(page.getByText(/Private WhatsApp sentinel/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /View workspace/i })).toHaveCount(0);

    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(horizontalOverflow).toBeLessThanOrEqual(1);

    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`platform-support-${width}`, { body: screenshot, contentType: 'image/png' });
  });
}
