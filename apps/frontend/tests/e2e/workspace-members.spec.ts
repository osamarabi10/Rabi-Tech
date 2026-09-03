import { expect, test, type Page } from '@playwright/test';

/**
 * Certification for workspace membership.
 *
 * 18 combinations of 375/768/1440 x ar/he/en x light/dark, the same bar every
 * other surface here meets.
 *
 * The two tests are opposites again, for the same reason as the switcher's:
 * one proves the screen manages membership, the other proves it says the honest
 * thing when there is nothing to manage. A screen that renders correctly and a
 * screen that correctly declines to render are different properties.
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

async function prepare(
  page: Page,
  options: DisplayOptions & { workspaces: Array<typeof DEFAULT_WS>; override: boolean },
) {
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

  // Catch-all first, specifics after. An unmocked call 401s and the interceptor
  // sends the whole matrix to /login.
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

  await page.route('**/api/workspaces', (route) => route.fulfill({
    json: {
      workspaces: options.workspaces,
      activeWorkspaceId: options.workspaces.length > 1 ? SECOND_WS.id : DEFAULT_WS.id,
      maxWorkspaces: 5,
      workspaceCount: options.workspaces.length,
      canCreate: true,
      planName: 'Business',
    },
  }));

  const members = [
    { userId: 'u-self', name: 'Settings Operator', isActive: true, organizationRole: 'ADMIN', workspaceRole: 'ADMIN', joinedAt: new Date().toISOString() },
    { userId: 'u-maya', name: 'Maya Saleh', isActive: true, organizationRole: 'AGENT', workspaceRole: 'VIEWER', joinedAt: new Date().toISOString() },
  ];

  await page.route('**/api/workspaces/*/members**', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ json: { ok: true, unassignedConversations: 0 } });
    return route.fulfill({
      json: {
        workspace: SECOND_WS,
        members,
        candidates: [{ id: 'u-omar', name: 'Omar Nasser', role: 'AGENT' }],
        canManage: true,
        actingAsOverride: options.override,
        selfUserId: 'u-self',
        isDefaultWorkspace: false,
      },
    });
  });
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
      test(`workspace members — ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme, workspaces: [DEFAULT_WS, SECOND_WS], override: true });
        await page.goto('/settings/workspace-members');

        await expect(page.getByTestId('workspace-members')).toBeVisible({ timeout: 10_000 });

        // Both members, with their per-workspace roles — the thing the model
        // has always allowed and nothing exposed until now.
        await expect(page.getByTestId('member-u-self')).toBeVisible();
        await expect(page.getByTestId('member-u-maya')).toBeVisible();
        await expect(page.getByTestId('member-role-u-self')).toHaveValue('ADMIN');
        await expect(page.getByTestId('member-role-u-maya')).toHaveValue('VIEWER');

        /*
          The override notice, asserted as present rather than assumed.

          This is the whole reason the override is defensible: an organization
          admin managing a workspace they do not belong to says so at the point
          of use. A hatch nobody can see is indistinguishable from a hole, and
          the server-side half — a distinct audit action — is asserted by the
          tenancy harness.
        */
        await expect(page.getByTestId('override-notice')).toBeVisible();

        // Adding draws from the organization's existing users. Somebody who is
        // not in the organization is the invitation flow, which cannot target a
        // workspace, so the screen says so instead of offering a control.
        await expect(page.getByTestId('member-candidate')).toBeVisible();
        await expect(page.getByTestId('member-add')).toBeVisible();

        // Leaving is offered for yourself and removal for others: the same
        // endpoint, two different words, because they are different acts.
        await expect(page.getByTestId('member-remove-u-self')).toBeVisible();
        await expect(page.getByTestId('member-remove-u-maya')).toBeVisible();

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        await expectNoPageOverflow(page);
      });

      test(`one workspace explains itself — ${width}px ${locale} ${theme}`, async ({ page }) => {
        /*
          With a single workspace everybody in the organization is already a
          member, so there is nothing here to manage that the organization's own
          user list does not already cover.

          It explains that rather than rendering an empty table, because an
          empty table is indistinguishable from a loading failure — and from a
          permission the reader does not have.
        */
        await prepare(page, { width, locale, theme, workspaces: [DEFAULT_WS], override: false });
        await page.goto('/settings/workspace-members');
        await page.waitForLoadState('networkidle');

        await expect(page.getByTestId('members-single-workspace')).toBeVisible({ timeout: 10_000 });
        await expect(page.getByTestId('workspace-members')).toHaveCount(0);

        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        await expectNoPageOverflow(page);
      });
    }
  }
}
