import { expect, test, type Page } from '@playwright/test';

/**
 * Certification evidence for P3 ChannelRail, P4 RailGroup and P19 toast-with-undo.
 *
 * The bar is the one the twelve certified surfaces met: all 18 combinations of
 * 375/768/1440 x ar/he/en x light/dark, proving the cross-cutting release gates
 * rather than merely rendering.
 *
 * Requires `RABITECH_E2E_SESSION`, like every other authenticated spec here. The
 * API is intercepted, so this exercises the components rather than the backend —
 * which is the point: a rail that only works against one workspace's data has
 * not been certified.
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

const SESSIONS = [
  {
    id: 'ch-connected', sessionName: 'primary', label: 'القناة الأساسية', connected: true,
    phoneNumber: '970599123456', teamId: null, isActive: true,
    connectionStatus: 'CONNECTED', isActiveChannel: true,
  },
  {
    id: 'ch-down', sessionName: 'backup', label: 'قناة احتياطية', connected: false,
    phoneNumber: '970599654321', teamId: null, isActive: true,
    connectionStatus: 'DISCONNECTED', isActiveChannel: false,
  },
];

async function prepare(page: Page, options: DisplayOptions) {
  const auth = session();

  await page.addInitScript(
    ([token, user, locale, theme]) => {
      localStorage.setItem('rabitech_token', token as string);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale as string);
      localStorage.setItem('rabitech_theme', theme as string);
    },
    [auth.token, { ...auth.user, locale: options.locale, theme: options.theme }, options.locale, options.theme] as const,
  );

  /*
    The session check has to be mocked, not just the token planted.

    The shell calls /api/auth/me on mount and redirects to /login when it does
    not get a profile back. Without this the whole matrix "runs" and every case
    is really just the login page — which is exactly how a suite reports a
    number that means nothing.
  */
  await page.route('**/api/auth/me**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...auth.user,
        name: 'Primitives Operator',
        email: 'operator@rabitech.test',
        locale: options.locale,
        theme: options.theme,
        isAway: false,
      }),
    }));

  await page.route('**/api/system/sessions**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSIONS) }));
  await page.route('**/api/system/teams**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/channels/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ capabilities: null, code: null, message: null }) }));

  await page.setViewportSize({ width: options.width, height: 900 });
}

/** No horizontal page overflow — one of the fourteen, and the easiest to regress. */
async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page scrolls horizontally').toBeLessThanOrEqual(1);
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`P3/P4 channel rail — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });
        await page.goto('/settings/channels');

        // P3 exists and is a landmark with an accessible name.
        const rail = page.getByRole('complementary', { name: /القناة|ערוץ|channel/i });
        await expect(rail).toBeVisible();

        // P4: the group is counted, and the count is the real number of channels.
        await expect(rail.getByText(String(SESSIONS.length), { exact: true }).first()).toBeVisible();

        // P4: collapsible — the heading is a disclosure control with real state.
        const disclosure = rail.getByRole('button', { expanded: true }).first();
        if (await disclosure.count()) {
          await disclosure.click();
          await expect(rail.getByRole('button', { expanded: false }).first()).toBeVisible();
          await disclosure.click();
        }

        // Status is not colour alone: each channel carries text for its state.
        await expect(rail.getByText(/متصلة|غير متصلة|מחובר|connected|disconnected/i).first()).toBeAttached();

        // Selection is URL-addressable, per the routing rules.
        await rail.getByRole('link').first().click();
        await expect(page).toHaveURL(/[?&]channel=/);
        await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);

        // Direction follows the locale, using logical placement rather than sides.
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');

        await expectNoPageOverflow(page);
      });

      test(`P19 toast undo — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });

        const notification = {
          id: 'n-1', type: 'NEW_MESSAGE', title: 'رسالة جديدة', body: 'نص',
          isRead: false, archivedAt: null, conversationId: null, createdAt: new Date().toISOString(),
        };
        await page.route('**/api/notifications?**', (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notifications: [notification], unreadCount: 1 }) }));
        await page.route('**/api/notifications/n-1/archive', (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: '{"unreadCount":0}' }));

        // The undo path that must fail loudly rather than silently.
        let restoreShouldFail = true;
        await page.route('**/api/notifications/n-1/restore', (route) =>
          restoreShouldFail
            ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' })
            : route.fulfill({ status: 200, contentType: 'application/json', body: '{"unreadCount":1}' }));

        await page.goto('/overview');
        await page.getByRole('button', { name: /الإشعارات|התראות|notification/i }).first().click();
        await page.getByRole('button', { name: /أرشفة|ארכיון|archive/i }).first().click();

        // The toast offers undo, because this action genuinely has an inverse.
        const undo = page.getByRole('button', { name: /تراجع|בטל|undo/i });
        await expect(undo).toBeVisible();

        // A failed undo must NOT disappear. It must say what is still true.
        await undo.click();
        await expect(page.getByText(/ما زال مؤرشفًا|still archived|עדיין/i)).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: /إعادة المحاولة|retry|נסה/i })).toBeVisible();

        // And retry must actually work once the server stops failing.
        restoreShouldFail = false;
        await page.getByRole('button', { name: /إعادة المحاولة|retry|נסה/i }).click();
        await expect(page.getByText(/تمت استعادة|restored|שוחזר/i)).toBeVisible({ timeout: 10_000 });

        await expectNoPageOverflow(page);
      });
    }
  }
}
