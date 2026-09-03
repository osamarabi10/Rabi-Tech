import { expect, test, type Page } from '@playwright/test';

/**
 * Certification for the workspace switcher and contact isolation.
 *
 * 18 combinations of 375/768/1440 x ar/he/en x light/dark, the same bar every
 * shared primitive and the Inbox gaps met.
 *
 * The two tests are deliberately opposites. One proves the switcher appears and
 * changes what you see; the other proves it is absent when there is nothing to
 * switch to. A control that renders correctly and a control that correctly does
 * not render are different properties and neither implies the other.
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

const DEFAULT_WS = { id: 'ws_org-test', name: 'Head office', isDefault: true };
const SECOND_WS = { id: 'ws_second', name: 'Retail', isDefault: false };

/*
  The same number in both workspacees, which is the whole point of the schema
  change: after commit 2a this is two contacts, not one, and they share nothing.
  The names differ so the assertion can tell which workspace it is looking at
  without depending on ids the UI does not render.
*/
const SHARED_PHONE = '970599111222';
const CONTACTS: Record<string, Array<Record<string, unknown>>> = {
  [DEFAULT_WS.id]: [{ id: 'c-head', name: 'Head Office Customer', phone: SHARED_PHONE, createdAt: new Date().toISOString() }],
  [SECOND_WS.id]: [{ id: 'c-retail', name: 'Retail Customer', phone: SHARED_PHONE, createdAt: new Date().toISOString() }],
};

async function prepare(page: Page, options: DisplayOptions & { workspaces: typeof DEFAULT_WS[]; canCreate: boolean }) {
  const auth = session();
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.addInitScript(
    ({ token, user, locale, theme }) => {
      localStorage.setItem('rabitech_token', token);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale);
      localStorage.setItem('rabitech_theme', theme);
    },
    { token: auth.token, user: { ...auth.user, locale: options.locale, theme: options.theme }, locale: options.locale, theme: options.theme },
  );

  // Catch-all first, specific routes below. An unmocked call 401s and the
  // interceptor sends the whole matrix to /login — the failure that once made
  // eighteen combinations pass while testing nothing.
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/billing/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('/summary')) return route.fulfill({ json: { plan: { code: 'BUSINESS', name: 'Business' }, status: 'ACTIVE' } });
    if (p.endsWith('/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/system/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me**', (route) =>
    route.fulfill({ json: { ...auth.user, locale: options.locale, theme: options.theme, isAway: false } }));

  // The active workspace lives on the server in a claim, so the fixture keeps it
  // here rather than in a query parameter — mirroring the real thing, where the
  // client cannot name a workspace at all.
  let active = DEFAULT_WS.id;

  await page.route('**/api/workspaces', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, json: { id: 'ws_new', name: 'New', isDefault: false } });
    }
    return route.fulfill({
      json: {
        workspaces: options.workspaces,
        activeWorkspaceId: active,
        maxWorkspaces: options.canCreate ? 5 : 1,
        workspaceCount: options.workspaces.length,
        canCreate: options.canCreate,
        planName: options.canCreate ? 'Business' : 'Growth',
      },
    });
  });

  await page.route('**/api/workspaces/*/activate', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').slice(-2)[0];
    active = id;
    return route.fulfill({ json: { token: auth.token, workspace: { id, name: id } } });
  });

  // The contacts page reads { items, pagination }, not { contacts }. Getting
  // this wrong produced an empty list that looked exactly like isolation
  // working, which is the failure mode a fixture is most able to hide.
  await page.route('**/api/contacts**', (route) =>
    route.fulfill({
      json: {
        items: CONTACTS[active] ?? [],
        pagination: { cursorId: null, hasMore: false, total: (CONTACTS[active] ?? []).length },
      },
    }));
}

/** No horizontal page overflow, measured at rest. */
async function expectNoPageOverflow(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect
    .poll(
      () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: 'page scrolls horizontally', timeout: 5_000 },
    )
    .toBeLessThanOrEqual(1);
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`workspace switcher isolates contacts — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme, workspaces: [DEFAULT_WS, SECOND_WS], canCreate: true });
        await page.goto('/contacts');

        const switcher = page.getByTestId('workspace-switcher');
        await expect(switcher).toBeVisible();
        await expect(switcher).toContainText(DEFAULT_WS.name);

        // The head-office contact is here and the retail one is not, even though
        // both have the same number.
        await expect(page.getByText('Head Office Customer').first()).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText('Retail Customer')).toHaveCount(0);

        await switcher.click();
        await page.getByTestId(`workspace-option-${SECOND_WS.id}`).click();

        // Switching reloads, because every list on screen belongs to the workspace
        // being left.
        await page.waitForLoadState('networkidle');
        await expect(page.getByText('Retail Customer').first()).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText('Head Office Customer')).toHaveCount(0);

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        await expectNoPageOverflow(page);
      });

      test(`one workspace renders no switcher — ${width}px ${locale} ${theme}`, async ({ page }) => {
        /*
          The absence, asserted directly.

          A single workspace with no room to create another has nothing to offer, so
          the control is not rendered at all rather than rendered disabled. This
          also covers the shape of every organization today, which is why it is
          not an edge case.
        */
        await prepare(page, { width, locale, theme, workspaces: [DEFAULT_WS], canCreate: false });
        await page.goto('/contacts');
        await page.waitForLoadState('networkidle');

        await expect(page.getByTestId('workspace-switcher')).toHaveCount(0);
        // And the page still works: the contact list is the one the shell was
        // hiding nothing from.
        await expect(page.getByText('Head Office Customer').first()).toBeVisible({ timeout: 10_000 });

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        await expectNoPageOverflow(page);
      });
    }
  }
}
