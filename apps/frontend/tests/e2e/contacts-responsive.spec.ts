import { expect, test, type Page } from '@playwright/test';

type TestSession = {
  token: string;
  user: Record<string, unknown>;
};

const rawSession = process.env.RABITECH_E2E_SESSION;

function session(): TestSession {
  if (!rawSession) {
    throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  }
  return JSON.parse(rawSession) as TestSession;
}

function profileFor(auth: TestSession, locale: 'ar' | 'he' | 'en', theme: 'light' | 'dark') {
  return {
    ...auth.user,
    locale,
    theme,
    notificationNewMessage: 'IN_APP',
    notificationAssignment: 'IN_APP',
    notificationMention: 'IN_APP',
    notificationResolution: 'IN_APP',
    notificationEscalation: 'IN_APP',
    notificationSound: true,
    twoFactorEnabled: false,
  };
}

async function mockCurrentProfile(page: Page, profile: Record<string, unknown>) {
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: profile });
    else await route.continue();
  });
}

async function mockShell(page: Page) {
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: {
    notifications: [], unreadCount: 0,
  } }));
  await page.route('**/api/billing/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/trial')) {
      return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: new Date().toISOString() } });
    }
    if (path.endsWith('/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    if (path.endsWith('/summary')) {
      return route.fulfill({ json: {
        plan: { code: 'GROWTH', name: 'Growth', monthlyPriceCents: 7900 },
        entitlements: {
          code: 'GROWTH', name: 'Growth', monthlyPriceCents: 7900,
          monthlyActiveContactsLimit: 2500, monthlyOutboundMessagesLimit: 25000,
          monthlyCampaignSendsLimit: 5000, customFieldsLimit: 25, usersLimit: 5,
          autoProvisionGateway: true, customDomain: false, whiteLabel: false,
        },
        seats: { used: 2, limit: 5, remaining: 3, atLimit: false },
        subscription: null, organization: { id: 'org-test', name: 'RabiTech Demo', status: 'ACTIVE', tier: 'GROWTH' },
        usage: {}, invoices: [], plans: [], commercial: {}, quotaDrift: [],
      } });
    }
    return route.fulfill({ json: {} });
  });
}

async function mockContacts(page: Page) {
  const contacts = [
    {
      id: 'contact-nadia', firstName: 'Nadia', lastName: 'Saleh', name: 'Nadia Saleh',
      phone: '+970599123456', email: 'nadia@example.test', language: 'ar', profilePic: null,
      countryCode: 'PS', lifecycleStage: 'Lead', assigneeId: 'settings-user',
      assignee: { name: 'Settings Operator' }, notes: 'Requested a product walkthrough.',
      contactTags: [{ tag: { name: 'VIP' } }], customFieldValues: [],
    },
    {
      id: 'contact-omar', firstName: 'Omar', lastName: 'Haddad', name: 'Omar Haddad',
      phone: '+970599654321', email: 'omar@example.test', language: 'en', profilePic: null,
      countryCode: 'PS', lifecycleStage: 'Qualified', assigneeId: null, assignee: null,
      notes: null, contactTags: [], customFieldValues: [],
    },
  ];
  await page.route('**/api/contacts**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/contacts') {
      return route.fulfill({ json: { items: contacts, pagination: { cursorId: null, hasMore: false, total: contacts.length } } });
    }
    if (request.method() === 'GET' && path === '/api/contacts/tags') {
      return route.fulfill({ json: [{ id: 'tag-vip', name: 'VIP', color: '#2563EB', source: 'MANUAL' }] });
    }
    if (request.method() === 'GET' && path === '/api/contacts/custom-fields') return route.fulfill({ json: [] });
    if (request.method() === 'GET') {
      const contact = contacts.find((item) => item.id === decodeURIComponent(path.split('/').at(-1) || ''));
      return route.fulfill(contact ? { json: contact } : { status: 404, json: { error: 'Not found' } });
    }
    if (request.method() === 'PATCH') {
      const id = decodeURIComponent(path.split('/').at(-1) || '');
      const contact = contacts.find((item) => item.id === id);
      Object.assign(contact || {}, request.postDataJSON());
      return route.fulfill(contact ? { json: contact } : { status: 404, json: { error: 'Not found' } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/segments**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/system/users**', (route) => route.fulfill({ json: [{
    id: 'settings-user', name: 'Settings Operator', email: 'operator@rabitech.test', phone: null,
    role: 'ADMIN', isActive: true, isAway: false, createdAt: '2026-08-20T12:00:00.000Z',
  }] }));
}

async function openContacts(
  page: Page,
  options: { locale: 'ar' | 'he' | 'en'; theme: 'light' | 'dark'; width: number; height: number },
) {
  const auth = session();
  const user = profileFor(auth, options.locale, options.theme);
  await page.setViewportSize({ width: options.width, height: options.height });
  await mockCurrentProfile(page, user);
  await mockShell(page);
  await mockContacts(page);
  await page.addInitScript(
    ({ token, user, locale, theme }) => {
      localStorage.setItem('rabitech_token', token);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale);
      localStorage.setItem('rabitech_theme', theme);
    },
    { token: auth.token, user, locale: options.locale, theme: options.theme },
  );
  await page.goto('/contacts');
  await expect(page).toHaveURL(/\/contacts/);
  await expect(page.locator('html')).toHaveAttribute('dir', options.locale === 'en' ? 'ltr' : 'rtl');
  if (options.theme === 'dark') {
    await expect(page.locator('html')).toHaveClass(/dark/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  }
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  await expect(page.locator('tbody tr[aria-hidden="true"]')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 },
];
const locales = ['ar', 'he', 'en'] as const;
const themes = ['light', 'dark'] as const;
const scenarios = viewports.flatMap((viewport) =>
  locales.flatMap((locale) =>
    themes.map((theme) => ({ ...viewport, locale, theme, name: `${viewport.name}-${locale}-${theme}` })),
  ),
);

for (const scenario of scenarios) {
  test(`${scenario.name}: contacts remain framed without page overflow`, async ({ page }, testInfo) => {
    await openContacts(page, scenario);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}.png`), fullPage: true });
  });
}

test('contact drawer has a reloadable URL and closes with Escape', async ({ page }) => {
  await openContacts(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });

  const dataRow = page.locator('tbody tr').filter({ has: page.locator('input[type="checkbox"]') }).first();
  await expect(dataRow).toBeVisible();
  await dataRow.click();

  await expect(page).toHaveURL(/\/contacts\?contact=[^&]+/);
  await expect(page.getByRole('dialog')).toBeVisible();
  const drawerUrl = page.url();

  await page.reload();
  await expect(page).toHaveURL(drawerUrl);
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/contacts$/);
});

test('selecting a contact replaces the list toolbar with the bulk action toolbar', async ({ page }) => {
  await openContacts(page, { locale: 'en', theme: 'light', width: 375, height: 812 });

  const firstCheckbox = page.locator('tbody input[type="checkbox"]').first();
  await firstCheckbox.check();
  await expect(page.getByRole('toolbar')).toBeVisible();
});

test('notification center switches scopes and archives without losing keyboard close', async ({ page }) => {
  const notifications = [
    { id: 'notice-1', type: 'MENTION', conversationId: null, title: 'Assigned follow-up', body: 'A teammate mentioned you.', isRead: false, archivedAt: null as string | null, createdAt: new Date().toISOString(), conversation: null },
    { id: 'notice-2', type: 'CONVERSATION_RESOLVED', conversationId: null, title: 'Conversation resolved', body: 'The customer thread is complete.', isRead: true, archivedAt: null as string | null, createdAt: new Date().toISOString(), conversation: null },
  ];

  await openContacts(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });
  await page.unroute('**/api/notifications**');
  await page.route('**/api/notifications**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === 'GET' && path.endsWith('/api/notifications')) {
      const scope = url.searchParams.get('scope') || 'new';
      const visible = notifications.filter((item) => scope === 'all' || (scope === 'archived' ? !!item.archivedAt : !item.archivedAt));
      await route.fulfill({ json: { notifications: visible, unreadCount: notifications.filter((item) => !item.archivedAt && !item.isRead).length } });
      return;
    }
    if (request.method() === 'PATCH' && path.endsWith('/archive-all')) {
      notifications.forEach((item) => { item.archivedAt = new Date().toISOString(); item.isRead = true; });
    } else if (request.method() === 'PATCH' && path.endsWith('/archive')) {
      const id = path.split('/').at(-2);
      const item = notifications.find((candidate) => candidate.id === id);
      if (item) { item.archivedAt = new Date().toISOString(); item.isRead = true; }
    } else if (request.method() === 'PATCH' && path.endsWith('/unarchive')) {
      const id = path.split('/').at(-2);
      const item = notifications.find((candidate) => candidate.id === id);
      if (item) item.archivedAt = null;
    }
    await route.fulfill({ json: { unreadCount: notifications.filter((item) => !item.archivedAt && !item.isRead).length } });
  });
  await page.reload();
  const trigger = page.getByRole('button', { name: /^Notifications/ });
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('button', { name: 'Archive', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Archived' }).click();
  await expect(page.getByText('Assigned follow-up')).toBeVisible();
  await page.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText('No notifications')).toBeVisible();

  await page.getByRole('tab', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Archive all' }).click();
  await expect(page.getByText('No notifications')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('access denied explains the boundary and offers one return action', async ({ page }) => {
  const auth = session();
  const user = profileFor(auth, 'en', 'light');
  await page.setViewportSize({ width: 375, height: 812 });
  await mockCurrentProfile(page, user);
  await mockShell(page);
  await page.addInitScript(({ token, user }) => {
    localStorage.setItem('rabitech_token', token);
    localStorage.setItem('rabitech_user', JSON.stringify(user));
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  }, { token: auth.token, user });
  await page.goto('/access-denied');

  const surface = page.getByRole('region', { name: 'You do not have access' });
  await expect(surface).toBeVisible();
  const actions = surface.getByRole('link');
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveAttribute('href', '/overview');
  await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
