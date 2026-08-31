import { expect, test, type Page, type Route } from '@playwright/test';

const user = {
  id: 'growth-user',
  name: 'Growth Operator',
  email: 'growth@rabitech.test',
  role: 'ADMIN',
  permissions: ['contact:read'],
  organizationId: 'growth-org',
  scope: 'ORGANIZATION',
};

const sessions = [
  {
    id: 'session-growth',
    sessionName: 'growth-whatsapp',
    label: 'Growth WhatsApp',
    connected: true,
    connectionStatus: 'CONNECTED',
    phoneNumber: '972501234567',
    teamId: null,
    isActive: true,
    isActiveChannel: true,
  },
];

const branding = {
  productName: 'RabiTech Demo',
  logoUrl: null,
  faviconUrl: null,
  primaryHsl: '262 83% 63%',
  accentHsl: '195 90% 60%',
  defaultLocale: 'ar',
  direction: 'rtl',
  customDomain: null,
  customFooter: null,
  tier: 'GROWTH',
  footerText: 'Powered by RabiTech',
  canCustomizeFooter: false,
  customDomainVerificationToken: null,
  customDomainVerifiedAt: null,
  customDomainVerificationRecord: null,
  customDomainVerified: false,
};

const capabilities = {
  capabilities: {
    kind: 'OPENWA',
    requiresServiceWindow: false,
    supportsTemplates: false,
    supportsQrPairing: true,
    maxUniqueRecipientsPer24h: null,
    canInitiateConversations: true,
    messagingTier: null,
    qualityRating: null,
  },
  code: null,
  message: null,
};

async function prepare(page: Page, options: { empty?: boolean; failFirst?: boolean } = {}) {
  let sessionFailed = options.failFirst === true;
  await page.route('**/api/**', async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/auth/me')) return route.fulfill({ json: { ...user, locale: 'en', theme: 'light' } });
    if (pathname.endsWith('/billing/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    if (pathname.endsWith('/billing/trial')) return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: null } });
    if (pathname.endsWith('/billing/summary')) return route.fulfill({ json: { plan: { code: 'GROWTH', name: 'Growth' }, entitlements: { monthlyCampaignSendsLimit: 5000, customDomain: false, whiteLabel: false, autoProvisionGateway: true }, seats: { used: 1, limit: 5 } } });
    if (pathname.endsWith('/system/sessions')) {
      if (sessionFailed) {
        sessionFailed = false;
        return route.fulfill({ status: 503, json: { error: 'temporary' } });
      }
      return route.fulfill({ json: options.empty ? [] : sessions });
    }
    if (pathname.endsWith('/branding/current')) return route.fulfill({ json: branding });
    if (pathname.endsWith('/channels/capabilities')) return route.fulfill({ json: capabilities });
    if (pathname.endsWith('/growth/qr')) return route.fulfill({ json: { dataUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><rect width="280" height="280" fill="white"/><path d="M10 10h80v80H10zM190 10h80v80h-80zM10 190h80v80H10zM120 120h40v40h-40z"/></svg>' } });
    if (pathname.endsWith('/notifications/unread-count')) return route.fulfill({ json: { count: 0 } });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(({ session }) => {
    localStorage.setItem('rabitech_token', 'growth-e2e-token');
    localStorage.setItem('rabitech_user', JSON.stringify(session));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, { session: user });
}

test('Growth tools expose click-to-chat, QR, widget preview, domain, and attribution states', async ({ page }) => {
  await prepare(page);
  await page.goto('/growth');

  await expect(page.getByRole('heading', { level: 1, name: 'Turn visits into conversations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preview', exact: true })).toBeVisible();
  await expect(page.locator('#growth-session')).toHaveValue('session-growth');
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();

  await page.getByRole('button', { name: 'QR code' }).click();
  await expect(page.getByRole('img', { name: 'QR code to open a WhatsApp chat' })).toBeVisible();

  await page.getByRole('button', { name: 'Chat widget' }).click();
  await expect(page.getByText('Preview only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(page.getByText('No verified public domain')).toBeVisible();
  await expect(page.locator('#growth-attribution-title').locator('..').getByText('Powered by RabiTech', { exact: true })).toBeVisible();
});

test('Growth tools distinguish a missing WhatsApp number from a request error', async ({ page }) => {
  await prepare(page, { empty: true });
  await page.goto('/growth');
  await expect(page.getByRole('heading', { name: 'No WhatsApp number is available' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Could not load Growth tools' })).toHaveCount(0);
});

test('Growth tools expose a retry for a failed session request', async ({ page }) => {
  await prepare(page, { failFirst: true });
  await page.goto('/growth');
  await expect(page.getByRole('heading', { name: 'Could not load Growth tools' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a tool' })).toBeVisible();
});
