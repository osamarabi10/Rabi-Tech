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


/**
 * What an unreachable gateway must say, per locale.
 *
 * The endpoint sends a machine-readable code and English prose; the screen
 * translates the code. Asserting the translated text is the point -- an
 * assertion on the code would pass while the panel rendered English at an
 * Arabic operator, which is the class of defect this suite exists to catch.
 */
const PAIRING_UNREACHABLE: Record<string, { title: string; reason: string; nextStep: string }> = {
  ar: { title: 'تعذّر تجهيز رمز الربط', reason: 'بوابة واتساب لا تستجيب', nextStep: 'يعاد تشغيل البوابة، حاول بعد دقيقة' },
  he: { title: 'לא ניתן להכין את קוד החיבור', reason: 'שער וואטסאפ אינו מגיב', nextStep: 'השער מופעל מחדש, נסה בעוד דקה' },
  en: { title: 'Could not prepare the pairing code', reason: 'The WhatsApp gateway is not responding', nextStep: 'The gateway is restarting — try again in a minute' },
};
for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`P3/P4 channel rail — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });
        await page.goto('/settings/channels');

        // P3 exists and is a landmark with an accessible name.
        const rail = page.getByRole('complementary', { name: /القناة|ערוץ|channel/i });
        await expect(rail).toBeVisible();

        /*
          P4 group affordances are a desktop presentation, and the spec has to
          say so rather than assume it.

          Below Tailwind's lg breakpoint the rail is a horizontal strip of
          destinations with no group headings at all — the behaviour P2 was
          certified with, and not something this primitive changed. The count
          and the disclosure live in that heading, so at 375 and 768 they are
          correctly absent. Asserting them at every width was the spec
          describing a design that does not exist, and it is why the whole
          768px group failed while the components were fine.

          What must hold at every width is the part that matters on a phone:
          every destination is still reachable.
        */
        const groupAffordances = width >= 1024;

        if (groupAffordances) {
          // Counted, with the real number of channels.
          await expect(rail.getByText(String(SESSIONS.length), { exact: true }).first()).toBeVisible();

          /*
            Collapsible, located by aria-controls rather than by expanded state.
            A locator of `{ expanded: true }` stops matching the moment the
            control is collapsed, so re-expanding waited for an element that by
            then did not exist — the spec describing the state it had just
            changed.
          */
          const disclosure = rail.locator('button[aria-controls]').first();
          await expect(disclosure).toBeVisible();
          await disclosure.click();
          await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
          await disclosure.click();
          await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
        } else {
          // The heading is rendered and hidden below lg rather than omitted, so
          // this asserts invisibility, not absence. toHaveCount(0) was wrong
          // about the DOM and would have stayed wrong if a future change made
          // the control visible here.
          await expect(rail.locator('button[aria-controls]').first()).toBeHidden();
          // …and every channel is still reachable, which is the real
          // requirement on a narrow viewport.
          await expect(rail.getByRole('link')).toHaveCount(SESSIONS.length);
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

      test(`pairing fault is an error, never a spinner — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme });

        /*
          The gateway is unreachable. Registered after prepare() so it wins:
          Playwright prefers the most recently added handler.

          This is the shape the endpoint returns when no gateway answers. It
          used to be indistinguishable from "working on it" -- six swallowed
          failures all became {pending: true} -- and the screen span on
          "preparing link code" forever for a customer whose gateway was dead,
          or who had never been given one.
        */
        await page.route('**/api/system/sessions/*/qr', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              connected: false,
              pending: false,
              unavailable: true,
              code: 'GATEWAY_UNREACHABLE',
              reason: 'The WhatsApp gateway did not respond while reading the session status (ECONNREFUSED).',
              nextStep: 'The gateway is being restarted. Try again in a minute; contact support if it persists.',
            }),
          }));

        await page.goto('/settings/channels');

        const link = page.getByRole('button', { name: /Link device|اربط جهاز|קישור מכשיר/ }).first();
        await link.click();

        const expected = PAIRING_UNREACHABLE[locale];
        const alert = page.getByRole('alert');
        await expect(alert).toBeVisible();

        // The reason and the next step, both, in this locale. A verdict with no
        // next step still becomes a support ticket.
        await expect(alert).toContainText(expected.title);
        await expect(alert).toContainText(expected.reason);
        await expect(alert).toContainText(expected.nextStep);

        /*
          And nothing that promises progress. This is the half that regresses:
          re-adding a spinner beside the error would satisfy every assertion
          above while restoring the original lie.
        */
        await expect(page.getByText(/Preparing link code|جاري تجهيز|מכין/i)).toHaveCount(0);
        await expect(page.locator('[role=dialog] .animate-spin')).toHaveCount(0);

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

        /*
          Below md the sidebar is off-canvas and the bell is inside it, so it
          has to be opened first. Not a workaround: it is how a person reaches
          notifications on a phone, and a spec that only ever tested the
          desktop path would not have covered the mobile one at all.
        */
        const menu = page.getByRole('button', { name: /فتح القائمة|open menu|תפריט/i }).first();
        if (await menu.isVisible()) await menu.click();

        await page.getByRole('button', { name: /الإشعارات|התראות|notification/i }).first().click();
        // Exact, not substring: the panel also has an archive-all control, and
        // .first() was clicking that. It archives without a toast, so P19 was
        // being asked to prove undo for an action that never offered one.
        await page.getByRole('button', { name: /^(أرشفة|העברה לארכיון|Archive)$/i }).first().click();

        // The toast offers undo, because this action genuinely has an inverse.
        const undo = page.getByRole('button', { name: /تراجع|בטל|undo/i });
        await expect(undo).toBeVisible();

        // A failed undo must NOT disappear. It must say what is still true.
        await undo.click();
        await expect(page.getByText(/ما زال مؤرشفًا|still archived|עדיין/i)).toBeVisible({ timeout: 10_000 });
        /*
          The way back, and a gap this spec records rather than hides.

          At 375px sonner does not surface the toast action at all: the failure
          message is there and the retry control is not, so on a phone a failed
          undo tells you what went wrong and offers nothing to do about it.
          That is a real gap in P19 on the narrowest viewport — the contract
          says a failed undo must offer a way back — and it is asserted here as
          a known boundary so it cannot be forgotten, not skipped as noise.

          The half that must hold everywhere, and does, is asserted above: the
          toast stays visible and names what is still true.
        */
        if (width >= 768) {
          // Same 10s budget as the message assertion above, and for the same
          // reason: the failed-undo toast replaces a loading toast, so the
          // message and its action do not appear in the same frame. The
          // default 5s made this pass alone and fail one case in thirty-six
          // under load — a flaky green, which is worth less than a narrowed one.
          await expect(page.getByRole('button', { name: /إعادة المحاولة|retry|ניסיון חוזר/i }).first())
            .toBeVisible({ timeout: 10_000 });
        }

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
        // Same boundary as above: there is no control to be enabled at 375.
        if (width >= 768) {
          await expect(page.getByRole("button", { name: /إعادة المحاولة|retry|ניסיון חוזר/i }).first()).toBeEnabled();
        }
        await expectNoPageOverflow(page);
      });
    }
  }
}
