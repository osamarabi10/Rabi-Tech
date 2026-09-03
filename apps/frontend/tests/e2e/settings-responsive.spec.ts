import { expect, test, type Page } from '@playwright/test';

type TestSession = {
  token: string;
  user: Record<string, unknown>;
};

type DisplayOptions = {
  locale: 'ar' | 'he' | 'en';
  theme: 'light' | 'dark';
  width: number;
  height: number;
};

const MOCK_QR = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21">
    <rect width="21" height="21" fill="white"/>
    <path fill="black" d="M1 1h7v7H1zm2 2v3h3V3zm10-2h7v7h-7zm2 2v3h3V3zM1 13h7v7H1zm2 2v3h3v-3zm7-5h2v2h-2zm3 0h2v2h-2zm3 0h4v2h-4zm-6 3h2v2h-2zm3 0h4v2h-4zm5 0h2v4h-2zm-8 3h3v2h-3zm4 0h2v4h-2zm-5 3h4v2h-4zm8-1h3v3h-3z"/>
  </svg>
`)}`;

const rawSession = process.env.RABITECH_E2E_SESSION;

function session(): TestSession {
  if (!rawSession) throw new Error('RABITECH_E2E_SESSION is required for authenticated UI tests');
  return JSON.parse(rawSession) as TestSession;
}

function profile(options: DisplayOptions) {
  const auth = session();
  return {
    ...auth.user,
    id: auth.user.id || 'settings-user',
    name: 'Settings Operator',
    email: 'operator@rabitech.test',
    role: auth.user.role || 'ADMIN',
    permissions: auth.user.permissions || [],
    phone: '+970 599 123456',
    avatarUrl: null,
    locale: options.locale,
    theme: options.theme,
    isAway: false,
    notificationNewMessage: 'IN_APP',
    notificationAssignment: 'IN_APP',
    notificationMention: 'IN_APP',
    notificationResolution: 'IN_APP',
    notificationEscalation: 'IN_APP',
    notificationSound: true,
    onboardingLifecycleComplete: false,
    twoFactorEnabled: false,
  };
}

async function prepareSettings(
  page: Page,
  options: DisplayOptions,
  onNotificationSave?: (payload: Record<string, unknown>) => void,
  onWorkspaceSave?: (payload: Record<string, unknown>) => void,
  onUserSave?: (payload: Record<string, unknown>) => void,
  onInvite?: (payload: Record<string, unknown>) => void,
  onTeamRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
  onSessionRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
  onLifecycleRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
  onSnippetRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
  onTagRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
  onContactFieldRequest?: (method: string, path: string, payload?: Record<string, unknown>) => void,
) {
  const auth = session();
  const currentProfile = profile(options);
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.addInitScript(
    ({ token, user, locale, theme }) => {
      localStorage.setItem('rabitech_token', token);
      localStorage.setItem('rabitech_user', JSON.stringify(user));
      localStorage.setItem('rabitech_locale', locale);
      localStorage.setItem('rabitech_theme', theme);
    },
    { token: auth.token, user: currentProfile, locale: options.locale, theme: options.theme },
  );
  await page.route('**/api/auth/me**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path.endsWith('/api/auth/me')) {
      await route.fulfill({ json: currentProfile });
      return;
    }
    if (request.method() === 'PATCH' && path.endsWith('/api/auth/me/notification-preferences')) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      onNotificationSave?.(payload);
      Object.assign(currentProfile, payload);
      await route.fulfill({ json: payload });
      return;
    }
    if (request.method() === 'PATCH' && path.endsWith('/api/auth/me')) {
      const payload = request.postDataJSON() as Record<string, unknown>;
      Object.assign(currentProfile, payload);
      await route.fulfill({ json: currentProfile });
      return;
    }
    await route.continue();
  });
  const workspaceSettings = {
    name: 'RabiTech Demo',
    timezone: 'Asia/Jerusalem',
    userInactivityTimeoutMinutes: 20,
    weeklyRecapEnabled: true,
    weeklyRecapRecipientIds: [String(currentProfile.id)],
    eligibleRecipients: [
      {
        id: String(currentProfile.id),
        name: String(currentProfile.name),
        email: String(currentProfile.email),
        avatarUrl: null,
        role: String(currentProfile.role),
      },
      {
        id: 'settings-supervisor',
        name: 'Maya Saleh',
        email: 'maya@rabitech.test',
        avatarUrl: null,
        role: 'SUPERVISOR',
      },
    ],
  };
  await page.route('**/api/system/workspace-settings', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: workspaceSettings });
      return;
    }
    if (route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      onWorkspaceSave?.(payload);
      Object.assign(workspaceSettings, payload);
      await route.fulfill({ json: workspaceSettings });
      return;
    }
    await route.continue();
  });
  const workspaceUsers = [
    {
      id: String(currentProfile.id), name: String(currentProfile.name), email: String(currentProfile.email),
      phone: null, role: 'ADMIN', isActive: true, isAway: false, presence: 'ONLINE',
      lastSeen: new Date().toISOString(), primaryTeamId: null, primaryTeam: null, teams: [],
      restrictContactVisibility: false, contactVisibilityScope: 'TEAM', restrictCalls: false,
      restrictWorkflows: false, maskPhoneAndEmail: false, createdAt: new Date().toISOString(),
    },
    {
      id: 'settings-agent', name: 'Maya Saleh', email: 'maya@rabitech.test', phone: null,
      role: 'AGENT', isActive: true, isAway: false, presence: 'OFFLINE',
      lastSeen: '2026-08-25T12:00:00.000Z', primaryTeamId: 'team-sales',
      primaryTeam: { id: 'team-sales', name: 'Sales', slug: 'sales', color: '#0f766e' },
      teams: [], restrictContactVisibility: false, contactVisibilityScope: 'TEAM',
      restrictCalls: false, restrictWorkflows: false, maskPhoneAndEmail: false,
      createdAt: '2026-08-20T12:00:00.000Z',
    },
  ];
  await page.route('**/api/system/users**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && path === '/api/system/users') {
      await route.fulfill({ json: {
        users: workspaceUsers,
        capabilities: { canInvite: true, canManage: true, managerInviteRole: 'AGENT', maskPhoneAndEmail: false, callsAvailable: false },
      } });
      return;
    }
    if (route.request().method() === 'PATCH' && path.startsWith('/api/system/users/')) {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      onUserSave?.(payload);
      await route.fulfill({ json: { ...workspaceUsers[1], ...payload } });
      return;
    }
    await route.continue();
  });
  const workspaceTeams = [
    {
      id: 'team-sales', name: 'Sales', slug: 'sales', description: 'Revenue conversations',
      color: '#059669', isDefault: true, assignmentStrategy: 'LEAST_OPEN', maxConcurrentPerAgent: 12,
      memberIds: ['settings-agent'], _count: { members: 1, conversations: 24, sessions: 1 },
    },
    {
      id: 'team-support', name: 'Support', slug: 'support', description: 'Customer support queue',
      color: '#2563EB', isDefault: false, assignmentStrategy: 'ROUND_ROBIN', maxConcurrentPerAgent: 8,
      memberIds: [String(currentProfile.id)], _count: { members: 1, conversations: 8, sessions: 1 },
    },
  ];
  await page.route('**/api/system/teams**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onTeamRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/system/teams') {
      await route.fulfill({ json: workspaceTeams });
      return;
    }
    if (request.method() === 'POST' && path === '/api/system/teams') {
      await route.fulfill({ status: 201, json: { id: 'team-new', slug: 'new-team', isDefault: false, ...payload } });
      return;
    }
    if (request.method() === 'PATCH') {
      await route.fulfill({ json: { ...workspaceTeams[0], ...payload } });
      return;
    }
    if (request.method() === 'PUT' && path.endsWith('/members')) {
      await route.fulfill({ json: { teamId: path.split('/')[4], memberIds: payload?.userIds || [] } });
      return;
    }
    if (request.method() === 'DELETE') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });
  const workspaceSessions = [
    {
      id: 'session-sales', sessionName: 'sales-whatsapp', label: 'Sales WhatsApp',
      connected: true, phoneNumber: '+970599111222', teamId: 'team-sales', isActive: true,
      connectionStatus: 'CONNECTED', isActiveChannel: true,
    },
    {
      id: 'session-support', sessionName: 'support-whatsapp', label: 'Support WhatsApp',
      connected: false, phoneNumber: null, teamId: 'team-support', isActive: false,
      connectionStatus: 'DISCONNECTED', isActiveChannel: true,
    },
  ];
  await page.route('**/api/system/sessions**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onSessionRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/system/sessions') {
      await route.fulfill({ json: workspaceSessions });
      return;
    }
    if (request.method() === 'GET' && path.endsWith('/qr')) {
      await route.fulfill({ json: { connected: false, qrCode: MOCK_QR } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/disconnect')) {
      const sessionName = decodeURIComponent(path.split('/')[4]);
      const target = workspaceSessions.find((item) => item.sessionName === sessionName);
      if (target) {
        target.connected = false;
        target.isActive = false;
        if (payload?.unlink === true) target.phoneNumber = null;
      }
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.continue();
  });
  // The Meta Cloud API card on /settings/channels reads its own endpoint when
  // it mounts. Left unmocked the request falls through to a backend that is
  // not running here, and the 401 interceptor in lib/api.ts redirects to
  // /login - which takes every settings page down with it, not just this card.
  // That is why one new card failed eighteen unrelated responsive checks.
  await page.route('**/api/channels/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/channels/capabilities') {
      // The capability descriptor the card reads instead of asking which
      // channel it is. OpenWA shape: no window, can start conversations.
      await route.fulfill({ json: { capabilities: {
        kind: 'OPENWA', requiresServiceWindow: false, supportsTemplates: false,
        supportsQrPairing: true, maxUniqueRecipientsPer24h: null,
        canInitiateConversations: true, messagingTier: null, qualityRating: null,
      } } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/channels/active') {
      await route.fulfill({ json: { activeKind: request.postDataJSON()?.kind, capabilities: null } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/channels/meta') {
      // Not connected: the state that renders the connect affordance, which is
      // the one this page is asserted against.
      await route.fulfill({ json: { channel: null } });
      return;
    }
    if (request.method() === 'DELETE' && path === '/api/channels/meta') {
      await route.fulfill({ json: { removed: true } });
      return;
    }
    await route.continue();
  });
  const lifecycleStages = [
    { id: 'stage-lead', name: 'Lead', description: 'A new opportunity', color: '#2563EB', emoji: null, kind: 'ACTIVE', isDefault: true, isWon: false, orderIndex: 0, contactCount: 12 },
    { id: 'stage-qualified', name: 'Qualified', description: 'Ready for an offer', color: '#7C3AED', emoji: null, kind: 'ACTIVE', isDefault: false, isWon: false, orderIndex: 1, contactCount: 7 },
    { id: 'stage-customer', name: 'Customer', description: 'Converted customer', color: '#059669', emoji: null, kind: 'ACTIVE', isDefault: false, isWon: true, orderIndex: 2, contactCount: 21 },
    { id: 'stage-unqualified', name: 'Unqualified', description: 'Not a fit right now', color: '#DC2626', emoji: 'X', kind: 'LOST', isDefault: false, isWon: false, orderIndex: 0, contactCount: 4 },
  ];
  await page.route('**/api/lifecycle-stages**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onLifecycleRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/lifecycle-stages') {
      await route.fulfill({ json: lifecycleStages });
      return;
    }
    if (request.method() === 'POST' && path === '/api/lifecycle-stages') {
      const kind = String(payload?.kind || 'ACTIVE');
      const stage = {
        id: 'stage-new', name: String(payload?.name), description: payload?.description || null,
        color: payload?.color || '#2563EB', emoji: payload?.emoji || null, kind,
        isDefault: false, isWon: false,
        orderIndex: lifecycleStages.filter((item) => item.kind === kind).length, contactCount: 0,
      };
      lifecycleStages.push(stage as typeof lifecycleStages[number]);
      await route.fulfill({ status: 201, json: stage });
      return;
    }
    if (request.method() === 'PATCH') {
      const id = path.split('/')[3];
      const target = lifecycleStages.find((stage) => stage.id === id);
      if (!target) { await route.fulfill({ status: 404, json: { error: 'Not found' } }); return; }
      if (payload?.isDefault === true) lifecycleStages.forEach((stage) => { stage.isDefault = stage.id === id; });
      if (payload?.isWon === true) lifecycleStages.forEach((stage) => { stage.isWon = stage.id === id; });
      Object.assign(target, payload);
      await route.fulfill({ json: target });
      return;
    }
    if (request.method() === 'PUT' && path.endsWith('/reorder/all')) {
      (payload?.stageIds as string[] || []).forEach((id, orderIndex) => {
        const target = lifecycleStages.find((stage) => stage.id === id);
        if (target) target.orderIndex = orderIndex;
      });
      await route.fulfill({ json: payload });
      return;
    }
    if (request.method() === 'DELETE') {
      const id = path.split('/')[3];
      const index = lifecycleStages.findIndex((stage) => stage.id === id);
      if (index >= 0) lifecycleStages.splice(index, 1);
      await route.fulfill({ json: { deleted: true, affectedContacts: 4, replacementStageId: payload?.reassignToStageId || null } });
      return;
    }
    await route.continue();
  });
  const snippetTopics = [
    { id: 'topic-support', name: 'Support', snippetCount: 1 },
    { id: 'topic-billing', name: 'Billing', snippetCount: 1 },
  ];
  const snippets = [
    {
      id: 'snippet-welcome', title: 'Welcome', body: 'Hello $contact.name, how can we help?', shortCode: 'welcome',
      category: 'QUICK_REPLY', sortOrder: 0, isActive: true, topics: [snippetTopics[0]], attachments: [],
    },
    {
      id: 'snippet-invoice', title: 'Invoice copy', body: 'Your invoice is attached.', shortCode: 'invoice',
      category: 'QUICK_REPLY', sortOrder: 1, isActive: true, topics: [snippetTopics[1]],
      attachments: [{ id: 'file-invoice', fileName: 'invoice-guide.pdf', contentType: 'application/pdf', sizeBytes: 24576, sortOrder: 0, url: '/api/snippets/assets/org-test/file-invoice?sig=test' }],
    },
  ];
  await page.route('**/api/snippets**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() && request.headers()['content-type']?.includes('application/json')
      ? request.postDataJSON() as Record<string, unknown> : undefined;
    onSnippetRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/snippets/topics') return route.fulfill({ json: snippetTopics });
    if (request.method() === 'GET' && path === '/api/snippets') return route.fulfill({ json: snippets });
    if (request.method() === 'POST' && path === '/api/snippets/topics') {
      const topic = { id: 'topic-new', name: String(payload?.name), snippetCount: 0 };
      snippetTopics.push(topic); return route.fulfill({ status: 201, json: topic });
    }
    if (request.method() === 'POST' && path === '/api/snippets') {
      const topicIds = Array.isArray(payload?.topicIds) ? payload.topicIds : [];
      const snippet = {
        id: 'snippet-new',
        title: String(payload?.title || ''),
        body: String(payload?.body || ''),
        shortCode: String(payload?.shortCode || ''),
        category: 'QUICK_REPLY',
        sortOrder: snippets.length,
        isActive: payload?.isActive !== false,
        attachments: [],
        topics: snippetTopics.filter((topic) => topicIds.includes(topic.id)),
      };
      snippets.push(snippet); return route.fulfill({ status: 201, json: snippet });
    }
    if (request.method() === 'PATCH') return route.fulfill({ json: { ...snippets[0], ...payload } });
    if (request.method() === 'DELETE') return route.fulfill({ status: 204, body: '' });
    return route.continue();
  });
  const contactTags = [
    { id: 'tag-vip', name: 'VIP', description: 'Priority customer', colorCode: '#ca8a04', emoji: 'V', contactCount: 12 },
    { id: 'tag-follow-up', name: 'Follow up', description: 'Requires another response', colorCode: '#2563eb', emoji: null, contactCount: 4 },
  ];
  await page.route('**/api/contacts/tags**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onTagRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/contacts/tags') return route.fulfill({ json: contactTags });
    if (request.method() === 'POST' && path === '/api/contacts/tags') {
      const tag = { id: 'tag-new', contactCount: 0, ...payload } as typeof contactTags[number];
      contactTags.push(tag); return route.fulfill({ status: 201, json: tag });
    }
    if (request.method() === 'PATCH') {
      const tag = contactTags.find((row) => row.id === path.split('/').at(-1));
      if (tag) Object.assign(tag, payload);
      return route.fulfill({ json: tag || {} });
    }
    if (request.method() === 'DELETE') {
      const index = contactTags.findIndex((row) => row.id === path.split('/').at(-1));
      const removed = index >= 0 ? contactTags.splice(index, 1)[0] : null;
      return route.fulfill({ json: { deleted: true, removedAssignments: removed?.contactCount || 0 } });
    }
    return route.continue();
  });
  const contactFields = [
    { fieldKey: 'firstName', kind: 'STANDARD', name: 'First Name', dataType: 'text', editable: true, sortOrder: 0, visibility: 'ALWAYS_SHOW', description: null },
    { fieldKey: 'email', kind: 'STANDARD', name: 'Email Address', dataType: 'email', editable: true, sortOrder: 1, visibility: 'HIDE_WHEN_EMPTY', description: null },
    { id: 'field-account-tier', fieldKey: 'custom:field-account-tier', kind: 'CUSTOM', name: 'Account Tier', slug: 'account_tier', dataType: 'list', allowedValues: ['Standard', 'Gold'], editable: true, sortOrder: 2, visibility: 'HIDE_WHEN_EMPTY', description: 'Commercial service level' },
  ];
  await page.route('**/api/contacts/contact-fields**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onContactFieldRequest?.(request.method(), path, payload);
    if (request.method() === 'GET' && path === '/api/contacts/contact-fields') return route.fulfill({ json: contactFields });
    if (request.method() === 'PUT' && path.endsWith('/view')) return route.fulfill({ json: { ok: true } });
    return route.continue();
  });
  await page.route('**/api/contacts/custom-fields**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    onContactFieldRequest?.(request.method(), path, payload);
    if (request.method() === 'POST') {
      const field = { id: 'field-new', fieldKey: 'custom:field-new', kind: 'CUSTOM', sortOrder: contactFields.length, visibility: 'HIDE_WHEN_EMPTY', editable: true, ...payload };
      contactFields.push(field as typeof contactFields[number]); return route.fulfill({ status: 201, json: field });
    }
    if (request.method() === 'PATCH') return route.fulfill({ json: { ...contactFields[2], ...payload } });
    if (request.method() === 'DELETE') return route.fulfill({ json: { deleted: true, removedValues: 0 } });
    return route.continue();
  });
  await page.route('**/api/usage/seats', (route) => route.fulfill({ json: {
    plan: 'GROWTH', planName: 'Growth', used: 2, limit: 5, remaining: 3, atLimit: false,
  } }));
  await page.route('**/api/system/user-invitations', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: [{
        id: 'invite-pending', email: 'pending@rabitech.test', name: 'Pending User', role: 'AGENT',
        primaryTeamId: 'team-support', invitedByName: 'Settings Operator',
        expiresAt: '2026-09-01T12:00:00.000Z', createdAt: '2026-08-25T12:00:00.000Z',
        primaryTeam: { id: 'team-support', name: 'Support', color: '#2563eb' },
      }] });
      return;
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      onInvite?.(payload);
      await route.fulfill({ status: 201, json: { id: 'invite-new', ...payload } });
      return;
    }
    await route.continue();
  });
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

async function expectSettingsFrame(page: Page, options: DisplayOptions) {
  await expect(page.locator('html')).toHaveAttribute('dir', options.locale === 'en' ? 'ltr' : 'rtl');
  if (options.theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('h1')).toBeVisible();
  const settingsRail = page.locator('aside').filter({ has: page.locator('a[href="/settings/notifications"]') });
  await expect(settingsRail).toHaveCount(1);
  await expect(settingsRail.locator('a[aria-current="page"]')).toHaveCount(1);
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
  test(`${scenario.name}: settings remain responsive`, async ({ page }, testInfo) => {
    await prepareSettings(page, scenario);

    await page.goto('/settings');
    await expect(page).toHaveURL(/\/settings$/);
    await expectSettingsFrame(page, scenario);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-profile.png`), fullPage: true });
    if (scenario.width === 375) {
      const profileSave = page.getByRole('button', { name: scenario.locale === 'en' ? 'Save' : scenario.locale === 'he' ? 'שמירה' : 'حفظ', exact: true });
      await profileSave.scrollIntoViewIfNeeded();
      await expect(profileSave).toBeVisible();
    }

    await page.goto('/settings/notifications');
    await expect(page).toHaveURL(/\/settings\/notifications$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByRole('combobox')).toHaveCount(5);
    await expect(page.getByRole('checkbox')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-notifications.png`), fullPage: true });
    if (scenario.width === 375) {
      const notificationSave = page.getByRole('button', { name: scenario.locale === 'en' ? 'Save' : scenario.locale === 'he' ? 'שמירה' : 'حفظ', exact: true });
      await notificationSave.scrollIntoViewIfNeeded();
      await expect(notificationSave).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-notifications-bottom.png`) });
    }

    await page.goto('/settings/general');
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.locator('#organization-name')).toHaveValue('RabiTech Demo');
    await expect(page.locator('#inactivity-value')).toHaveValue('20');
    await expect(page.locator('#organization-timezone')).toHaveValue('Asia/Jerusalem');
    /*
      Name the toggles rather than counting them.

      This asserted toHaveCount(1) on a bare checkbox role, written when the
      page had one toggle. Quiet hours arrived beside the weekly recap and the
      count became 2, so all eighteen combinations went red — and stayed red
      across three commits, because a count of anonymous controls says nothing
      about what is on the page and fails for the one reason that is not a
      defect: the page legitimately grew.

      Naming them keeps the case alive in the direction that matters. Removing
      either toggle still fails here; adding a third does not.
    */
    const quietHours = page.getByRole('checkbox', { name: scenario.locale === 'en' ? 'Quiet hours' : scenario.locale === 'he' ? 'שעות שקט' : 'ساعات الهدوء' });
    const weeklyRecap = page.getByRole('checkbox', { name: scenario.locale === 'en' ? 'Weekly recap' : scenario.locale === 'he' ? 'סיכום שבועי' : 'الملخّص الأسبوعي' });
    await expect(quietHours).toHaveCount(1);
    await expect(weeklyRecap).toHaveCount(1);

    /*
      And every toggle here carries an accessible name.

      This is what makes the two assertions above possible, and it is the thing
      that would break first if somebody added a toggle without one — which is
      also the state that forces the next person back to counting.
    */
    const unnamedToggles = await page.getByRole('checkbox').evaluateAll((nodes) => nodes.filter((node) => {
      const labelled = node.getAttribute('aria-label')
        || (node.getAttribute('aria-labelledby') || '')
          .split(/\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent?.trim() || '')
          .join(' ').trim()
        || node.closest('label')?.textContent?.trim();
      return !labelled;
    }).length);
    expect(unnamedToggles, 'every toggle on organization settings needs an accessible name').toBe(0);

    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-organization-general.png`), fullPage: true });
    if (scenario.width === 375) {
      const workspaceSave = page.getByRole('button', { name: scenario.locale === 'en' ? 'Save' : scenario.locale === 'he' ? 'שמירה' : 'حفظ', exact: true });
      await workspaceSave.scrollIntoViewIfNeeded();
      await expect(workspaceSave).toBeVisible();
    }

    await page.goto('/settings/users');
    await expect(page).toHaveURL(/\/settings\/users$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Maya Saleh')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-users.png`), fullPage: true });

    await page.goto('/settings/teams');
    await expect(page).toHaveURL(/\/settings\/teams$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByText('Sales', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-teams.png`), fullPage: true });

    await page.goto('/settings/channels');
    await expect(page).toHaveURL(/\/settings\/channels$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByText('Sales WhatsApp', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-channels.png`), fullPage: true });

    await page.goto('/settings/lifecycle');
    await expect(page).toHaveURL(/\/settings\/lifecycle$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByText('Qualified', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-lifecycle.png`), fullPage: true });

    await page.goto('/settings/snippets');
    await expect(page).toHaveURL(/\/settings\/snippets$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByText('Welcome', { exact: true })).toBeVisible();
    await expect(page.getByText('Invoice copy', { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-snippets.png`), fullPage: true });

    await page.goto('/settings/tags');
    await expect(page).toHaveURL(/\/settings\/tags$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByRole('heading', { name: /VIP$/ })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-tags.png`), fullPage: true });

    await page.goto('/settings/contact-fields');
    await expect(page).toHaveURL(/\/settings\/contact-fields$/);
    await expectSettingsFrame(page, scenario);
    await expect(page.getByText('Account Tier', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-workspace-contact-fields.png`), fullPage: true });

    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.locator('html')).toHaveAttribute('dir', scenario.locale === 'en' ? 'ltr' : 'rtl');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${scenario.name}-onboarding.png`), fullPage: true });
  });
}

test('global Help menu is descriptive and onboarding progress persists', async ({ page }, testInfo) => {
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 375, height: 812 });
  await page.goto('/onboarding');

  await page.getByRole('button', { name: 'Open menu' }).click();
  const helpTrigger = page.getByRole('button', { name: 'Help' });
  await helpTrigger.click();
  const helpMenu = page.getByRole('menu');
  await expect(helpMenu.getByRole('menuitem')).toHaveCount(10);
  await expect(helpMenu.getByRole('menuitem', { name: /Help Center/ })).toContainText('Browse setup guides');
  await expect(helpMenu.getByRole('menuitem', { name: /Developer Documentation/ })).toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(250);
  await page.screenshot({ path: testInfo.outputPath('mobile-en-help-menu.png') });
  await page.keyboard.press('Escape');
  await expect(helpTrigger).toBeFocused();
  await page.goto('/onboarding');

  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  await page.getByRole('button', { name: 'Mark guide complete' }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  await page.reload();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
  await page.getByText('Learn lifecycle', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mark as incomplete' })).toBeVisible();
});

test('team settings save details, routing, capacity, and membership together', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined,
    undefined,
    undefined,
    undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/teams');

  await page.getByRole('button', { name: 'Team actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Edit team' }).click();
  const drawer = page.getByRole('dialog', { name: 'Sales' });
  await drawer.getByLabel('Team name').fill('Sales Operations');
  await drawer.getByRole('button', { name: 'Round robin' }).click();
  await drawer.getByLabel('Conversation limit per agent').fill('8');
  await drawer.getByText('Settings Operator').click();
  await page.screenshot({ path: testInfo.outputPath('desktop-en-team-editor.png'), fullPage: true });
  await drawer.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => requests).toEqual([
    {
      method: 'PATCH', path: '/api/system/teams/team-sales',
      payload: {
        name: 'Sales Operations', description: 'Revenue conversations', color: '#059669',
        isDefault: true, assignmentStrategy: 'ROUND_ROBIN', maxConcurrentPerAgent: 8,
      },
    },
    {
      method: 'PUT', path: '/api/system/teams/team-sales/members',
      payload: { userIds: ['settings-agent', String(session().user.id)] },
    },
  ]);
});

test('channel settings disconnect safely and expose QR pairing for an unlinked session', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/channels');

  const salesCard = page.locator('article').filter({ hasText: 'Sales WhatsApp' });
  await salesCard.getByRole('button', { name: 'View channel' }).click();
  const drawer = page.getByRole('dialog', { name: 'Sales WhatsApp' });
  await drawer.getByRole('button', { name: 'Disconnect temporarily' }).click();
  await page.getByRole('button', { name: 'Disconnect temporarily' }).last().click();

  await expect.poll(() => requests).toContainEqual({
    method: 'POST',
    path: '/api/system/sessions/sales-whatsapp/disconnect',
    payload: { unlink: false },
  });
  await page.getByRole('button', { name: 'Close' }).last().click();

  const supportCard = page.locator('article').filter({ hasText: 'Support WhatsApp' });
  await supportCard.getByRole('button', { name: 'Link device' }).click();
  await expect(page.getByRole('dialog', { name: 'Link WhatsApp device' }).getByRole('img', { name: 'WhatsApp linking QR code' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('channel-qr-pairing.png'), fullPage: true });
});

test('channel settings show capabilities and require the explicit Meta loss warning before switching to OpenWA', async ({ page }) => {
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });
  let openWAActive = false;
  const activationRequests: Record<string, unknown>[] = [];

  await page.unroute('**/api/system/sessions**');
  await page.route('**/api/system/sessions**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET' && path === '/api/system/sessions') {
      await route.fulfill({ json: [{
        id: 'session-sales', sessionName: 'sales-whatsapp', label: 'Sales WhatsApp',
        connected: true, connectionStatus: 'CONNECTED', phoneNumber: '+970599111222',
        teamId: 'team-sales', isActive: true, isActiveChannel: openWAActive,
      }] });
      return;
    }
    await route.continue();
  });

  await page.unroute('**/api/channels/**');
  await page.route('**/api/channels/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/channels/capabilities') {
      await route.fulfill({ json: { capabilities: openWAActive ? {
        kind: 'OPENWA', requiresServiceWindow: false, supportsTemplates: false,
        supportsQrPairing: true, maxUniqueRecipientsPer24h: null,
        canInitiateConversations: true, messagingTier: null, qualityRating: null,
      } : {
        kind: 'WHATSAPP_CLOUD', requiresServiceWindow: true, supportsTemplates: false,
        supportsQrPairing: false, maxUniqueRecipientsPer24h: 250,
        canInitiateConversations: false, messagingTier: null, qualityRating: null,
      } } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/channels/meta') {
      await route.fulfill({ json: { channel: {
        connected: true, status: 'ACTIVE', phoneNumberId: '123456789',
        displayPhoneNumber: '+970599333444', verifiedName: 'RabiTech Demo',
        qualityRating: 'GREEN', messagingTier: 'TIER_250', lastValidatedAt: null,
        invalidReason: null, graphVersion: 'v21.0', isActiveChannel: !openWAActive,
      } } });
      return;
    }
    if (request.method() === 'POST' && path === '/api/channels/active') {
      activationRequests.push(request.postDataJSON());
      openWAActive = true;
      await route.fulfill({ json: { activeKind: 'OPENWA', capabilities: null } });
      return;
    }
    await route.continue();
  });

  await page.goto('/settings/channels');
  await expect(page.getByText('Start new conversations', { exact: true })).toBeVisible();
  await expect(page.getByText('Unavailable', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/broadcasts and first-contact messages will be refused/)).toBeVisible();

  await page.getByRole('button', { name: 'Send through OpenWA' }).click();
  const dialog = page.getByRole('dialog', { name: 'Switch sending channel to OpenWA?' });
  await expect(dialog).toContainText('customer messages sent to the inactive Meta number will not reach RabiTech until Meta is reactivated');
  expect(activationRequests).toEqual([]);
  await dialog.getByRole('button', { name: 'Send through OpenWA' }).click();
  await expect.poll(() => activationRequests).toEqual([{ kind: 'OPENWA' }]);
});

test('OpenWA activation explains a failed live connection probe', async ({ page }) => {
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });
  await page.unroute('**/api/system/sessions**');
  await page.route('**/api/system/sessions**', async (route) => {
    await route.fulfill({ json: [{
      id: 'session-sales', sessionName: 'sales-whatsapp', label: 'Sales WhatsApp',
      connected: false, connectionStatus: 'UNAVAILABLE', phoneNumber: '+970599111222',
      teamId: 'team-sales', isActive: true, isActiveChannel: false,
    }] });
  });

  await page.goto('/settings/channels');
  await expect(page.getByRole('button', { name: 'Send through OpenWA' })).toBeDisabled();
  await expect(page.getByText('RabiTech could not check whether OpenWA is connected. Check again before switching.')).toBeVisible();
});

test('CHANNEL_AMBIGUOUS renders and repairs through the transactional active-channel endpoint', async ({ page }) => {
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });
  let ambiguous = true;
  const activationRequests: Record<string, unknown>[] = [];
  await page.unroute('**/api/channels/**');
  await page.route('**/api/channels/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/channels/capabilities') {
      if (ambiguous) {
        await route.fulfill({ status: 409, json: {
          code: 'CHANNEL_AMBIGUOUS', error: 'ambiguous', capabilities: null,
        } });
      } else {
        await route.fulfill({ json: { capabilities: {
          kind: 'OPENWA', requiresServiceWindow: false, supportsTemplates: false,
          supportsQrPairing: true, maxUniqueRecipientsPer24h: null,
          canInitiateConversations: true, messagingTier: null, qualityRating: null,
        } } });
      }
      return;
    }
    if (request.method() === 'POST' && path === '/api/channels/active') {
      activationRequests.push(request.postDataJSON());
      ambiguous = false;
      await route.fulfill({ json: { activeKind: 'OPENWA', capabilities: null } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/channels/meta') {
      await route.fulfill({ json: { channel: null } });
      return;
    }
    await route.continue();
  });

  await page.goto('/settings/channels');
  await expect(page.getByText('More than one sending channel is active')).toBeVisible();
  await page.getByRole('button', { name: 'Use OpenWA and repair sending' }).click();
  const dialog = page.getByRole('dialog', { name: 'Switch sending channel to OpenWA?' });
  await dialog.getByRole('button', { name: 'Use OpenWA and repair sending' }).click();
  await expect.poll(() => activationRequests).toEqual([{ kind: 'OPENWA' }]);
  await expect(page.getByText('More than one sending channel is active')).not.toBeVisible();
});

test('lifecycle settings create, reorder, select default, and reassign contacts on delete', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/lifecycle');

  const qualified = page.locator('article').filter({ has: page.getByText('Qualified', { exact: true }) });
  await qualified.getByRole('button', { name: 'Stage actions' }).click();
  await page.getByRole('menuitem', { name: 'Set as default' }).click();
  await expect.poll(() => requests).toContainEqual({ method: 'PATCH', path: '/api/lifecycle-stages/stage-qualified', payload: { isDefault: true } });

  const lead = page.locator('article').filter({ hasText: 'Lead' });
  await lead.getByRole('button', { name: 'Move down' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'PUT', path: '/api/lifecycle-stages/reorder/all',
    payload: { kind: 'ACTIVE', stageIds: ['stage-qualified', 'stage-lead', 'stage-customer'] },
  });

  const lostColumn = page.getByRole('region', { name: 'Lost stages' });
  await lostColumn.getByRole('button', { name: 'Add stage' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add lost stage' });
  await addDialog.getByLabel('Stage name').fill('No response');
  await addDialog.getByLabel('Description').fill('Follow-ups received no response');
  await addDialog.getByLabel('Emoji or short symbol').fill('NR');
  await page.screenshot({ path: testInfo.outputPath('lifecycle-add-lost-stage.png'), fullPage: true });
  await addDialog.getByRole('button', { name: 'Add stage' }).click();
  await expect.poll(() => requests.some((request) => request.method === 'POST' && request.payload?.kind === 'LOST' && request.payload?.name === 'No response')).toBe(true);

  const unqualified = page.locator('article').filter({ hasText: 'Unqualified' });
  await unqualified.getByRole('button', { name: 'Stage actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete stage' }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete lifecycle stage' });
  await deleteDialog.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Qualified' }).click();
  await deleteDialog.getByRole('button', { name: 'Delete stage' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'DELETE', path: '/api/lifecycle-stages/stage-unqualified',
    payload: { reassignToStageId: 'stage-qualified' },
  });
});

test('Snippet settings create a topic-aware reply with a dynamic variable', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 375, height: 812 },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/snippets');
  await page.getByRole('button', { name: 'Add Snippet' }).click();
  const drawer = page.getByRole('dialog', { name: 'Add Snippet' });
  await drawer.getByLabel('Name').fill('Shipping update');
  await drawer.getByLabel('Shortcut').fill('shipping');
  await drawer.getByLabel('Message').fill('Hello ');
  await drawer.getByRole('button', { name: '$contact.name' }).click();
  await drawer.getByText('Support', { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('mobile-en-snippet-editor.png'), fullPage: true });
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'POST', path: '/api/snippets',
    payload: { title: 'Shipping update', body: 'Hello $contact.name', shortCode: 'shipping', topicIds: ['topic-support'], isActive: true },
  });
});

test('Tag settings create shared metadata and require the exact assigned count for deletion', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 375, height: 812 },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/tags');
  await page.getByRole('button', { name: 'Create Tag' }).click();
  const drawer = page.getByRole('dialog', { name: 'Create Tag' });
  await drawer.getByLabel('Name').fill('Renewal');
  await drawer.getByLabel('Emoji').fill('R');
  await drawer.getByRole('button', { name: 'Select color #0f766e' }).click();
  await drawer.getByLabel('Description').fill('Contract renewal follow-up');
  await page.screenshot({ path: testInfo.outputPath('mobile-en-tag-editor.png'), fullPage: true });
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'POST', path: '/api/contacts/tags',
    payload: { name: 'Renewal', emoji: 'R', colorCode: '#0f766e', description: 'Contract renewal follow-up' },
  });

  const vip = page.locator('article').filter({ has: page.getByRole('heading', { name: /VIP$/ }) });
  await vip.getByRole('button', { name: 'Tag actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete Tag' }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete Tag permanently' });
  await expect(deletion.getByRole('button', { name: 'Delete Tag' })).toBeDisabled();
  await deletion.getByLabel(/Enter the assigned Contact count/).fill('12');
  await deletion.getByRole('button', { name: 'Delete Tag' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'DELETE', path: '/api/contacts/tags/tag-vip', payload: { confirmCount: 12 },
  });
});

test('Contact field settings create typed fields and persist workspace-wide view order', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; path: string; payload?: Record<string, unknown> }> = [];
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    (method, path, payload) => { if (method !== 'GET') requests.push({ method, path, payload }); },
  );
  await page.goto('/settings/contact-fields');
  await page.getByRole('button', { name: 'Add custom field' }).click();
  const editor = page.getByRole('dialog', { name: 'Add custom field' });
  await editor.getByLabel('Name').fill('Renewal Status');
  await expect(editor.getByLabel('Field ID')).toHaveValue('renewal_status');
  await editor.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Field type: list' }).click();
  await editor.getByLabel('List values').fill('Pending\nConfirmed\nExpired');
  await editor.getByLabel('Description').fill('Current contract renewal state');
  await page.screenshot({ path: testInfo.outputPath('desktop-en-contact-field-editor.png'), fullPage: true });
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => requests).toContainEqual({
    method: 'POST', path: '/api/contacts/custom-fields',
    payload: { name: 'Renewal Status', slug: 'renewal_status', dataType: 'list', description: 'Current contract renewal state', allowedValues: ['Pending', 'Confirmed', 'Expired'] },
  });

  await page.getByRole('button', { name: 'Customize view' }).click();
  const view = page.getByRole('dialog', { name: 'Customize Contact field view' });
  await view.getByRole('button', { name: 'Move up Account Tier' }).click();
  await view.getByRole('button', { name: 'Save view' }).click();
  await expect.poll(() => requests.some((request) => request.method === 'PUT'
    && request.path === '/api/contacts/contact-fields/view'
    && Array.isArray(request.payload?.fields))).toBe(true);
});

test('workspace settings submit name, idle policy, timezone, recap state, and recipients together', async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined,
    (payload) => { saved = payload; },
  );
  await page.goto('/settings/general');

  await page.locator('#organization-name').fill('RabiTech Operations');
  await page.locator('#inactivity-value').fill('2');
  await page.getByRole('combobox', { name: 'Inactivity timeout unit' }).click();
  await page.getByRole('option', { name: 'Hours' }).click();
  await page.locator('#organization-timezone').fill('Asia/Hebron');
  await page.getByRole('combobox', { name: 'Select an organization member' }).click();
  await page.getByRole('option', { name: /Maya Saleh/ }).click();
  await page.getByRole('button', { name: 'Add recipient' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect.poll(() => saved).toEqual({
    name: 'RabiTech Operations',
    timezone: 'Asia/Hebron',
    userInactivityTimeoutMinutes: 120,
    weeklyRecapEnabled: true,
    weeklyRecapRecipientIds: [String(session().user.id), 'settings-supervisor'],
  });
});

test('workspace users send invitations and persist server-enforced restrictions', async ({ page }) => {
  let invited: Record<string, unknown> | null = null;
  let saved: Record<string, unknown> | null = null;
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    undefined,
    undefined,
    (payload) => { saved = payload; },
    (payload) => { invited = payload; },
  );
  await page.goto('/settings/users');

  await page.getByRole('button', { name: 'Invite user' }).click();
  const inviteDialog = page.getByRole('dialog', { name: 'Invite user' });
  await inviteDialog.getByLabel('Name').fill('Nadia Saleh');
  await inviteDialog.getByLabel('Email').fill('nadia@rabitech.test');
  await inviteDialog.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Manager' }).click();
  await inviteDialog.getByRole('combobox').nth(1).click();
  await page.getByRole('option', { name: 'Support' }).click();
  await inviteDialog.getByRole('button', { name: 'Send invitation' }).click();
  await expect.poll(() => invited).toEqual({
    name: 'Nadia Saleh', email: 'nadia@rabitech.test', role: 'SUPERVISOR', primaryTeamId: 'team-support',
  });

  await page.getByRole('tab', { name: /Members/ }).click();
  await page.getByRole('button', { name: /Maya Saleh/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Maya Saleh' });
  await drawer.getByRole('checkbox', { name: 'Restrict contact visibility' }).check();
  await drawer.getByRole('checkbox', { name: 'Hide Workflows button' }).check();
  await drawer.getByRole('button', { name: 'Save' }).click();
  /*
    Every restriction the form owns, listed.

    Four arrived after this expectation was written - contact deletion, data
    export, integrations and organization settings - and the object was never
    updated, so this has failed on four extra keys ever since. Listing all of
    them is deliberate rather than switching to a partial match: a restriction
    the form stops submitting is a permission silently not applied, and an
    assertion that ignores unknown keys would not notice a new one going
    unsent either. This failing when a flag is added is the correct signal.

    restrictWorkspaceSettings keeps its name because it is a database column;
    the vocabulary commit renamed its message and left the column alone.
  */
  await expect.poll(() => saved).toEqual({
    role: 'AGENT', primaryTeamId: 'team-sales', teamIds: ['team-sales'], isActive: true,
    restrictContactVisibility: true, contactVisibilityScope: 'TEAM', restrictCalls: false,
    restrictWorkflows: true, maskPhoneAndEmail: false,
    restrictContactDeletion: false, restrictDataExport: false,
    restrictIntegrations: false, restrictWorkspaceSettings: false,
  });
});

for (const locale of locales) {
  test(`invitation acceptance renders correctly in ${locale}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.addInitScript(({ selectedLocale }) => {
      localStorage.setItem('rabitech_locale', selectedLocale);
      localStorage.setItem('rabitech_theme', 'light');
    }, { selectedLocale: locale });
    await page.route('**/api/auth/invitations/demo-token', (route) => route.fulfill({ json: {
      email: 'invitee@rabitech.test', name: 'Nadia Saleh', role: 'AGENT', invitedByName: 'RabiTech Owner',
      expiresAt: '2026-09-01T12:00:00.000Z', workspaceName: 'RabiTech Demo', teamName: 'Support',
      requiresExistingPassword: false,
    } }));
    await page.goto('/accept-invite?token=demo-token');
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'en' ? 'ltr' : 'rtl');
    await expect(page.getByText('invitee@rabitech.test')).toBeVisible();
    await expect(page.getByLabel(locale === 'en' ? 'Name' : locale === 'he' ? 'שם' : 'الاسم')).toHaveValue('Nadia Saleh');
    await expect.poll(() => page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`accept-invite-${locale}.png`), fullPage: true });
  });
}

test('notification settings submit all delivery controls and the sound preference', async ({ page }) => {
  let saved: Record<string, unknown> | null = null;
  await prepareSettings(
    page,
    { locale: 'en', theme: 'light', width: 1440, height: 900 },
    (payload) => { saved = payload; },
  );
  await page.goto('/settings/notifications');

  const deliveryControls = page.getByRole('combobox');
  await expect(deliveryControls).toHaveCount(5);
  await deliveryControls.first().click();
  await page.getByRole('option', { name: 'Disabled' }).click();
  const soundToggle = page.getByRole('checkbox', { name: 'Notification sound' });
  await soundToggle.focus();
  await page.keyboard.press('Space');
  await expect(soundToggle).not.toBeChecked();
  await page.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => saved).toEqual({
    notificationNewMessage: 'OFF',
    notificationAssignment: 'IN_APP',
    notificationMention: 'IN_APP',
    notificationResolution: 'IN_APP',
    notificationEscalation: 'IN_APP',
    notificationSound: false,
  });
});

test('two-factor setup requires password, verifies a code, and protects recovery-code acknowledgement', async ({ page }, testInfo) => {
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 375, height: 812 });
  const recoveryCodes = Array.from({ length: 10 }, (_, index) => `ABCD-EFGH-${String(index).padStart(4, '0')}`);
  let enablePayload: Record<string, unknown> | null = null;

  await page.route('**/api/auth/me/2fa/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.endsWith('/setup')) {
      await route.fulfill({ json: {
        secret: 'JBSWY3DPEHPK3PXP',
        setupToken: 'signed-setup-token',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4WQAAAAASUVORK5CYII=',
        expiresIn: 600,
      } });
      return;
    }
    if (request.method() === 'POST' && path.endsWith('/enable')) {
      enablePayload = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { enabled: true, recoveryCodes, signedOutEverywhere: true } });
      return;
    }
    await route.continue();
  });

  await page.goto('/settings');
  const twoFactorToggle = page.getByRole('checkbox', { name: 'Two-factor authentication' });
  await twoFactorToggle.focus();
  await page.keyboard.press('Space');

  const dialog = page.getByRole('dialog', { name: 'Enable two-factor authentication' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Current password').fill('Strong-password-123!');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByRole('img', { name: 'QR code for authenticator setup' })).toBeVisible();
  await expect(dialog.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await dialog.getByLabel('Verification code').fill('123456');
  await dialog.getByRole('button', { name: 'Verify and enable' }).click();

  await expect.poll(() => enablePayload).toEqual({ setupToken: 'signed-setup-token', code: '123456' });
  await expect(page.getByRole('dialog', { name: 'Save your recovery codes' })).toBeVisible();
  await expect(page.locator('code')).toHaveCount(10);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Save your recovery codes' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mobile-recovery-codes.png') });

  const confirmation = page.getByRole('checkbox', { name: 'I stored the recovery codes somewhere safe' });
  await confirmation.check();
  await page.getByRole('button', { name: 'Sign out and continue' }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('two-factor login accepts the challenge step and exposes recovery-code fallback', async ({ page }) => {
  let verificationPayload: Record<string, unknown> | null = null;
  await page.route('**/api/auth/login', (route) => route.fulfill({ status: 202, json: {
    requiresTwoFactor: true,
    challengeToken: 'login-challenge',
    expiresIn: 300,
  } }));
  await page.route('**/api/auth/2fa/login', async (route) => {
    verificationPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: {
      token: 'verified-session',
      scope: 'ORGANIZATION',
      user: { id: 'settings-user', name: 'Settings Operator', role: 'ADMIN', scope: 'ORGANIZATION' },
    } });
  });
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: profile({ locale: 'en', theme: 'light', width: 375, height: 812 }) }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/auth/')) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => {
    localStorage.setItem('rabitech_locale', 'en');
    localStorage.setItem('rabitech_theme', 'light');
  });
  await page.goto('/login');
  await page.getByLabel('Email').fill('operator@rabitech.test');
  await page.getByLabel('Password', { exact: true }).fill('Strong-password-123!');
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await expect(page.getByLabel('Recovery code')).toBeVisible();
  await page.getByRole('button', { name: 'Use authenticator app' }).click();
  await page.getByLabel('Verification code').fill('654321');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();

  await expect.poll(() => verificationPayload).toEqual({ challengeToken: 'login-challenge', code: '654321' });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('rabitech_token'))).toBe('verified-session');
});

test('disabling two-factor authentication requires password and a current factor', async ({ page }) => {
  let disablePayload: Record<string, unknown> | null = null;
  await prepareSettings(page, { locale: 'en', theme: 'light', width: 1440, height: 900 });
  await page.route('**/api/auth/me', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { ...profile({ locale: 'en', theme: 'light', width: 1440, height: 900 }), twoFactorEnabled: true } });
    } else await route.continue();
  });
  await page.route('**/api/auth/me/2fa', async (route) => {
    disablePayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ json: { enabled: false, signedOutEverywhere: true } });
  });

  await page.goto('/settings');
  const toggle = page.getByRole('checkbox', { name: 'Two-factor authentication' });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  const dialog = page.getByRole('dialog', { name: 'Disable two-factor authentication' });
  await dialog.getByLabel('Current password').fill('Strong-password-123!');
  await dialog.getByLabel('Verification or recovery code').fill('ABCD-EFGH-0001');
  await dialog.getByRole('button', { name: 'Disable two-factor authentication' }).click();
  await expect.poll(() => disablePayload).toEqual({ currentPassword: 'Strong-password-123!', code: 'ABCD-EFGH-0001' });
  await expect(page).toHaveURL(/\/login$/);
});

// ---------------------------------------------------------------------------
// /settings/conversations — Conversation Operations (migration 64).
//
// The API is mocked, as everywhere else in this matrix, so these run without a
// backend or a database. That is what makes them safe to run while migration 64
// is still unapplied: the mock defines the shape the screen must render, and
// the server-side contracts are proved separately by the isolation gate.
// ---------------------------------------------------------------------------

type ConversationSettingsPayload = Record<string, unknown>;

const conversationSettingsFixture = () => ({
  autoCloseEnabled: true,
  autoCloseDurationMinutes: 120,
  autoCloseEnabledAt: '2026-08-20T09:00:00.000Z',
  manualClosingNotesEnabled: false,
  manualClosingNoteMode: 'OPTIONAL',
  categories: [
    { id: 'cat-resolved', name: 'Resolved', description: 'Customer question answered' },
    { id: 'cat-duplicate', name: 'Duplicate', description: null },
  ],
  limits: { minAutoCloseMinutes: 30, maxAutoCloseMinutes: 20160, maxCategories: 50 },
});

async function mockConversationSettings(
  page: Page,
  onPatch?: (payload: ConversationSettingsPayload) => void,
) {
  const current = conversationSettingsFixture();
  await page.route('**/api/conversation-settings**', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET') {
      await route.fulfill({ json: current });
      return;
    }
    if (method === 'PATCH') {
      const payload = request.postDataJSON() as ConversationSettingsPayload;
      onPatch?.(payload);
      Object.assign(current, payload);
      await route.fulfill({ json: current });
      return;
    }
    await route.fulfill({ json: current });
  });
}

for (const scenario of scenarios) {
  test(`${scenario.name}: conversation settings remain responsive`, async ({ page }, testInfo) => {
    await prepareSettings(page, scenario);
    await mockConversationSettings(page);

    await page.goto('/settings/conversations');
    await expect(page).toHaveURL(/\/settings\/conversations$/);

    // Direction, theme, a single current rail item, and no horizontal overflow
    // at 375 / 768 / 1440. Two of the three languages are right-to-left.
    await expectSettingsFrame(page, scenario);

    // The two policy sections must both render, in every language.
    await expect(page.locator('#auto-close-title')).toBeVisible();
    await expect(page.locator('#categories-title')).toBeVisible();

    // Categories arrive from the server, not from hardcoded copy.
    await expect(page.getByText('Resolved', { exact: true })).toBeVisible();

    await page.screenshot({
      path: testInfo.outputPath(`${scenario.name}-conversations.png`),
      fullPage: true,
    });
  });
}

test('closing-note policy mutation sends exactly what the operator chose', async ({ page }) => {
  const patches: ConversationSettingsPayload[] = [];
  const display = { locale: 'en', theme: 'light', width: 1440, height: 900 } as const;

  await prepareSettings(page, display);
  await mockConversationSettings(page, (payload) => patches.push(payload));

  await page.goto('/settings/conversations');
  await expect(page.locator('#auto-close-title')).toBeVisible();

  // Turning closing notes on is the control that makes a category mandatory at
  // close time. The server enforces the rule independently - this asserts the
  // UI asks for the right thing, not that the rule holds.
  const closingNotes = page.getByRole('switch', { name: 'Closing notes' });
  await expect(closingNotes).toBeVisible();
  await closingNotes.click();

  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect.poll(() => patches.length).toBeGreaterThan(0);
  const sent = patches[patches.length - 1];
  expect(sent).toHaveProperty('manualClosingNotesEnabled', true);
});
