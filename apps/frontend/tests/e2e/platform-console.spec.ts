import { test, expect } from '@playwright/test';

/**
 * Real-stack gate for the platform console.
 *
 * Both tests need credentials this repository does not carry: an authenticated
 * platform session fixture and a live support-scope token. They skip when those
 * are absent rather than failing or, worse, passing against an unauthenticated
 * page — a green run here has to mean the assertion was made, not that the
 * setup was missing.
 *
 * The suite's shared playwright.config.ts sets no storageState, so the fixture
 * is applied per-file below instead of being wired globally.
 */

test.describe('platform console real-stack gate', () => {
  test.use({ storageState: process.env.PLAYWRIGHT_STORAGE_STATE });

  test('renders the authenticated platform navigation', async ({ page }) => {
    test.skip(
      !process.env.PLAYWRIGHT_STORAGE_STATE,
      'Set PLAYWRIGHT_STORAGE_STATE to an authenticated platform session fixture.',
    );

    await page.goto('/platform', { waitUntil: 'networkidle' });
    await expect(page.getByRole('navigation', { name: 'Platform navigation' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Editions/ })).toBeVisible();
  });
});

/**
 * The boundary, asserted where it actually lives.
 *
 * The console's sidebar hides destinations a support user cannot use, but that
 * is cosmetic. This checks the part that matters: the server refuses an
 * owner-only endpoint on its own, whatever the client chose to render.
 */
test('support scope cannot reach the owner-only staff endpoint', async ({ request }) => {
  test.skip(
    !process.env.PLAYWRIGHT_SUPPORT_TOKEN,
    'Set PLAYWRIGHT_SUPPORT_TOKEN to a live support-scope session token.',
  );

  const response = await request.get(
    `${process.env.PLAYWRIGHT_API_BASE_URL || 'http://localhost:4000'}/api/platform/staff`,
    { headers: { Authorization: `Bearer ${process.env.PLAYWRIGHT_SUPPORT_TOKEN}` } },
  );
  expect(response.status()).toBe(403);
});
