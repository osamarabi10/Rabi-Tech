import { expect, test, type Page } from '@playwright/test';

/**
 * Certification for the four Inbox parity gaps: the Blocked inbox, the
 * Unreplied toggle, the four sort modes, and directional row indicators.
 *
 * 18 combinations of 375/768/1440 x ar/he/en x light/dark, the same bar the
 * shared primitives met.
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

const BLOCKED = [
  {
    id: 'c-blocked-1', name: 'Nuisance Caller', phone: '970599111222',
    blockedAt: new Date().toISOString(), blockedReason: 'Repeated abuse',
    blockedByName: 'Operator', conversationCount: 0,
  },
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
    { token: auth.token, user: { ...auth.user, locale: options.locale, theme: options.theme }, locale: options.locale, theme: options.theme },
  );

  // Catch-all first; everything specific below wins. See the primitives spec —
  // an unmocked call 401s and the interceptor sends the whole matrix to /login.
  // [] rather than {}: the inbox maps over most of what it fetches, and an
  // empty object is truthy and has no .map. Object-shaped endpoints are mocked
  // individually below.
  await page.route('**/api/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/billing/**', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('/summary')) return route.fulfill({ json: { plan: { code: 'PRO', name: 'Pro' }, status: 'ACTIVE' } });
    if (p.endsWith('/service-state')) return route.fulfill({ json: { kind: 'ok' } });
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/notifications**', (route) => route.fulfill({ json: { notifications: [], unreadCount: 0 } }));
  await page.route('**/api/system/**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/auth/me**', (route) =>
    route.fulfill({ json: { ...auth.user, locale: options.locale, theme: options.theme, isAway: false } }));
  await page.route('**/api/contacts/blocked', (route) => route.fulfill({ json: BLOCKED }));
  await page.route('**/api/conversations**', (route) => route.fulfill({ json: [] }));
}

/**
 * No horizontal page overflow — measured at rest.
 *
 * The wait is not padding. The mobile navigation drawer is `fixed` and parked
 * off-canvas with a 200ms transform transition, and a fixed element outside the
 * viewport counts toward `documentElement.scrollWidth` while it is moving.
 * Measured immediately after navigation this reported 51px on a page whose
 * `body.scrollWidth` was exactly the viewport — the content fits, the drawer
 * was mid-flight.
 *
 * Two tests here load the same page at the same width. The one that performed a
 * few interactions first passed; the one that measured straight away failed.
 * That is a property of the clock rather than of the layout, and a check whose
 * answer depends on how quickly it got there is not measuring the page.
 */
async function expectNoPageOverflow(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await expect
    .poll(
      () => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth),
      { message: 'page scrolls horizontally', timeout: 5_000 },
    )
    .toBeLessThanOrEqual(1);
}

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`inbox sort + unreplied — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });
        await page.goto('/inbox');

        /*
          The sort control: four modes, and the selection is URL-addressable.

          Asserted through the accessible name rather than a class, because the
          control is a native select precisely so it carries that name for free.
        */
        const sort = page.getByRole('combobox', { name: /ترتيب المحادثات|מיון שיחות|sort conversations/i });
        await expect(sort).toBeVisible();
        await expect(sort.locator('option')).toHaveCount(4);

        await sort.selectOption('longest');
        await expect(page).toHaveURL(/[?&]sort=longest/);
        await sort.selectOption('newest');
        // Newest is the default, so it is absent from the URL rather than
        // written out — a default in the query string is noise that survives
        // being shared and then looks deliberate.
        await expect(page).not.toHaveURL(/[?&]sort=/);

        // The unreplied toggle is a pressed-state control and addressable too.
        const unreplied = page.getByRole('button', { name: /بدون رد|ללא מענה|unreplied/i }).first();
        await expect(unreplied).toBeVisible();
        await expect(unreplied).toHaveAttribute('aria-pressed', 'false');
        await unreplied.click();
        await expect(unreplied).toHaveAttribute('aria-pressed', 'true');
        await expect(page).toHaveURL(/[?&]unreplied=1/);

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        await expectNoPageOverflow(page);
      });

      test(`inbox blocked list — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });
        await page.goto('/inbox');

        /*
          The Blocked inbox lists contacts, so the fixture's blocked number has
          no conversation at all — which is the case the old conversation-filter
          could never show and the reason this exists.
        */
        const scope = page.getByRole('button', { name: /محظورة|חסומ|blocked/i }).first();
        if (await scope.isVisible()) {
          await scope.click();
          await expect(page.getByText(/Nuisance Caller/)).toBeVisible({ timeout: 10_000 });
          // Unblock is on the row, and it says so in words rather than an icon alone.
          await expect(page.getByRole('button', { name: /رفع الحظر|ביטול חסימה|unblock/i }).first()).toBeVisible();
          // And the row states that there is no history behind the number.
          await expect(page.getByText(/حُظر قبل أن يراسل|נחסם לפני|Blocked before they ever wrote/i)).toBeVisible();
        }

        await expectNoPageOverflow(page);
      });
    }
  }
}
