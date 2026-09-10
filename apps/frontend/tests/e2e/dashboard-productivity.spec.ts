import { expect, test, type Page } from '@playwright/test';

type Locale = 'ar' | 'he' | 'en';
type Theme = 'light' | 'dark';
type DisplayOptions = {
  width: number;
  locale: Locale;
  theme: Theme;
  detailsCollapsed?: boolean;
};

const rawSession = process.env.RABITECH_E2E_SESSION;

function session() {
  if (!rawSession) {
    throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  }
  return JSON.parse(rawSession) as { token: string; user: Record<string, unknown> };
}

const WIDTHS = [375, 768, 1440] as const;
const LOCALES = ['ar', 'he', 'en'] as const;
const THEMES = ['light', 'dark'] as const;

const CONTACTS = {
  'contact-101': {
    id: 'contact-101',
    name: 'Amina Haddad',
    phone: '962790001101',
    tags: ['Priority'],
    contactTags: [],
    customFieldValues: [],
    lifecycleStage: 'Lead',
    marketingConsent: 'OPTED_IN',
    notes: null,
    blockedAt: null,
  },
  'contact-102': {
    id: 'contact-102',
    name: 'Basma Saleh',
    phone: '962790001102',
    tags: [],
    contactTags: [],
    customFieldValues: [],
    lifecycleStage: 'Customer',
    marketingConsent: 'OPTED_IN',
    notes: null,
    blockedAt: null,
  },
} as const;

const CONVERSATIONS = [
  {
    id: 'conversation-101',
    displayId: 101,
    status: 'OPEN',
    createdAt: '2026-09-10T08:00:00.000Z',
    lastMessageAt: '2026-09-10T09:00:00.000Z',
    firstResponseAt: null,
    autoCloseAt: null,
    contact: CONTACTS['contact-101'],
    messages: [{ body: '[audio]', direction: 'INBOUND' }],
    _count: { messages: 1 },
    assignee: null,
    collaborators: [],
    labels: ['Priority'],
    session: {
      sessionName: 'jordan-main',
      phoneNumber: '+962 7 9000 0000',
      teamId: null,
    },
  },
  {
    id: 'conversation-102',
    displayId: 102,
    status: 'OPEN',
    createdAt: '2026-09-10T07:00:00.000Z',
    lastMessageAt: '2026-09-10T08:30:00.000Z',
    firstResponseAt: null,
    autoCloseAt: null,
    contact: CONTACTS['contact-102'],
    messages: [{ body: 'Can you help me?', direction: 'INBOUND' }],
    _count: { messages: 1 },
    assignee: null,
    collaborators: [],
    labels: [],
    session: {
      sessionName: 'jordan-main',
      phoneNumber: '+962 7 9000 0000',
      teamId: null,
    },
  },
] as const;

const MESSAGES: Record<string, object[]> = {
  'conversation-101': [
    {
      id: 'message-audio-101',
      direction: 'INBOUND',
      body: '[audio]',
      timestamp: '2026-09-10T09:00:00.000Z',
      isAuto: false,
      isInternal: false,
      mediaUrl: 'https://media.rabitech.test/voice.wav',
      mediaType: 'audio',
      mediaFileName: 'customer-voice.wav',
      status: 'DELIVERED',
    },
  ],
  'conversation-102': [
    {
      id: 'message-text-102',
      direction: 'INBOUND',
      body: 'Can you help me?',
      timestamp: '2026-09-10T08:30:00.000Z',
      isAuto: false,
      isInternal: false,
      status: 'DELIVERED',
    },
  ],
};

function silentWav(seconds = 4) {
  const sampleRate = 8_000;
  const dataLength = sampleRate * seconds;
  const wav = Buffer.alloc(44 + dataLength, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

async function prepare(page: Page, options: DisplayOptions) {
  const auth = session();
  await page.setViewportSize({ width: options.width, height: 900 });
  await page.addInitScript(
    ({ token, user, locale, theme, detailsCollapsed }) => {
      localStorage.setItem('rabitech_token', token);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale);
      localStorage.setItem('rabitech_theme', theme);
      if (
        detailsCollapsed !== undefined &&
        localStorage.getItem('rabitech_contact_panel_collapsed') === null
      ) {
        localStorage.setItem('rabitech_contact_panel_collapsed', String(detailsCollapsed));
      }

      Object.defineProperty(HTMLMediaElement.prototype, 'play', {
        configurable: true,
        value() {
          this.dispatchEvent(new Event('play'));
          return Promise.resolve();
        },
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
        configurable: true,
        value() {
          this.dispatchEvent(new Event('pause'));
        },
      });
      const currentTimes = new WeakMap<HTMLMediaElement, number>();
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
        configurable: true,
        get() {
          return currentTimes.get(this) ?? 0;
        },
        set(value: number) {
          currentTimes.set(this, Number(value));
          this.dispatchEvent(new Event('timeupdate'));
        },
      });
    },
    {
      token: auth.token,
      user: { ...auth.user, locale: options.locale, theme: options.theme },
      locale: options.locale,
      theme: options.theme,
      detailsCollapsed: options.detailsCollapsed,
    },
  );

  await page.route('https://media.rabitech.test/voice.wav', (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }),
  );

  await page.route('**/api/**', (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/api/auth/me') {
      return route.fulfill({
        json: {
          ...auth.user,
          locale: options.locale,
          theme: options.theme,
          isAway: false,
          emailVerifiedAt: '2026-09-01T00:00:00.000Z',
        },
      });
    }
    if (pathname === '/api/billing/summary') {
      return route.fulfill({ json: { plan: { code: 'PRO', name: 'Pro' }, status: 'ACTIVE' } });
    }
    if (pathname === '/api/billing/service-state') {
      return route.fulfill({ json: { kind: 'ok' } });
    }
    if (pathname === '/api/billing/trial') {
      return route.fulfill({ json: { state: 'none', endsAt: null, serverNow: null } });
    }
    if (pathname === '/api/billing/email-verification') {
      return route.fulfill({ json: { verified: true, email: auth.user.email, canResend: false } });
    }
    if (pathname === '/api/notifications') {
      return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
    }
    if (pathname === '/api/notifications/mentions') {
      return route.fulfill({ json: { conversationIds: [], unreadConversationIds: [] } });
    }
    if (pathname === '/api/workspaces') {
      return route.fulfill({
        json: { workspaces: [], activeWorkspaceId: null, canCreate: false },
      });
    }
    if (pathname === '/api/system/sessions') {
      return route.fulfill({
        json: [
          {
            id: 'session-1',
            sessionName: 'jordan-main',
            label: 'Jordan main',
            connected: true,
            phoneNumber: '+962 7 9000 0000',
            isActive: true,
            isActiveChannel: true,
          },
        ],
      });
    }
    if (pathname === '/api/system/inbox-config') {
      return route.fulfill({ json: { sessions: [] } });
    }
    if (
      pathname === '/api/lifecycle-stages' ||
      pathname === '/api/system/teams' ||
      pathname === '/api/system/users' ||
      pathname === '/api/inbox-views' ||
      pathname === '/api/snippets' ||
      pathname === '/api/templates' ||
      pathname === '/api/segments'
    ) {
      return route.fulfill({ json: [] });
    }
    if (pathname === '/api/conversations') {
      return route.fulfill({ json: CONVERSATIONS });
    }
    if (pathname === '/api/conversation-settings') {
      return route.fulfill({
        json: {
          autoCloseEnabled: false,
          autoCloseDurationMinutes: 1_440,
          autoCloseEnabledAt: null,
          manualClosingNotesEnabled: false,
          manualClosingNoteMode: 'OPTIONAL',
          categories: [],
          limits: { minAutoCloseMinutes: 60, maxAutoCloseMinutes: 43_200, maxCategories: 20 },
        },
      });
    }

    const messages = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messages) {
      return route.fulfill({
        json: { messages: MESSAGES[messages[1]] ?? [], hasMore: false, oldestId: null },
      });
    }

    if (/^\/api\/conversations\/[^/]+\/collaborators$/.test(pathname)) {
      return route.fulfill({ json: [] });
    }
    if (/^\/api\/conversations\/[^/]+\/activity$/.test(pathname)) {
      return route.fulfill({ json: { events: [] } });
    }

    const consent = pathname.match(/^\/api\/contacts\/([^/]+)\/consent$/);
    if (consent) {
      return route.fulfill({
        json: { status: 'OPTED_IN', source: null, updatedAt: null, history: [] },
      });
    }

    if (
      pathname === '/api/contacts/tags' ||
      pathname === '/api/contacts/custom-fields' ||
      pathname === '/api/contacts/blocked'
    ) {
      return route.fulfill({ json: [] });
    }

    if (pathname === '/api/contacts/merge-suggestions') {
      return route.fulfill({ json: { suggestions: [] } });
    }
    if (pathname === '/api/contacts') {
      return route.fulfill({
        json: {
          items: [],
          pagination: { cursorId: null, hasMore: false, total: 0 },
        },
      });
    }
    if (/^\/api\/contacts\/[^/]+\/(tags|conversations)$/.test(pathname)) {
      return route.fulfill({ json: [] });
    }

    const contact = pathname.match(/^\/api\/contacts\/([^/]+)$/);
    if (contact) {
      return route.fulfill({
        json: CONTACTS[contact[1] as keyof typeof CONTACTS] ?? CONTACTS['contact-101'],
      });
    }

    throw new Error(`Unhandled API fixture: ${request.method()} ${pathname}`);
  });
}

async function openInbox(page: Page, options: Partial<DisplayOptions> = {}) {
  await prepare(page, {
    width: options.width ?? 1440,
    locale: options.locale ?? 'en',
    theme: options.theme ?? 'light',
    detailsCollapsed: options.detailsCollapsed ?? true,
  });
  await page.goto('/inbox');
  await expect(page.getByText('#101').first()).toBeVisible({ timeout: 10_000 });
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: 'dashboard productivity surface scrolls horizontally' },
    )
    .toBeLessThanOrEqual(1);
}

test.describe('dashboard productivity contracts', () => {
  test('contract: command palette is searchable, keyboard navigable, and named', async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press('Control+K');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();

    const search = palette.getByRole('searchbox', { name: 'Search commands' });
    await search.fill('contacts');
    await expect(palette.getByRole('option', { name: /Contacts/ })).toBeVisible();
    await search.press('Enter');
    await expect(page).toHaveURL(/\/contacts$/);
  });

  test('contract: question mark opens the shortcut guide but typing does not', async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press('?');
    const guide = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(guide).toBeVisible();
    await expect(guide.getByText('Move to next conversation')).toBeVisible();
    await page.keyboard.press('Escape');

    const inboxSearch = page.getByPlaceholder('Search...');
    await inboxSearch.focus();
    await inboxSearch.press('?');
    await expect(guide).toBeHidden();
  });

  test('contract: J and K move between conversations without changing names or constants', async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press('j');
    await expect(page.getByText('#102').first()).toBeVisible();
    await page.keyboard.press('k');
    await expect(page.getByText('#101').first()).toBeVisible();
  });

  test('contract: R focuses the reply composer', async ({ page }) => {
    await openInbox(page);

    const reply = page.locator('textarea').first();
    await expect(reply).toBeVisible();
    await page.keyboard.press('r');
    await expect(reply).toBeFocused();
  });

  test('contract: E opens resolution for the selected conversation', async ({ page }) => {
    await openInbox(page);

    await page.keyboard.press('e');
    await expect(page.getByRole('dialog', { name: 'Close conversation' })).toBeVisible();
  });

  test('contract: audio messages expose play, seek, and playback speed controls', async ({ page }) => {
    await openInbox(page);

    const play = page.getByRole('button', { name: 'Play', exact: true });
    const seek = page.getByRole('slider', { name: 'Audio position' });
    const speed = page.getByRole('button', { name: 'Change playback speed' });
    await expect(play).toBeVisible();
    await expect(seek).toBeVisible();
    await expect(speed).toHaveText('1x');

    await speed.click();
    await expect(speed).toHaveText('1.5x');
    await play.click();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect
      .poll(async () => Number(await seek.getAttribute('max')))
      .toBeGreaterThanOrEqual(2);
    await seek.fill('2');
    await expect(seek).toHaveValue('2');
  });

  test('contract: contact-panel collapse survives a reload', async ({ page }) => {
    await openInbox(page, { detailsCollapsed: false });

    const hide = page.getByRole('button', { name: 'Hide contact details' });
    await expect(hide).toBeVisible();
    await hide.click();
    await expect(page.getByRole('button', { name: 'Show contact details' })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('rabitech_contact_panel_collapsed')))
      .toBe('true');

    await page.reload();
    await expect(page.getByText('#101').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Show contact details' })).toBeVisible();
  });
});

for (const width of WIDTHS) {
  for (const locale of LOCALES) {
    for (const theme of THEMES) {
      test(`matrix: productivity surfaces - ${width}px ${locale} ${theme}`, async ({ page }) => {
        await prepare(page, { width, locale, theme, detailsCollapsed: true });
        await page.goto('/inbox');

        await page.keyboard.press('Control+K');
        const commandDialog = page.getByRole('dialog');
        await expect(commandDialog).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
        await expect(commandDialog).toBeHidden();

        await page.keyboard.press('?');
        const shortcutsDialog = page.getByRole('dialog');
        await expect(shortcutsDialog).toBeVisible();
        await expectNoHorizontalOverflow(page);
        await page.keyboard.press('Escape');
        await expect(shortcutsDialog).toBeHidden();

        if (width < 768) {
          await page.getByRole('button', { name: /Amina Haddad/ }).click();
        }
        await expect(
          page.getByRole('button', { name: /^(Play|تشغيل التسجيل الصوتي|נגן הקלטה קולית)$/ }),
        ).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
        if (theme === 'dark') {
          await expect(page.locator('html')).toHaveClass(/dark/);
        } else {
          await expect(page.locator('html')).not.toHaveClass(/dark/);
        }
        await expectNoHorizontalOverflow(page);
      });
    }
  }
}
