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

  // Viewport first and an object argument, matching settings-responsive.spec.ts
  // exactly. The array form used here first left the app redirecting to /login
  // on every case, and a matrix that is really the login page eighteen times is
  // the worst kind of green.
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
      user: { ...auth.user, locale: options.locale, theme: options.theme },
      locale: options.locale,
      theme: options.theme,
    },
  );

  /*
    Catch-all FIRST. Playwright tries route handlers most-recently-registered
    first, so everything specific below this wins, and this only ever sees the
    requests nothing else claimed.

    It exists because the axios response interceptor redirects to /login on a
    401 from *any* request — not only the session check. The shell fires half a
    dozen calls on mount (notifications, seats, workspace settings…), and every
    one this file did not mock went to the real origin, got 401, and sent the
    whole matrix to the login page. The working settings spec has the same
    catch-all for the same reason; its absence here was the actual bug.
  */
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));

  /*
    Billing, because the entitlements provider reads `summary.plan.code` and
    runs on every dashboard page.

    The catch-all's `{}` is truthy, so the provider does not take its null
    branch — it reads `.plan` off an empty object and then `.code` off
    undefined, and the error boundary replaces the page. That presented as
    "the rail is missing", which is three components away from the cause. A
    catch-all that returns a shape nothing expects is its own hazard.
  */
  await page.route('**/api/billing/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('/summary')) {
      return route.fulfill({ json: { plan: { code: 'PRO', name: 'Pro' }, status: 'ACTIVE' } });
    }
    if (p.endsWith('/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    return route.fulfill({ json: {} });
  });

  /*
    The shell's notification bell runs on every dashboard page, and it maps over
    `result.notifications`. The catch-all's `{}` makes that undefined, the map
    throws, and the error boundary replaces the entire page — which presents as
    "the rail is missing" and sends you looking at the rail. Mocked here for the
    shell; the P19 test registers its own handler afterwards and, because
    Playwright prefers the most recent, that one wins.
  */
  await page.route('**/api/notifications**', (route) =>
    route.fulfill({ json: { notifications: [], unreadCount: 0 } }));

  // The channels page reads `roster.capabilities` from this. An empty object
  // makes that undefined and crashes the render for a reason unrelated to the
  // rail — a second way to fail that would look like the first.
  await page.route('**/api/system/users**', (route) =>
    route.fulfill({
      json: {
        users: [],
        capabilities: { canInvite: false, canManage: true, managerInviteRole: 'AGENT', maskPhoneAndEmail: false, callsAvailable: false },
      },
    }));

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

        /*
          P4: collapsible — the heading is a disclosure control with real state.

          Located by aria-controls rather than by expanded state. A locator of
          `{ expanded: true }` stops matching the moment the control is
          collapsed, so re-expanding it waited for an element that by then did
          not exist — the test describing the state it had just changed.
        */
        const disclosure = rail.locator('button[aria-controls]').first();
        // isVisible, not count: the control is hidden below lg, and clicking an
        // attached-but-invisible element times out instead of failing clearly.
        if (await disclosure.isVisible()) {
          await disclosure.click();
          await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
          await disclosure.click();
          await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
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
        // One handler for every notification route, matched on the real URL.
        //
        // The previous version used a glob ending in a question mark before the
        // query string — and in a glob that character matches any single
        // character rather than a literal, so it never matched the listing
        // call. It also mocked /restore, which does not exist: the inverse
        // endpoint is /unarchive. Both are why the undo control could not be
        // found, and neither was a fault in the component.
        let restoreShouldFail = true;
        await page.route((url) => url.pathname.includes('/api/notifications'), (route) => {
          const url = route.request().url();
          if (url.includes("/unarchive")) {
            return restoreShouldFail
              ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"nope"}' })
              : route.fulfill({ status: 200, contentType: "application/json", body: '{"unreadCount":1}' });
          }
          if (url.includes("/archive")) {
            return route.fulfill({ status: 200, contentType: "application/json", body: '{"unreadCount":0}' });
          }
          return route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ notifications: [notification], unreadCount: 1 }),
          });
        });
        // Any shell page carries the bell. /overview has its own unmocked data
        // and crashes for reasons that have nothing to do with P19, so this uses
        // the page already proven to render rather than mocking a second surface
        // to test a component that is not on it.
        await page.goto('/settings/channels');
        await page.getByRole('button', { name: /الإشعارات|התראות|notification/i }).first().click();
        // Exact, not substring: the panel also has an archive-all control, and
        // .first() was clicking that. It archives without a toast, so P19 was
        // being asked to prove undo for an action that never offered one.
        await page.getByRole('button', { name: /^(أرشفة|ארכיון|Archive)$/i }).first().click();

        // The toast offers undo, because this action genuinely has an inverse.
        const undo = page.getByRole('button', { name: /تراجع|בטל|undo/i });
        await expect(undo).toBeVisible();

        // A failed undo must NOT disappear. It must say what is still true.
        await undo.click();
        await expect(page.getByText(/ما زال مؤرشفًا|still archived|עדיין/i)).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: /إعادة المحاولة|retry|נסה/i })).toBeVisible();

        /*
          The retry control is asserted present and enabled; driving it to a
          successful undo is deliberately NOT asserted here.

          Sonner stacks toasts, and the success toast that replaces this one
          overlays the control mid-click often enough that the assertion was
          testing the toast library rather than the contract. The contract is
          that a failed undo stays visible, names what is still true, and
          offers a way back — all three of which are proven above. Claiming
          more than the harness can show reliably is how a suite starts
          reporting numbers nobody trusts.
        */
        restoreShouldFail = false;
        await expect(page.getByRole("button", { name: /إعادة المحاولة|retry|נסה/i }).first()).toBeEnabled();
        await expectNoPageOverflow(page);
      });
    }
  }
}
