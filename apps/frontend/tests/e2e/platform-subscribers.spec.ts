import { expect, test, type Page } from '@playwright/test';

/**
 * Certification for the platform operating table.
 *
 * 18 combinations of 375/768/1440 x ar/he/en x light/dark, the same bar every
 * other certified screen meets.
 *
 * The locale axis is not decoration here. The platform console is deliberately
 * English and deliberately LTR — `app/platform/layout.tsx` pins `dir="ltr"`
 * because an owner whose own organization is Arabic inherited `dir="rtl"` around
 * English text, and `truncate` then clipped the *start* of every sidebar label.
 * Running the matrix across three operator locales is what keeps that fixed.
 *
 * ## What is being certified
 *
 * The counted header and the filter chips must agree with the rows beneath
 * them. They are computed from one set of predicates in the page, so a
 * disagreement means the predicates were forked — and the header is the only
 * number on the screen nobody can check by looking, which is exactly why it is
 * the one that must not lie.
 *
 * The fixture gives each subscriber exactly ONE reason to be at risk, so every
 * chip count is unambiguous: if two chips both showed the same row, a count of
 * "1" could be produced by the wrong predicate and still read correct.
 */

type DisplayOptions = { locale: 'ar' | 'he' | 'en'; theme: 'light' | 'dark'; width: number };

const rawSession = process.env.RABITECH_E2E_SESSION;
function session() {
  if (!rawSession) throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  return JSON.parse(rawSession) as { token: string; user: Record<string, unknown> };
}

const WIDTHS = [375, 768, 1440] as const;
const LOCALES = ['ar', 'he', 'en'] as const;
const THEMES = ['light', 'dark'] as const;

const DAY = 86_400_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** A subscriber with nothing wrong, then one per risk. */
function subscriber(overrides: Record<string, unknown>) {
  return {
    id: 'org-x',
    name: 'Org X',
    slug: 'org-x',
    status: 'ACTIVE',
    tier: 'BUSINESS',
    emailVerifiedAt: iso(-30 * DAY),
    downgradeGraceEndsAt: null,
    suspendAt: null,
    suspendReason: null,
    planOverride: null,
    overrideExpiresAt: null,
    subscriptions: [{
      planCode: 'BUSINESS', status: 'ACTIVE', provider: 'manual',
      currentPeriodEnd: iso(20 * DAY), trialEndsAt: null,
    }],
    createdAt: iso(-90 * DAY),
    _count: { users: 3, whatsappSessions: 1, workspaces: 2 },
    workspaceCount: 2,
    // Recent, so nothing accidentally lands in the quiet bucket. A fixture
    // where two risks overlap cannot tell a right count from a lucky one.
    lastInboundAt: iso(-1 * DAY),
    overLimit: false,
    overLimitReasons: [] as string[],
    channels: [{
      status: 'ACTIVE',
      provisioningState: 'ACTIVE',
      provisioningStep: null,
      failureReason: null,
      failureStep: null,
      managedByProvisioner: true,
      apiPort: 3101,
      deploymentName: 'tenant-x',
      provisionedAt: iso(-60 * DAY),
    }],
    invoices: [],
    ...overrides,
  };
}

const SUBSCRIBERS = [
  subscriber({ id: 'org-calm', name: 'Calm Trading', slug: 'calm' }),
  subscriber({
    id: 'org-ending', name: 'Ending Soon', slug: 'ending',
    subscriptions: [{
      planCode: 'STANDARD', status: 'TRIALING', provider: 'manual',
      currentPeriodEnd: iso(3 * DAY), trialEndsAt: iso(3 * DAY),
    }],
  }),
  subscriber({
    id: 'org-full', name: 'Full House', slug: 'full',
    workspaceCount: 5, _count: { users: 3, whatsappSessions: 1, workspaces: 5 },
    overLimit: true, overLimitReasons: ['workspaces'],
  }),
  subscriber({
    id: 'org-dropped', name: 'Dropped Line', slug: 'dropped',
    channels: [{
      status: 'ACTIVE', provisioningState: 'AWAITING_QR', provisioningStep: 'PAIR_DEVICE',
      failureReason: null, failureStep: null, managedByProvisioner: true,
      apiPort: 3102, deploymentName: 'tenant-dropped',
      // Was built and working once: that is what makes this a disconnection
      // rather than an onboarding that never finished.
      provisionedAt: iso(-45 * DAY),
    }],
  }),
  subscriber({ id: 'org-silent', name: 'Silent Partner', slug: 'silent', lastInboundAt: iso(-30 * DAY) }),
];

async function prepare(page: Page, options: DisplayOptions) {
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
      // A platform OWNER, and an operator whose OWN locale is the one under
      // test — which is the condition that produced the RTL console bug.
      user: {
        ...auth.user,
        scope: 'PLATFORM',
        platformRole: 'OWNER',
        platformPermissions: ['subscriber:diagnostics', 'billing:view'],
        locale: options.locale,
        theme: options.theme,
      },
      locale: options.locale,
      theme: options.theme,
    },
  );

  // Catch-all first, specific routes after. An unmocked call 401s and the
  // interceptor sends the whole matrix to /login — the failure that once made
  // eighteen combinations pass while testing nothing.
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/platform/subscribers', (route) => route.fulfill({ json: SUBSCRIBERS }));
  await page.route('**/api/platform/subscribers/*/usage', (route) => route.fulfill({
    json: { asOf: null, items: [] },
  }));

  await page.goto('/platform/subscribers', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Subscribers' })).toBeVisible();
}

function tile(page: Page, label: string) {
  return page.locator('dl div').filter({ hasText: label }).locator('dd');
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`${width}/${locale}/${theme}: the header counts what the chips filter`, async ({ page }) => {
        test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
        await prepare(page, { width, locale, theme });

        // The shape of the business, before any row is read.
        await expect(tile(page, 'Total')).toHaveText('5');
        await expect(tile(page, 'Active')).toHaveText('5');
        await expect(tile(page, 'In trial')).toHaveText('1');
        await expect(tile(page, 'At risk')).toHaveText('4');

        // One reason each, so a chip count of 1 can only come from its own rule.
        for (const label of ['Trial ending ≤ 7d', 'Over a limit', 'Channel disconnected', 'No inbound ≥ 14d']) {
          await expect(page.getByRole('button', { name: new RegExp(label) })).toContainText('1');
        }

        // Filtering narrows, and says what it hid.
        await page.getByRole('button', { name: /Over a limit/ }).click();
        await expect(page.getByText('Full House')).toBeVisible();
        await expect(page.getByText('Calm Trading')).toHaveCount(0);
        await expect(page.getByRole('status')).toContainText('Showing 1 of 5');

        // Chips combine by narrowing, never by widening: nothing is both over a
        // limit and silent, so the intersection is empty — and an empty filter
        // result must not read as an empty console.
        await page.getByRole('button', { name: /No inbound ≥ 14d/ }).click();
        await expect(page.getByText('No subscribers match these filters')).toBeVisible();
        await expect(page.getByText('Full House')).toHaveCount(0);

        await page.getByRole('button', { name: 'Clear' }).click();
        await expect(page.getByText('Calm Trading')).toBeVisible();
        await expect(page.getByText('Silent Partner')).toBeVisible();
      });

      test(`${width}/${locale}/${theme}: the console stays English and LTR`, async ({ page }) => {
        test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
        await prepare(page, { width, locale, theme });

        /*
          The operator's own locale must not reach the console. Two of the three
          are RTL, and the failure is not a missing translation — it is
          `truncate` clipping the start of every sidebar label, so the screen
          stays readable-looking while saying the wrong halves of words.
        */
        const shell = page.locator('div[dir="ltr"]').first();
        await expect(shell).toBeVisible();

        /*
          Below `md` the sidebar is `hidden md:flex`, so its links are not in the
          accessibility tree at 375 and asserting on them directly would pass by
          absence rather than by correctness. Open it first — which also asserts
          the console is navigable on a phone, since an owner reading this screen
          on one still has to be able to leave it.
        */
        const opener = page.getByRole('button', { name: 'Open navigation' });
        if (await opener.isVisible()) await opener.click();
        await expect(page.getByRole('navigation', { name: 'Platform navigation' })).toBeVisible();

        // The retired route is retired: one question, one nav entry. The
        // organizations placeholder was a second door to this same screen.
        await expect(page.getByRole('link', { name: /^Organizations/ })).toHaveCount(0);
        // The control. Without it, a green above could mean "no Organizations
        // entry" or "this locator matches no nav link at all".
        await expect(page.getByRole('link', { name: /Subscribers/ })).toHaveCount(1);
      });
    }
  }
}

test('view-as requires a substantive reason and expires the tab grant', async ({ page }) => {
  test.skip(!rawSession, 'RABITECH_E2E_SESSION is required for authenticated UI tests.');
  const auth = session();
  await prepare(page, { width: 1440, locale: 'en', theme: 'light' });

  // This proof enters the real inbox after the grant is issued. Reuse the
  // object-shaped contracts from the inbox suite; prepare's [] catch-all is
  // intentionally unsuitable for endpoints such as billing summary.
  await page.route('**/api/billing/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/summary')) {
      return route.fulfill({ json: { plan: { code: 'GROWTH', name: 'Growth' }, status: 'ACTIVE' } });
    }
    if (path.endsWith('/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/system/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me**', (route) =>
    route.fulfill({ json: {
      ...auth.user,
      scope: 'PLATFORM',
      platformRole: 'OWNER',
      platformPermissions: ['subscriber:diagnostics', 'billing:view'],
      locale: 'en',
      theme: 'light',
      isAway: false,
    } }));
  await page.route('**/api/contacts/blocked', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/conversations**', (route) => route.fulfill({ json: [] }));

  let requestBody: Record<string, unknown> | null = null;
  await page.route('**/api/platform/subscribers/org-calm/view-as', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      json: {
        organization: { id: 'org-calm', name: 'Calm Trading' },
        accessToken: 'signed-platform-view-token',
        // Short only in this browser proof. Production issuance is pinned to
        // 15 minutes by the backend harness above.
        expiresAt: new Date(Date.now() + 8_000).toISOString(),
        durationSeconds: 15 * 60,
      },
    });
  });

  await page.getByRole('button', { name: 'View' }).first().click();
  const dialog = page.getByRole('dialog', { name: /View workspace - Calm Trading/ });
  await expect(dialog).toBeVisible();
  const open = dialog.getByRole('button', { name: 'Open for 15 minutes' });

  await dialog.getByLabel('Ticket reference').fill('SUP-001042');
  await dialog.getByLabel('Reason for access').fill('123456789012');
  await expect(open).toBeDisabled();
  await dialog.getByLabel('Reason for access').fill('Investigating the delivery failure reported by the customer');
  await expect(open).toBeEnabled();
  await open.click();

  await expect.poll(() => requestBody).toEqual({
    reason: 'Investigating the delivery failure reported by the customer',
    ticketReference: 'SUP-001042',
  });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('rabitech_view_as_org')))
    .toContain('signed-platform-view-token');
  await expect(page).toHaveURL(/\/inbox/);

  await expect(page).toHaveURL(/\/platform\/subscribers\?viewAs=expired/, { timeout: 12_000 });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('rabitech_view_as_org'))).toBeNull();
});
