#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const { io: createSocketClient } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const results = [];

require('dotenv').config({ path: path.join(ROOT, '.env') });
require('ts-node/register/transpile-only');

function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  const symbol = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`[${symbol}] ${name}${detail ? `: ${detail}` : ''}\n`);
}

async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function command(name, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
    record(name, false, output || `exit ${result.status}`);
    return false;
  }
  record(name, true);
  return true;
}

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'logs') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

/** Any direct use of the PlatformAuditLog delegate. */
const PLATFORM_AUDIT_REF = /(?:prisma|tx)\.platformAuditLog/;

function staticAudits() {
  const sourceFiles = walk(path.join(ROOT, 'src')).filter((file) => file.endsWith('.ts'));
  const projectFiles = walk(ROOT).filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file));

  const allowedPrismaClients = new Set([
    'src/prisma/index.ts',
    'prisma/seed.ts',
    'scripts/backfill-group-messages.ts',
    'scripts/bootstrap-platform-owner.ts',
    'scripts/cleanup-test-data.ts',
    'scripts/fix-lid-contact.ts',
    'scripts/list-convs.ts',
  ]);
  const bareClients = [];
  for (const file of projectFiles) {
    const rel = relative(file);
    if (
      allowedPrismaClients.has(rel) ||
      rel === 'scripts/tenancy-bleed-harness.js' ||
      rel === 'scripts/lint-prisma-client.js'
    ) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/new\s+PrismaClient\s*\(/.test(line) && !line.trim().startsWith('//')) {
        bareClients.push(`${rel}:${index + 1}`);
      }
    });
  }
  record(
    'audit: no unreviewed PrismaClient constructors',
    bareClients.length === 0,
    bareClients.join(', '),
  );

  // PlatformAuditLog sits in the tenancy extension PLATFORM_MODELS list, so
  // under ORGANIZATION scope the extension injects nothing at all. A
  // tenant-scoped read would return every subscriber commercial history —
  // negotiated discounts included. Nothing outside platform code reads it
  // today; this check makes sure nothing starts.
  const auditLeaks = [];
  const auditAllowed = new Set(['src/lib/audit.ts']);
  for (const file of sourceFiles) {
    const rel = relative(file);
    if (auditAllowed.has(rel) || rel.startsWith('src/modules/platform/')) continue;
    const auditLines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    auditLines.forEach((line, index) => {
      const trimmed = line.trim();
      if (PLATFORM_AUDIT_REF.test(line) && !trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        auditLeaks.push(`${rel}:${index + 1}`);
      }
    });
  }
  record(
    'audit: PlatformAuditLog is reachable only from platform scope',
    auditLeaks.length === 0,
    auditLeaks.join(', '),
  );

  // findFirst/findFirstOrThrow were absent from both injection lists in the
  // tenancy extension and therefore ran unscoped — found while building P10-a,
  // with roughly twenty call sites across the backend including the inbound
  // message path. This pins the fix.
  const extensionSource = fs.readFileSync(
    path.join(ROOT, 'src', 'prisma', 'extensions.ts'), 'utf8');
  const findFirstScoped = /'findFirst'/.test(extensionSource) && /'findFirstOrThrow'/.test(extensionSource);
  record(
    'audit: tenancy extension scopes findFirst and findFirstOrThrow',
    findFirstScoped,
    findFirstScoped ? '' : 'findFirst is not in the injected operation list',
  );

  // HTTP_WEBHOOK is the first place this backend requests a URL a CUSTOMER
  // chose, on a network carrying postgres, redis and the WhatsApp gateway.
  // These are the addresses that must never be reachable through it.
  const ssrf = require(path.join(ROOT, 'src', 'modules', 'workflows', 'outbound-url.ts'));
  const privateTargets = [
    '127.0.0.1', '10.0.0.5', '172.17.0.2', '192.168.1.10',
    '169.254.169.254', '::1', '::ffff:127.0.0.1', 'not-an-ip',
  ];
  const leaked = privateTargets.filter((address) => !ssrf.isPrivateAddress(address));
  record(
    'audit: workflow webhook guard rejects internal addresses',
    leaked.length === 0,
    leaked.length ? `treated as public: ${leaked.join(', ')}` : '',
  );

  const mutableCaches = [];
  for (const file of sourceFiles) {
    const rel = relative(file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (/^(?:const|let)\s+\w*(?:cache|keywords)\w*\s*=\s*new\s+(?:Map|Set)\b/i.test(line.trim())) {
        mutableCaches.push(`${rel}:${index + 1} ${line.trim()}`);
      }
    });
  }
  record(
    'audit: no module-scope mutable tenant caches',
    mutableCaches.length === 0,
    mutableCaches.join(' | '),
  );

  const socketViolations = [];
  for (const file of sourceFiles) {
    const rel = relative(file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const scopedRoomVariables = new Set();
    lines.forEach((line) => {
      const declaration = line.match(/\bconst\s+(\w+)\s*=\s*(?:.+\?\s*)?socketRoom\./);
      if (declaration) scopedRoomVariables.add(declaration[1]);
    });
    lines.forEach((line, index) => {
      const roomOperation = /\.to\s*\(/.test(line) || /\bsocket\.join\s*\(/.test(line);
      const globalEmit = /getIO\(\)\.emit\s*\(/.test(line);
      const helperRoom = line.includes('socketRoom.') || [...scopedRoomVariables].some((variable) =>
        new RegExp(`(?:\\.to|socket\\.join)\\s*\\(\\s*${variable}\\s*\\)`).test(line),
      );
      if (globalEmit || (roomOperation && !helperRoom)) {
        socketViolations.push(`${rel}:${index + 1} ${line.trim()}`);
      }
    });
  }
  record(
    'audit: every socket room is organization-prefixed',
    socketViolations.length === 0,
    socketViolations.slice(0, 20).join(' | '),
  );

  const schema = fs.readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
  record(
    'audit: WorkingHours is organization-scoped',
    /model\s+WorkingHours\s*\{[\s\S]*?organizationId\s+String[\s\S]*?@@unique\(\[organizationId\]\)/.test(schema),
    'WorkingHours must carry organizationId with one row per organization',
  );
}

function makeTestUrl(baseUrl, schema) {
  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function stable(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBackend(baseUrl, token, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`backend exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/contacts`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      if (response.status < 500) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('backend did not become ready');
}

async function httpSnapshot(baseUrl, token, fixture) {
  const routes = [
    '/api/network',
    '/api/auth/me',
    '/api/notifications',
    '/api/contacts',
    '/api/conversations',
    `/api/conversations/${fixture.records[0].conversation.id}/messages`,
    '/api/templates',
    '/api/campaigns',
    '/api/system/stats',
    '/api/system/users',
    '/api/system/inbox-config',
    '/api/system/sessions',
    '/api/system/working-hours',
    '/api/system/keywords',
    '/api/usage/current',
    '/api/analytics/agents',
    '/api/analytics/summary',
  ];
  const snapshot = {};
  for (const route of routes) {
    const response = await fetch(`${baseUrl}${route}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    let text = await response.text();
    if (route === '/api/analytics/summary' && response.ok) {
      const body = JSON.parse(text);
      body.timestamp = '<volatile-response-time>';
      text = JSON.stringify(body);
    }
    snapshot[route] = { status: response.status, body: text };
  }
  return snapshot;
}

function startTestBackend(testUrl, tokenSecret) {
  const port = 4200 + (process.pid % 500);
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      JWT_SECRET: tokenSecret,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      DISABLE_CAMPAIGN_WORKER: '1',
      DISABLE_MESSAGE_WORKER: '1',
      DISABLE_ESCALATION_WORKER: '1',
      DISABLE_USAGE_ROLLUP_WORKER: '1',
      DISABLE_BILLING_RECONCILIATION_WORKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function connectSocket(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const socket = createSocketClient(baseUrl, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('socket connection timed out'));
    }, 3000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function seedOrganization(raw, key, volume) {
  const organizationId = `bleed_org_${key}`;
  const identityId = `bleed_identity_${key}`;
  const userId = `bleed_user_${key}`;
  const sessionId = `bleed_session_${key}`;

  await raw.organization.create({
    data: { id: organizationId, name: `Bleed Org ${key}`, slug: `bleed-${key}`, status: 'ACTIVE' },
  });
  await raw.identity.create({
    data: { id: identityId, email: `bleed-${key}@rabitech.test`, passwordHash: 'not-used' },
  });
  await raw.user.create({
    data: {
      id: userId,
      organizationId,
      identityId,
      name: `Admin ${key}`,
      role: 'ADMIN',
    },
  });
  await raw.whatsappSession.create({
    data: {
      id: sessionId,
      organizationId,
      sessionName: 'it-support',
      label: 'WhatsApp',
    },
  });
  await raw.organizationConfig.create({
    data: { organizationId },
  });

  const records = [];
  for (let index = 0; index < volume; index += 1) {
    const suffix = `${key}_${index}`;
    const contact = await raw.contact.create({
      data: {
        id: `bleed_contact_${suffix}`,
        organizationId,
        phone: index === 0 ? '+972500000001' : `+9725${key.charCodeAt(0)}${String(index).padStart(6, '0')}`,
        name: `Contact ${suffix}`,
      },
    });
    const conversation = await raw.conversation.create({
      data: {
        id: `bleed_conversation_${suffix}`,
        organizationId,
        displayId: 1001 + index,
        contactId: contact.id,
        sessionId,
        status: 'OPEN',
      },
    });
    await raw.message.create({
      data: {
        id: `bleed_message_${suffix}`,
        organizationId,
        conversationId: conversation.id,
        waMessageId: `provider-${suffix}`,
        direction: 'INBOUND',
        status: 'DELIVERED',
        body: `Message ${suffix}`,
      },
    });
    records.push({ contact, conversation });
  }

  await raw.messageTemplate.create({
    data: {
      id: `bleed_template_${key}`,
      organizationId,
      title: `Greeting ${key}`,
      body: 'Hello',
      shortCode: 'hello',
    },
  });
  await raw.keyword.create({
    data: {
      id: `bleed_keyword_${key}`,
      organizationId,
      category: 'HIGH',
      phrase: 'overlapping phrase',
    },
  });

  return { organizationId, identityId, userId, sessionId, records };
}

async function seedProvisioningOrganization(raw, key) {
  const organizationId = `gateway_org_${key}`;
  const slug = `gateway-${key}`;
  await raw.organization.create({
    data: { id: organizationId, name: `Gateway Org ${key}`, slug, status: 'PROVISIONING' },
  });
  await raw.whatsappSession.create({
    data: {
      organizationId,
      sessionName: `${slug}-primary`,
      label: 'WhatsApp',
    },
  });
  await raw.organizationChannel.create({
    data: {
      organizationId,
      kind: 'OPENWA',
      baseUrl: '',
      apiKeyEnc: '',
      webhookToken: `gateway_token_${key}`,
      status: 'PENDING',
      managedByProvisioner: true,
      provisioningState: 'PENDING',
      provisioningStep: 'ALLOCATE_RESOURCES',
    },
  });
  return { organizationId, slug };
}

function provisioningFakes() {
  const deployments = new Map();
  const stopped = new Set();
  const destroyed = new Set();
  const failOnce = new Set();
  const providerStates = new Map();
  const runtime = {
    async createAndStart(deployment) {
      deployments.set(deployment.deploymentName, { ...deployment });
      stopped.delete(deployment.deploymentName);
      if (failOnce.delete(deployment.deploymentName)) throw new Error('simulated process interruption');
    },
    async start(deployment) {
      assert.ok(deployments.has(deployment.deploymentName));
      stopped.delete(deployment.deploymentName);
    },
    async stop(deployment) {
      assert.ok(deployments.has(deployment.deploymentName));
      stopped.add(deployment.deploymentName);
    },
    async restart(deployment) {
      assert.ok(deployments.has(deployment.deploymentName));
      stopped.delete(deployment.deploymentName);
    },
    async destroy(deployment) {
      deployments.delete(deployment.deploymentName);
      destroyed.add(deployment.deploymentName);
    },
  };
  const providerFactory = (baseUrl) => {
    if (!providerStates.has(baseUrl)) {
      providerStates.set(baseUrl, { status: 'created', sessions: new Map(), webhooks: new Set() });
    }
    const state = providerStates.get(baseUrl);
    return {
      async waitUntilReady() {},
      async ensureSession(name) {
        if (!state.sessions.has(name)) state.sessions.set(name, `${name}-id`);
        return state.sessions.get(name);
      },
      async ensureWebhook(_sessionId, url) {
        state.webhooks.add(url);
      },
      async sessionStatus() {
        return state.status;
      },
    };
  };
  return { runtime, providerFactory, deployments, stopped, destroyed, failOnce, providerStates };
}

async function tenantSnapshot(prisma) {
  const orderBy = { id: 'asc' };
  return {
    contacts: await prisma.contact.findMany({ orderBy }),
    conversations: await prisma.conversation.findMany({ orderBy }),
    messages: await prisma.message.findMany({ orderBy }),
    templates: await prisma.messageTemplate.findMany({ orderBy }),
    keywords: await prisma.keyword.findMany({ orderBy }),
    sessions: await prisma.whatsappSession.findMany({ orderBy }),
    bareAggregates: {
      conversations: await prisma.conversation.count(),
      contacts: await prisma.contact.count(),
    },
  };
}

async function databaseAudits() {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    record('database: disposable schema', false, 'DATABASE_URL is not configured');
    return;
  }

  const schemaName = `rabitech_bleed_${process.pid}_${Date.now()}`.toLowerCase();
  const testUrl = makeTestUrl(baseUrl, schemaName);
  const prismaCli = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  const migrated = command('database: apply migrations to disposable schema', process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { DATABASE_URL: testUrl },
  });
  if (!migrated) return;

  process.env.DATABASE_URL = testUrl;
  const raw = new PrismaClient({ datasources: { db: { url: testUrl } } });
  const admin = new PrismaClient({ datasources: { db: { url: baseUrl } } });
  let backendChild;
  const sockets = [];

  try {
    const { tenancyExtension } = require('../src/prisma/extensions');
    const { runAsOrganization, runAsPlatform } = require('../src/lib/tenant-context');
    const scoped = raw.$extends(tenancyExtension);

    const orgA = await seedOrganization(raw, 'a', 1);
    const jwtSecret = 'rabitech-bleed-harness-jwt-secret';
    const token = jwt.sign({
      scope: 'ORGANIZATION',
      id: orgA.userId,
      email: 'bleed-a@rabitech.test',
      name: 'Admin A',
      role: 'ADMIN',
      organizationId: orgA.organizationId,
      tokenVersion: 0,
    }, jwtSecret, { expiresIn: '10m' });
    const { child, baseUrl } = startTestBackend(testUrl, jwtSecret);
    backendChild = child;
    await waitForBackend(baseUrl, token, child);
    // Prime GET endpoints that intentionally mark messages as read.
    await httpSnapshot(baseUrl, token, orgA);
    const before = await runAsOrganization(orgA.organizationId, () => tenantSnapshot(scoped));
    const httpBefore = await httpSnapshot(baseUrl, token, orgA);
    const orgB = await seedOrganization(raw, 'b', 10);
    const after = await runAsOrganization(orgA.organizationId, () => tenantSnapshot(scoped));
    const httpAfter = await httpSnapshot(baseUrl, token, orgA);

    await check('database: org A snapshot is byte-identical after 10x org B seed', async () => {
      assert.equal(stable(after), stable(before));
    });
    await check('http: every authenticated org A GET snapshot is byte-identical after org B seed', async () => {
      assert.deepEqual(httpAfter, httpBefore);
    });
    await check('http: authenticated GET manifest returns no server errors', async () => {
      const failures = Object.entries(httpAfter).filter(([, value]) => value.status >= 500);
      assert.deepEqual(failures, []);
    });
    await check('http: cross-organization conversation returns 404', async () => {
      const response = await fetch(
        `${baseUrl}/api/conversations/${orgB.records[0].conversation.id}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(response.status, 404);
    });
    await check('http: cross-organization message media returns 404', async () => {
      const response = await fetch(
        `${baseUrl}/media-proxy/message?msgId=provider-b_0&session=it-support`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      assert.equal(response.status, 404);
    });
    const tokenB = jwt.sign({
      scope: 'ORGANIZATION',
      id: orgB.userId,
      email: 'bleed-b@rabitech.test',
      name: 'Admin B',
      role: 'ADMIN',
      organizationId: orgB.organizationId,
      tokenVersion: 0,
    }, jwtSecret, { expiresIn: '10m' });
    const socketA = await connectSocket(baseUrl, token);
    const socketB = await connectSocket(baseUrl, tokenB);
    sockets.push(socketA, socketB);

    await check('branding: org-scoped settings cannot bleed across subscribers', async () => {
      await raw.organization.updateMany({
        where: { id: { in: [orgA.organizationId, orgB.organizationId] } },
        data: { tier: 'BUSINESS' },
      });
      const domainA = `brand-a-${Date.now()}.example.com`;
      const domainB = `brand-b-${Date.now()}.example.com`;
      const updateA = await fetch(`${baseUrl}/api/branding/current`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: 'Brand A',
          primaryHsl: '12 80% 45%',
          accentHsl: '170 80% 40%',
          customDomain: domainA,
        }),
      });
      assert.equal(updateA.status, 200);
      const updateB = await fetch(`${baseUrl}/api/branding/current`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productName: 'Brand B',
          primaryHsl: '210 80% 45%',
          accentHsl: '35 80% 50%',
          customDomain: domainB,
        }),
      });
      assert.equal(updateB.status, 200);

      const [currentA, currentB, publicA, publicB] = await Promise.all([
        fetch(`${baseUrl}/api/branding/current`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
        fetch(`${baseUrl}/api/branding/current`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((r) => r.json()),
        fetch(`${baseUrl}/api/branding/public?host=${domainA}`).then((r) => r.json()),
        fetch(`${baseUrl}/api/branding/public?host=${domainB}`).then((r) => r.json()),
      ]);
      assert.equal(currentA.productName, 'Brand A');
      assert.equal(currentB.productName, 'Brand B');
      assert.equal(publicA.primaryHsl, '12 80% 45%');
      assert.equal(publicB.primaryHsl, '210 80% 45%');
      assert.notEqual(currentA.customDomainVerificationToken, currentB.customDomainVerificationToken);
    });

    await check('branding: FREE tier cannot remove required attribution via API', async () => {
      await raw.organization.update({ where: { id: orgA.organizationId }, data: { tier: 'FREE' } });
      const response = await fetch(`${baseUrl}/api/branding/current`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customFooter: '' }),
      });
      assert.equal(response.status, 403);
      const current = await fetch(`${baseUrl}/api/branding/current`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json());
      assert.equal(current.footerText, 'Powered by RabiTech');
      assert.equal(current.canCustomizeFooter, false);
    });

    await check('branding: non-admin worker token receives 403 on branding writes', async () => {
      const workerToken = jwt.sign({
        scope: 'ORGANIZATION',
        id: orgA.userId,
        email: 'bleed-a@rabitech.test',
        name: 'Worker A',
        role: 'AGENT',
        organizationId: orgA.organizationId,
        tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });
      const response = await fetch(`${baseUrl}/api/branding/current`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${workerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ productName: 'Worker Rename' }),
      });
      assert.equal(response.status, 403);
    });

    await check('crm: contact refs and filter DSL stay organization-scoped', async () => {
      const emailA = `crm-a-${Date.now()}@rabitech.test`;
      const emailB = `crm-b-${Date.now()}@rabitech.test`;
      const patchA = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailA, firstName: 'Crm', lastName: 'Alpha', lifecycleStage: 'active' }),
      });
      assert.equal(patchA.status, 200);
      const patchB = await fetch(`${baseUrl}/api/contacts/${orgB.records[0].contact.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailB, firstName: 'Crm', lastName: 'Beta', lifecycleStage: 'lead' }),
      });
      assert.equal(patchB.status, 200);

      const [byId, byEmail, byPhone, crossEmail] = await Promise.all([
        fetch(`${baseUrl}/api/contacts/id:${orgA.records[0].contact.id}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${baseUrl}/api/contacts/email:${emailA}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${baseUrl}/api/contacts/phone:${orgA.records[0].contact.phone}`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${baseUrl}/api/contacts/email:${emailB}`, { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      assert.equal(byId.status, 200);
      assert.equal(byEmail.status, 200);
      assert.equal(byPhone.status, 200);
      assert.equal(crossEmail.status, 404);

      const filter = encodeURIComponent(JSON.stringify({
        $and: [{ category: 'contactField', field: 'email', operator: 'contains', value: 'crm-a-' }],
      }));
      const filtered = await fetch(`${baseUrl}/api/contacts?paginated=1&filter=${filter}`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((response) => response.json());
      assert.ok(filtered.items.length >= 1);
      assert.ok(filtered.items.every((contact) => contact.email !== emailB));
      assert.equal(typeof filtered.pagination.hasMore, 'boolean');
    });

    await check('crm: composite FKs reject cross-org tags and custom fields at the database', async () => {
      const [tagB, definitionB] = await Promise.all([
        raw.tag.create({ data: { organizationId: orgB.organizationId, name: `cross-tag-${Date.now()}` } }),
        raw.customFieldDefinition.create({
          data: {
            organizationId: orgB.organizationId,
            name: 'Cross Org Field',
            slug: `cross-org-field-${Date.now()}`,
            dataType: 'text',
          },
        }),
      ]);

      await assert.rejects(() =>
        raw.contactTag.create({
          data: {
            organizationId: orgA.organizationId,
            contactId: orgA.records[0].contact.id,
            tagId: tagB.id,
          },
        }),
      );

      await assert.rejects(() =>
        raw.customFieldValue.create({
          data: {
            organizationId: orgA.organizationId,
            contactId: orgA.records[0].contact.id,
            fieldDefinitionId: definitionB.id,
            value: 'must fail',
          },
        }),
      );
    });

    await check('socket: org A cannot join org B conversation', async () => {
      const rejection = new Promise((resolve) => socketA.once('error', resolve));
      socketA.emit('join_conversation', orgB.records[0].conversation.id);
      const value = await Promise.race([rejection, sleep(1000).then(() => null)]);
      assert.ok(value, 'cross-organization room join was not rejected');
    });
    await check('socket: org A event is not delivered to org B', async () => {
      const receivedA = [];
      const receivedB = [];
      socketA.on('conversation_resolved', (event) => receivedA.push(event));
      socketB.on('conversation_resolved', (event) => receivedB.push(event));
      const conversationId = orgA.records[orgA.records.length - 1].conversation.id;
      const response = await fetch(`${baseUrl}/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'RESOLVED' }),
      });
      assert.equal(response.status, 200);
      await sleep(300);
      assert.equal(receivedA.length, 1, 'org A did not receive its conversation event');
      assert.equal(receivedB.length, 0, 'org B received org A conversation event');
    });
    await check('filter DSL: relation-derived filters stay organization-scoped', async () => {
      // These are the first filters that traverse a relation, so the first that
      // could leak. The tenancy extension injects organizationId at the TOP LEVEL
      // of a where clause only — it does not descend into nested relation filters
      // — so what protects these is the composite FKs plus the explicit scope the
      // compiler writes. This asserts both actually hold.
      const { contactWhereFromFilterDsl, campaignIdsInFilter } = require('../src/lib/contact-filter-dsl');
      const replied = { $and: [{ category: 'activity', field: 'hasEverReplied', operator: 'isTrue' }] };

      // Every fixture contact has one INBOUND message, so each org sees exactly
      // its own — never the other's, which would be the leak.
      const [inA, inB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () =>
          scoped.contact.findMany({ where: contactWhereFromFilterDsl(replied, orgA.organizationId), select: { id: true, organizationId: true } })),
        runAsOrganization(orgB.organizationId, () =>
          scoped.contact.findMany({ where: contactWhereFromFilterDsl(replied, orgB.organizationId), select: { id: true, organizationId: true } })),
      ]);
      assert.equal(inA.length, 1, 'org A should match its single fixture contact');
      assert.equal(inB.length, 10, 'org B should match its ten fixture contacts');
      assert.ok(inA.every((c) => c.organizationId === orgA.organizationId), 'org A result contained a foreign contact');
      assert.ok(inB.every((c) => c.organizationId === orgB.organizationId), 'org B result contained a foreign contact');

      // Compiling org B's scope while *running* as org A must still return
      // nothing: neither layer alone is trusted to be the boundary.
      const crossScoped = await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.count({ where: contactWhereFromFilterDsl(replied, orgB.organizationId) }));
      assert.equal(crossScoped, 0, 'org A saw rows through an org B scoped filter');

      // campaignIdsInFilter must see through nesting, or the route's org check
      // is bypassed by putting the id one group deeper.
      const nested = { $and: [{ $or: [{ $and: [
        { category: 'broadcast', field: 'receivedCampaign', operator: 'isEqualTo', value: 'buried-id' },
      ] }] }] };
      assert.deepEqual(campaignIdsInFilter(nested), ['buried-id'], 'a nested campaign id escaped validation');
    });

    await check('filter DSL: broadcast history cannot read another tenant', async () => {
      const { contactWhereFromFilterDsl } = require('../src/lib/contact-filter-dsl');
      const campaignId = 'bleed_campaign_b';
      await raw.campaign.create({
        data: {
          id: campaignId,
          organizationId: orgB.organizationId,
          title: 'Org B broadcast',
          message: 'x',
          status: 'SENT',
          sessionId: orgB.sessionId,
          sentAt: new Date(),
        },
      });
      await raw.campaignRecipient.create({
        data: {
          id: 'bleed_recipient_b',
          organizationId: orgB.organizationId,
          campaignId,
          contactId: orgB.records[0].contact.id,
          status: 'delivered',
          sentAt: new Date(),
          deliveredAt: new Date(),
        },
      });

      const received = { $and: [{ category: 'broadcast', field: 'receivedCampaign', operator: 'isEqualTo', value: campaignId }] };
      const ownerSees = await runAsOrganization(orgB.organizationId, () =>
        scoped.contact.count({ where: contactWhereFromFilterDsl(received, orgB.organizationId) }));
      assert.equal(ownerSees, 1, 'org B could not see its own broadcast history');

      // Org A pointing at org B's real campaign id must resolve to nobody, even
      // before the route's 404 guard runs.
      const intruderSees = await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.count({ where: contactWhereFromFilterDsl(received, orgA.organizationId) }));
      assert.equal(intruderSees, 0, 'org A read org B broadcast history');

      await raw.campaignRecipient.delete({ where: { id: 'bleed_recipient_b' } });
      await raw.campaign.delete({ where: { id: campaignId } });
    });
    await check('commercials: overrides are org-scoped, expire, and never touch config', async () => {
      const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');
      const { parseCommercialPatch } = require('../src/modules/billing/commercial-terms');
      const asPlatform = (fn) => runAsPlatform('harness:commercials', fn);

      const configBefore = await asPlatform(() =>
        raw.organizationConfig.findUnique({ where: { organizationId: orgA.organizationId } }));
      const baseA = await asPlatform(() => resolveEntitlements(orgA.organizationId));
      const baseB = await asPlatform(() => resolveEntitlements(orgB.organizationId));

      // A commercial exception with no recorded reason is the thing this
      // feature exists to prevent.
      assert.throws(
        () => parseCommercialPatch({ planOverride: 'ENTERPRISE' }, {
          planOverride: null, macQuotaOverride: null, discountPercent: null,
          creditCents: 0, overrideReason: null, overrideExpiresAt: null,
        }),
        /reason is required/i,
        'an override was accepted with no reason',
      );

      await raw.organization.update({
        where: { id: orgA.organizationId },
        data: {
          planOverride: 'ENTERPRISE',
          macQuotaOverride: 44444,
          discountPercent: 50,
          overrideReason: 'harness',
          overrideSetAt: new Date(),
        },
      });

      const overriddenA = await asPlatform(() => resolveEntitlements(orgA.organizationId));
      const untouchedB = await asPlatform(() => resolveEntitlements(orgB.organizationId));
      assert.equal(overriddenA.plan, 'ENTERPRISE', 'org A override did not apply');
      assert.equal(overriddenA.source, 'override');
      assert.equal(overriddenA.limits.active_contacts, 44444, 'MAC override did not apply');
      // Half an upgrade — quotas raised but seats left behind — is worse than none.
      assert.equal(overriddenA.seatLimit, null, 'seats did not follow the effective plan');
      assert.deepEqual(
        { plan: untouchedB.plan, limits: untouchedB.limits, seats: untouchedB.seatLimit },
        { plan: baseB.plan, limits: baseB.limits, seats: baseB.seatLimit },
        'org B entitlements changed because of an org A override',
      );

      // The load-bearing rule: overrides resolve at read time and must never
      // be mirrored into OrganizationConfig. If this ever fails, expiry
      // silently stops working and drift detection becomes permanent noise.
      const configAfter = await asPlatform(() =>
        raw.organizationConfig.findUnique({ where: { organizationId: orgA.organizationId } }));
      assert.deepEqual(configAfter, configBefore,
        'an override was written through into OrganizationConfig');

      // An expired override is ignored but not erased: the deal stays on record.
      await raw.organization.update({
        where: { id: orgA.organizationId },
        data: { overrideExpiresAt: new Date(Date.now() - 86400000) },
      });
      const expiredA = await asPlatform(() => resolveEntitlements(orgA.organizationId));
      assert.equal(expiredA.isOverridden, false, 'an expired override was still applied');
      assert.equal(expiredA.override.expired, true);
      assert.equal(expiredA.plan, baseA.plan, 'expiry did not fall back to the plan of record');
      assert.equal(expiredA.limits.active_contacts, baseA.limits.active_contacts);
      assert.equal(expiredA.override.plan, 'ENTERPRISE',
        'the expired deal was erased rather than kept on record');

      await raw.organization.update({
        where: { id: orgA.organizationId },
        data: {
          planOverride: null, macQuotaOverride: null, discountPercent: null,
          overrideReason: null, overrideExpiresAt: null, overrideSetAt: null,
        },
      });
    });

    await check('gateway health: probe results are organization-scoped', async () => {
      const probeRow = (organizationId, ok) => ({
        organizationId,
        probe: 'status',
        ok,
        latencyMs: 12,
      });

      await runAsOrganization(orgA.organizationId, () =>
        scoped.gatewayHealthCheck.create({ data: probeRow(orgA.organizationId, false) }));
      await runAsOrganization(orgB.organizationId, () =>
        scoped.gatewayHealthCheck.create({ data: probeRow(orgB.organizationId, true) }));

      const [seenByA, seenByB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.gatewayHealthCheck.findMany({})),
        runAsOrganization(orgB.organizationId, () => scoped.gatewayHealthCheck.findMany({})),
      ]);
      assert.equal(seenByA.length, 1, 'org A saw more than its own probe rows');
      assert.equal(seenByB.length, 1, 'org B saw more than its own probe rows');
      assert.equal(seenByA[0].ok, false);
      assert.equal(seenByB[0].ok, true, 'org B read an org A probe result');

      // The failure window drives alerting. If it could see another tenant's
      // results, one subscriber's outage would raise alerts against another.
      const crossWindow = await runAsOrganization(orgB.organizationId, () =>
        scoped.gatewayHealthCheck.findMany({ where: { ok: false } }));
      assert.equal(crossWindow.length, 0, 'org B could see org A failures in its window');

      await runAsOrganization(orgA.organizationId, () => scoped.gatewayHealthCheck.deleteMany({}));
      await runAsOrganization(orgB.organizationId, () => scoped.gatewayHealthCheck.deleteMany({}));
    });

    await check('import: bulk contact import cannot cross tenants or undo an opt-out', async () => {
      const { importContacts } = require('../src/modules/contacts/import.service');

      // Consent is a hard gate, not a UI courtesy.
      await assert.rejects(
        () => runAsOrganization(orgA.organizationId, () =>
          importContacts(orgA.organizationId, [{ phone: '972500000099' }], { consentAffirmed: false })),
        /موافقة|consent/i,
        'an import ran without a consent affirmation',
      );

      const before = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.contact.count()),
        runAsOrganization(orgB.organizationId, () => scoped.contact.count()),
      ]);

      const summary = await runAsOrganization(orgA.organizationId, () =>
        importContacts(orgA.organizationId, [
          { phone: '+972 50-000-0098', name: 'Imported A' },
          { phone: 'not-a-number' },
        ], { consentAffirmed: true }));
      assert.equal(summary.created, 1, 'the valid row was not created');
      assert.equal(summary.failed, 1, 'the invalid row was not reported');

      const after = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.contact.count()),
        runAsOrganization(orgB.organizationId, () => scoped.contact.count()),
      ]);
      assert.equal(after[0], before[0] + 1, 'org A did not gain the imported contact');
      assert.equal(after[1], before[1], 'an org A import changed org B contact count');

      // Stored digits-only, so it matches the form inbound WhatsApp addresses
      // normalize to. A stored "+" would create a second contact for the same
      // person the first time they message in.
      const imported = await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.findFirst({ where: { name: 'Imported A' } }));
      assert.equal(imported.phone, '972500000098', 'phone was not normalized to storage form');
      assert.equal(imported.consentSource, 'import');
      assert.equal(imported.marketingConsent, 'OPTED_IN');

      // org B must not see it, by list or by phone.
      const seenByB = await runAsOrganization(orgB.organizationId, () =>
        scoped.contact.findFirst({ where: { phone: '972500000098' } }));
      assert.equal(seenByB, null, 'org B saw a contact org A imported');

      // An import must never resurrect an opted-out contact.
      await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.update({ where: { id: imported.id }, data: { marketingConsent: 'OPTED_OUT' } }));
      const second = await runAsOrganization(orgA.organizationId, () =>
        importContacts(orgA.organizationId, [{ phone: '972500000098', name: 'Imported A' }],
          { consentAffirmed: true }));
      assert.equal(second.skippedOptedOut, 1, 'the opted-out contact was not reported as skipped');
      const afterReimport = await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.findUnique({ where: { id: imported.id } }));
      assert.equal(afterReimport.marketingConsent, 'OPTED_OUT',
        'a re-import flipped an opted-out contact back to opted in');

      await runAsOrganization(orgA.organizationId, () =>
        scoped.contact.delete({ where: { id: imported.id } }));
    });

    await check('workflows: automations and executions are organization-scoped', async () => {
      const config = {
        trigger: { keyword: 'refund' },
        conditions: [],
        actions: [{ type: 'ADD_TAG', tag: 'needs-refund' }],
      };

      const workflowA = await runAsOrganization(orgA.organizationId, () =>
        scoped.workflow.create({
          data: {
            organizationId: orgA.organizationId,
            name: 'Bleed workflow',
            isActive: true,
            triggerType: 'KEYWORD_MATCHED',
            configJson: config,
          },
          select: { id: true },
        }));

      await runAsOrganization(orgA.organizationId, () =>
        scoped.workflowExecution.create({
          data: {
            organizationId: orgA.organizationId,
            workflowId: workflowA.id,
            contactId: orgA.records[0].contact.id,
            status: 'COMPLETED',
          },
        }));

      const [listA, listB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.workflow.findMany({})),
        runAsOrganization(orgB.organizationId, () => scoped.workflow.findMany({})),
      ]);
      assert.equal(listA.length, 1, 'org A cannot see its own workflow');
      assert.equal(listB.length, 0, 'org B saw an org A workflow');

      // The dispatcher looks workflows up by trigger on every inbound message.
      // If that read crossed tenants, one org's message would run another
      // org's automation against their contact.
      const dispatchB = await runAsOrganization(orgB.organizationId, () =>
        scoped.workflow.findMany({ where: { triggerType: 'KEYWORD_MATCHED', isActive: true } }));
      assert.equal(dispatchB.length, 0, 'org B dispatch would run an org A workflow');

      const runsB = await runAsOrganization(orgB.organizationId, () =>
        scoped.workflowExecution.findMany({}));
      assert.equal(runsB.length, 0, 'org B saw an org A execution');

      const stolen = await runAsOrganization(orgB.organizationId, () =>
        scoped.workflow.findFirst({ where: { id: workflowA.id } }));
      assert.equal(stolen, null, 'org B resolved an org A workflow by id');

      // A cross-tenant execution must be refused by the composite FK, not
      // merely by the extension.
      await assert.rejects(
        () => runAsOrganization(orgB.organizationId, () =>
          scoped.workflowExecution.create({
            data: {
              organizationId: orgB.organizationId,
              workflowId: workflowA.id,
              status: 'RUNNING',
            },
          })),
        'org B created an execution against an org A workflow',
      );

      await runAsOrganization(orgA.organizationId, () => scoped.workflowExecution.deleteMany({}));
      await runAsOrganization(orgA.organizationId, () => scoped.workflow.deleteMany({}));
    });

    await check('segments: saved segments are organization-scoped', async () => {
      // Segments hold a stored filter, so a leak here is not one row but a
      // whole audience definition plus the counts derived from it.
      const filter = { $and: [{ category: 'contactField', field: 'email', operator: 'isEmpty' }] };

      const created = await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.create({
          data: {
            organizationId: orgA.organizationId,
            name: 'Bleed segment',
            filter,
            createdById: orgA.userId,
          },
          select: { id: true },
        }));

      const [listA, listB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.segment.findMany({ where: { deletedAt: null } })),
        runAsOrganization(orgB.organizationId, () => scoped.segment.findMany({ where: { deletedAt: null } })),
      ]);
      assert.equal(listA.length, 1, 'org A cannot see its own segment');
      assert.equal(listB.length, 0, 'org B saw an org A segment');

      // findFirst by id is exactly how the routes look a segment up before
      // renaming or deleting it. It was NOT covered by the tenancy extension
      // until P10-a, so this is the regression guard for that hole: org B
      // must resolve org A's id to nothing.
      const stolen = await runAsOrganization(orgB.organizationId, () =>
        scoped.segment.findFirst({ where: { id: created.id, deletedAt: null } }));
      assert.equal(stolen, null, 'findFirst returned another tenant\'s segment');

      const stolenUnique = await runAsOrganization(orgB.organizationId, () =>
        scoped.segment.findUnique({ where: { id: created.id } }));
      assert.equal(stolenUnique, null, 'findUnique returned another tenant\'s segment');

      // Writing across the boundary must fail rather than silently succeed.
      await assert.rejects(
        () => runAsOrganization(orgB.organizationId, () =>
          scoped.segment.update({ where: { id: created.id }, data: { name: 'Stolen' } })),
        'org B renamed an org A segment',
      );

      // Soft delete hides it from the list, keeps the row, and frees the name —
      // the whole reason the unique index is partial. A plain @@unique would
      // make the re-create below fail forever.
      await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.update({ where: { id: created.id }, data: { deletedAt: new Date() } }));
      const afterDelete = await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.findMany({ where: { deletedAt: null } }));
      assert.equal(afterDelete.length, 0, 'a soft-deleted segment still appears in the list');
      const row = await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.findUnique({ where: { id: created.id } }));
      assert.ok(row && row.deletedAt, 'soft delete removed the row instead of stamping it');

      const reused = await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.create({
          data: {
            organizationId: orgA.organizationId,
            name: 'Bleed segment',
            filter,
            createdById: orgA.userId,
          },
          select: { id: true },
        }));
      assert.ok(reused.id, 'the name was not freed by soft delete');

      await runAsOrganization(orgA.organizationId, () =>
        scoped.segment.deleteMany({ where: {} }));
    });

    await check('consent: marketing consent is organization-scoped', async () => {
      // Consent is the one contact field with legal weight: honouring a STOP in
      // one tenant must never mute — or un-mute — the same phone number in another.
      const { setContactConsent } = require('../src/utils/consent');
      const contactA = orgA.records[0].contact.id;
      const reachable = (organizationId) =>
        runAsOrganization(organizationId, () =>
          scoped.contact.count({ where: { marketingConsent: { not: 'OPTED_OUT' } } }));
      const [baseA, baseB] = await Promise.all([reachable(orgA.organizationId), reachable(orgB.organizationId)]);
      const contactB = orgB.records[0].contact.id;

      await runAsOrganization(orgA.organizationId, () => setContactConsent(contactA, 'OPTED_OUT', 'agent'));

      const [afterA, afterB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.contact.findUnique({ where: { id: contactA } })),
        runAsOrganization(orgB.organizationId, () => scoped.contact.findUnique({ where: { id: contactB } })),
      ]);
      assert.equal(afterA.marketingConsent, 'OPTED_OUT', 'org A consent did not persist');
      assert.equal(afterA.consentSource, 'agent');
      assert.equal(afterB.marketingConsent, 'UNKNOWN', 'org B consent bled from org A');

      // Reaching across the boundary by id must fail rather than silently succeed.
      await assert.rejects(
        () => runAsOrganization(orgA.organizationId, () => setContactConsent(contactB, 'OPTED_OUT', 'agent')),
        'org A wrote consent onto an org B contact',
      );
      const stillB = await runAsOrganization(orgB.organizationId, () => scoped.contact.findUnique({ where: { id: contactB } }));
      assert.equal(stillB.marketingConsent, 'UNKNOWN', 'org B consent overwritten across tenants');

      // Opted-out contacts must vanish from an audience, in org A only.
      const [audienceA, audienceB] = await Promise.all([reachable(orgA.organizationId), reachable(orgB.organizationId)]);
      assert.equal(audienceA, baseA - 1, 'opted-out contact still reachable by broadcast');
      assert.equal(audienceB, baseB, 'org B audience changed because of an org A opt-out');

      await runAsOrganization(orgA.organizationId, () => setContactConsent(contactA, 'UNKNOWN', 'agent'));
    });
    await check('database: bare aggregates remain organization-scoped', async () => {
      assert.deepEqual(after.bareAggregates, { conversations: 1, contacts: 1 });
    });
    await check('database: overlapping phone and sessionName do not merge', async () => {
      const a = await runAsOrganization(orgA.organizationId, () => scoped.contact.findMany({ where: { phone: '+972500000001' } }));
      const b = await runAsOrganization(orgB.organizationId, () => scoped.contact.findMany({ where: { phone: '+972500000001' } }));
      assert.equal(a.length, 1);
      assert.equal(b.length, 1);
      assert.notEqual(a[0].id, b[0].id);
      const sessionsA = await runAsOrganization(orgA.organizationId, () => scoped.whatsappSession.count({ where: { sessionName: 'it-support' } }));
      const sessionsB = await runAsOrganization(orgB.organizationId, () => scoped.whatsappSession.count({ where: { sessionName: 'it-support' } }));
      assert.equal(sessionsA, 1);
      assert.equal(sessionsB, 1);
    });
    await check('database: organization sequences allocate independently under concurrency', async () => {
      const { allocateOrgSequence } = require('../src/utils/org-sequence');
      const allocate = (organizationId) =>
        runAsOrganization(organizationId, () =>
          Promise.all(
            Array.from({ length: 20 }, () =>
              allocateOrgSequence(organizationId, 'concurrencyTest', raw),
            ),
          ),
        );
      const [valuesA, valuesB] = await Promise.all([
        allocate(orgA.organizationId),
        allocate(orgB.organizationId),
      ]);
      const expected = Array.from({ length: 20 }, (_, index) => BigInt(index + 1));
      assert.deepEqual([...valuesA].sort((a, b) => Number(a - b)), expected);
      assert.deepEqual([...valuesB].sort((a, b) => Number(a - b)), expected);
    });
    await check('usage: MAC is distinct messaged contacts, not contacts, conversations, or messages', async () => {
      const { countMonthlyActiveContacts, recordUsageEvents } = require('../src/modules/usage/usage.service');
      const extraContacts = Array.from({ length: 499 }, (_, index) => ({
        id: `bleed_mac_contact_${index + 1}`,
        organizationId: orgA.organizationId,
        phone: `97259${String(index + 1).padStart(7, '0')}`,
        name: `MAC fixture ${index + 1}`,
      }));
      await raw.contact.createMany({ data: extraContacts });

      const conversations = [
        { id: 'bleed_mac_conversation_1', contactId: extraContacts[0].id, displayId: 2001 },
        { id: 'bleed_mac_conversation_2', contactId: extraContacts[0].id, displayId: 2002 },
        { id: 'bleed_mac_conversation_3', contactId: extraContacts[1].id, displayId: 2003 },
      ];
      await raw.conversation.createMany({
        data: conversations.map((conversation) => ({
          ...conversation,
          organizationId: orgA.organizationId,
          sessionId: orgA.sessionId,
        })),
      });

      const messageContactIds = [
        orgA.records[0].contact.id,
        extraContacts[0].id,
        extraContacts[0].id,
        extraContacts[0].id,
        extraContacts[1].id,
        extraContacts[1].id,
        extraContacts[1].id,
      ];
      const additionalMessages = Array.from({ length: 6 }, (_, index) => ({
        id: `bleed_mac_message_${index + 1}`,
        organizationId: orgA.organizationId,
        conversationId: conversations[index < 3 ? index % 2 : 2].id,
        direction: 'INBOUND',
        status: 'DELIVERED',
        body: `MAC message ${index + 1}`,
      }));
      await raw.message.createMany({ data: additionalMessages });

      const messageIds = ['bleed_message_a_0', ...additionalMessages.map((message) => message.id)];
      await runAsOrganization(orgA.organizationId, () => recordUsageEvents(
        messageContactIds.flatMap((contactId, index) => [
          { metric: 'messages_inbound', subjectId: messageIds[index] },
          { metric: 'active_contacts', subjectId: contactId },
        ]),
      ));

      const [mac, contacts, conversationCount, messages] = await runAsOrganization(
        orgA.organizationId,
        () => Promise.all([
          countMonthlyActiveContacts(),
          scoped.contact.count(),
          scoped.conversation.count(),
          scoped.message.count(),
        ]),
      );
      assert.equal(mac, 3n);
      assert.equal(contacts, 500);
      assert.equal(conversationCount, 4);
      assert.equal(messages, 7);
      assert.notEqual(Number(mac), contacts);
      assert.notEqual(Number(mac), conversationCount);
      assert.notEqual(Number(mac), messages);
    });
    await check('usage: org B volume cannot change org A counters', async () => {
      const { getCurrentUsage, recordUsageEvents } = require('../src/modules/usage/usage.service');
      const beforeUsage = await runAsOrganization(orgA.organizationId, () => getCurrentUsage());
      await runAsOrganization(orgB.organizationId, () => recordUsageEvents(
        Array.from({ length: 100 }, (_, index) => ({
          metric: index % 2 === 0 ? 'messages_inbound' : 'messages_outbound',
          subjectId: `bleed-b-volume-${index}`,
        })),
      ));
      const afterUsage = await runAsOrganization(orgA.organizationId, () => getCurrentUsage());
      assert.deepEqual(afterUsage, beforeUsage);
      const [countA, countB] = await Promise.all([
        runAsOrganization(orgA.organizationId, () => scoped.usageEvent.count()),
        runAsOrganization(orgB.organizationId, () => scoped.usageEvent.count()),
      ]);
      assert.equal(countA, 14);
      assert.equal(countB, 100);
    });
    await check('usage: daily rollup rerun preserves identical values', async () => {
      const { rollupOrganizationDate } = require('../src/modules/usage/usage-rollup.service');
      const readValues = () => scoped.platformDailyMetric.findMany({
        select: { metric: true, value: true },
        orderBy: { metric: 'asc' },
      });
      await runAsOrganization(orgA.organizationId, () => rollupOrganizationDate(new Date()));
      const first = await runAsOrganization(orgA.organizationId, readValues);
      await runAsOrganization(orgA.organizationId, () => rollupOrganizationDate(new Date()));
      const second = await runAsOrganization(orgA.organizationId, readValues);
      assert.deepEqual(second, first);
      assert.equal(first.find((row) => row.metric === 'active_contacts').value, 3n);

      await runAsOrganization(orgB.organizationId, () => rollupOrganizationDate(new Date()));
      const afterOrgB = await runAsOrganization(orgA.organizationId, readValues);
      assert.deepEqual(afterOrgB, first);
    });
    await check('usage: ledger rejects updates and deletes', async () => {
      await assert.rejects(
        () => runAsOrganization(orgA.organizationId, () => scoped.usageEvent.updateMany({ data: { quantity: 99n } })),
        /append-only/,
      );
      await assert.rejects(
        () => runAsOrganization(orgA.organizationId, () => scoped.usageEvent.deleteMany()),
        /append-only/,
      );
    });
    await check('quota: outbound blocks clearly while inbound continues recording', async () => {
      const { assertMetricAvailable, prepareOutboundSend } = require('../src/modules/usage/entitlements');
      const { getMetricUsage, recordMessageUsage } = require('../src/modules/usage/usage.service');
      await raw.organizationConfig.update({
        where: { organizationId: orgA.organizationId },
        data: { monthlyOutboundMessagesLimit: 0, monthlyInboundMessagesLimit: 0 },
      });

      await runAsOrganization(orgA.organizationId, async () => {
        await assert.rejects(
          () => prepareOutboundSend(orgA.records[0].contact.phone),
          (error) => error.code === 'USAGE_QUOTA_EXCEEDED'
            && error.metric === 'messages_outbound'
            && error.limit === 0n
            && /Increase the plan limit/.test(error.message),
        );
        await assertMetricAvailable('messages_inbound');
        const beforeInbound = await getMetricUsage('messages_inbound');
        await recordMessageUsage('INBOUND', orgA.records[0].contact.id, 'inbound-at-outbound-cap');
        const afterInbound = await getMetricUsage('messages_inbound');
        assert.equal(afterInbound, beforeInbound + 1n);
      });
    });
    await check('usage: 24h synthetic counters reconcile with Message rows within 1%', async () => {
      const { countMonthlyActiveContacts, getMetricUsage, recordUsageEvents } = require('../src/modules/usage/usage.service');
      const orgC = await seedOrganization(raw, 'c', 0);
      const syntheticStart = new Date(Date.now() - (23 * 60 * 60 * 1000));
      const contacts = Array.from({ length: 50 }, (_, index) => ({
        id: `bleed_24h_contact_${index}`,
        organizationId: orgC.organizationId,
        phone: `97258${String(index).padStart(7, '0')}`,
        name: `24h contact ${index}`,
      }));
      const conversations = contacts.map((contact, index) => ({
        id: `bleed_24h_conversation_${index}`,
        organizationId: orgC.organizationId,
        displayId: 3000 + index,
        contactId: contact.id,
        sessionId: orgC.sessionId,
      }));
      const messages = Array.from({ length: 500 }, (_, index) => {
        const contactIndex = index % contacts.length;
        return {
          id: `bleed_24h_message_${index}`,
          organizationId: orgC.organizationId,
          conversationId: conversations[contactIndex].id,
          direction: 'INBOUND',
          status: 'DELIVERED',
          body: `24h message ${index}`,
          timestamp: new Date(syntheticStart.getTime() + Math.floor((index / 500) * 24 * 60 * 60 * 1000)),
        };
      });
      await raw.contact.createMany({ data: contacts });
      await raw.conversation.createMany({ data: conversations });
      await raw.message.createMany({ data: messages });

      await runAsOrganization(orgC.organizationId, () => recordUsageEvents(
        messages.flatMap((message, index) => [
          { metric: 'messages_inbound', subjectId: message.id, occurredAt: message.timestamp },
          { metric: 'active_contacts', subjectId: contacts[index % contacts.length].id, occurredAt: message.timestamp },
        ]),
      ));

      const [meteredMessages, mac, actualMessages, actualActiveRows] = await runAsOrganization(
        orgC.organizationId,
        () => Promise.all([
          getMetricUsage('messages_inbound'),
          countMonthlyActiveContacts(),
          scoped.message.count({ where: { timestamp: { gte: syntheticStart } } }),
          scoped.conversation.findMany({
            where: { messages: { some: { timestamp: { gte: syntheticStart } } } },
            distinct: ['contactId'],
            select: { contactId: true },
          }),
        ]),
      );
      const messageError = Math.abs(Number(meteredMessages) - actualMessages) / actualMessages;
      const macError = Math.abs(Number(mac) - actualActiveRows.length) / actualActiveRows.length;
      assert.ok(messageError <= 0.01, `message reconciliation error was ${messageError * 100}%`);
      assert.ok(macError <= 0.01, `MAC reconciliation error was ${macError * 100}%`);
      assert.equal(meteredMessages, 500n);
      assert.equal(mac, 50n);
    });
    await check('usage: an internal send records no usage event', async () => {
      // Runs after the usage checks that assert absolute fixture counts: this
      // writes one real UsageEvent and UsageEvent is append-only by design, so
      // it cannot undo itself.
      //
      // OutboundUsageOptions.internal is a deliberate bypass around billing,
      // added for the gateway health probe. One careless `internal: true` on a
      // customer-facing path would silently under-bill every tenant, so the
      // bypass is pinned here rather than trusted to review.
      const { recordSuccessfulOutboundSend } = require('../src/modules/usage/entitlements');

      const before = await runAsOrganization(orgA.organizationId, () =>
        scoped.usageEvent.count({ where: { metric: 'messages_outbound' } }));

      await runAsOrganization(orgA.organizationId, () =>
        recordSuccessfulOutboundSend(null, 'probe-message-id', { internal: true }));

      const afterInternal = await runAsOrganization(orgA.organizationId, () =>
        scoped.usageEvent.count({ where: { metric: 'messages_outbound' } }));
      assert.equal(afterInternal, before, 'an internal send was billed to the tenant');

      // ...and a normal send still is. A bypass that swallowed everything
      // would pass the assertion above while breaking all metering.
      await runAsOrganization(orgA.organizationId, () =>
        recordSuccessfulOutboundSend(null, 'normal-message-id', {}));
      const afterNormal = await runAsOrganization(orgA.organizationId, () =>
        scoped.usageEvent.count({ where: { metric: 'messages_outbound' } }));
      assert.equal(afterNormal, before + 1, 'a normal send stopped being metered');
    });

    await check('provisioning: concurrent subscribers receive isolated resources and secrets', async () => {
      const { processGatewayAction } = require('../src/modules/provisioning/gateway-provisioning.service');
      const fakes = provisioningFakes();
      const [first, second] = await Promise.all([
        seedProvisioningOrganization(raw, 'concurrent-a'),
        seedProvisioningOrganization(raw, 'concurrent-b'),
      ]);
      await Promise.all([
        processGatewayAction(first.organizationId, 'provision', fakes.runtime, fakes.providerFactory),
        processGatewayAction(second.organizationId, 'provision', fakes.runtime, fakes.providerFactory),
      ]);
      const channels = await raw.organizationChannel.findMany({
        where: { organizationId: { in: [first.organizationId, second.organizationId] } },
        orderBy: { organizationId: 'asc' },
      });
      assert.equal(channels.length, 2);
      assert.equal(new Set(channels.map((channel) => channel.apiPort)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.dashboardPort)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.deploymentName)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.dataVolumeName)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.redisVolumeName)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.apiKeyEnc)).size, 2);
      assert.equal(new Set(channels.map((channel) => channel.webhookToken)).size, 2);
      assert.ok(channels.every((channel) => channel.provisioningState === 'AWAITING_QR'));
      assert.equal(fakes.deployments.size, 2);
    });
    await check('provisioning: interrupted create resumes without reallocating or duplicating', async () => {
      const { processGatewayAction } = require('../src/modules/provisioning/gateway-provisioning.service');
      const fakes = provisioningFakes();
      const org = await seedProvisioningOrganization(raw, 'resume');
      fakes.failOnce.add(`rabitech-${org.slug}-gateway`);
      await assert.rejects(
        () => processGatewayAction(org.organizationId, 'provision', fakes.runtime, fakes.providerFactory),
        /simulated process interruption/,
      );
      const interrupted = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: org.organizationId, kind: 'OPENWA' } },
      });
      assert.equal(interrupted.provisioningStep, 'START_GATEWAY');
      await processGatewayAction(org.organizationId, 'provision', fakes.runtime, fakes.providerFactory);
      const resumed = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: org.organizationId, kind: 'OPENWA' } },
      });
      assert.equal(resumed.apiPort, interrupted.apiPort);
      assert.equal(resumed.apiKeyEnc, interrupted.apiKeyEnc);
      assert.equal(resumed.provisioningState, 'AWAITING_QR');
      assert.equal(fakes.deployments.size, 1);
    });
    await check('provisioning: suspend and resume preserve the session volume', async () => {
      const { processGatewayAction } = require('../src/modules/provisioning/gateway-provisioning.service');
      const fakes = provisioningFakes();
      const org = await seedProvisioningOrganization(raw, 'suspend');
      await processGatewayAction(org.organizationId, 'provision', fakes.runtime, fakes.providerFactory);
      const channel = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: org.organizationId, kind: 'OPENWA' } },
      });
      const providerState = fakes.providerStates.get(`http://127.0.0.1:${channel.apiPort}`);
      providerState.status = 'connected';
      await processGatewayAction(org.organizationId, 'monitor', fakes.runtime, fakes.providerFactory);
      await processGatewayAction(org.organizationId, 'suspend', fakes.runtime, fakes.providerFactory);
      assert.ok(fakes.stopped.has(channel.deploymentName));
      assert.ok(fakes.deployments.get(channel.deploymentName).dataVolumeName === channel.dataVolumeName);
      await processGatewayAction(org.organizationId, 'resume', fakes.runtime, fakes.providerFactory);
      await processGatewayAction(org.organizationId, 'monitor', fakes.runtime, fakes.providerFactory);
      const resumed = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: org.organizationId, kind: 'OPENWA' } },
      });
      assert.equal(resumed.provisioningState, 'ACTIVE');
      assert.ok(!fakes.stopped.has(channel.deploymentName));
      assert.ok(!fakes.destroyed.has(channel.deploymentName));
      assert.equal(resumed.dataVolumeName, channel.dataVolumeName);
    });
    await check('provisioning: destroy removes runtime resources before organization data', async () => {
      const { processGatewayAction } = require('../src/modules/provisioning/gateway-provisioning.service');
      const fakes = provisioningFakes();
      const org = await seedProvisioningOrganization(raw, 'destroy');
      await processGatewayAction(org.organizationId, 'provision', fakes.runtime, fakes.providerFactory);
      const channel = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: org.organizationId, kind: 'OPENWA' } },
      });
      await processGatewayAction(org.organizationId, 'destroy', fakes.runtime, fakes.providerFactory);
      assert.ok(fakes.destroyed.has(channel.deploymentName));
      assert.ok(!fakes.deployments.has(channel.deploymentName));
      assert.equal(await raw.organization.findUnique({ where: { id: org.organizationId } }), null);
    });
    await check('provisioning: terminal failure records step and platform alert only for its organization', async () => {
      const { markGatewayFailed } = require('../src/modules/provisioning/gateway-provisioning.service');
      const failedOrg = await seedProvisioningOrganization(raw, 'failed');
      const untouchedOrg = await seedProvisioningOrganization(raw, 'untouched');
      await raw.organizationChannel.update({
        where: { organizationId_kind: { organizationId: failedOrg.organizationId, kind: 'OPENWA' } },
        data: { provisioningState: 'PROVISIONING', provisioningStep: 'WAIT_FOR_PROVIDER' },
      });
      await markGatewayFailed(failedOrg.organizationId, 'provider never became ready');
      const [failed, untouched, alert] = await Promise.all([
        raw.organizationChannel.findUniqueOrThrow({
          where: { organizationId_kind: { organizationId: failedOrg.organizationId, kind: 'OPENWA' } },
        }),
        raw.organizationChannel.findUniqueOrThrow({
          where: { organizationId_kind: { organizationId: untouchedOrg.organizationId, kind: 'OPENWA' } },
        }),
        raw.platformAlert.findFirst({ where: { organizationId: failedOrg.organizationId } }),
      ]);
      assert.equal(failed.provisioningState, 'FAILED');
      assert.equal(failed.failureStep, 'WAIT_FOR_PROVIDER');
      assert.equal(failed.failureReason, 'provider never became ready');
      assert.equal(untouched.provisioningState, 'PENDING');
      assert.ok(alert);
    });
    await check('database: platform scope writes a durable audit row', async () => {
      const response = await fetch(`${baseUrl}/health`);
      assert.equal(response.status, 200);
      const count = await raw.platformAuditLog.count();
      assert.ok(count > 0, 'no durable platform-scope audit rows were written');
    });
    await check('database: cross-organization resource lookup returns not found', async () => {
      const found = await runAsOrganization(orgA.organizationId, () =>
        scoped.conversation.findUnique({ where: { id: orgB.records[0].conversation.id } }),
      );
      assert.equal(found, null);
    });
    await check('database: tenant query without context throws', async () => {
      await assert.rejects(() => scoped.contact.findMany(), /TENANT_ISOLATION_VIOLATION/);
    });
    // This check used to assert the opposite: that a free signup verified its
    // email and got no gateway. That was correct while FREE was a permanent
    // tier. It is now a 3-hour trial of a paid plan, by an explicit product
    // decision, and a trial that cannot connect a WhatsApp number demonstrates
    // nothing — so the expectation is inverted deliberately, not relaxed.
    await check('billing: a trial signup provisions a gateway once its email is verified', async () => {
      const response = await fetch(`${baseUrl}/api/billing/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationName: `Free Signup ${Date.now()}`,
          adminName: 'Free Admin',
          adminEmail: `free-${Date.now()}@billing.test`,
          adminPassword: 'password-123',
          planCode: 'FREE',
        }),
      });
      assert.equal(response.status, 201);
      const signup = await response.json();
      assert.equal(signup.checkoutUrl, null);
      const beforeVerify = await raw.organizationChannel.findUniqueOrThrow({
        where: { organizationId_kind: { organizationId: signup.organizationId, kind: 'OPENWA' } },
      });
      assert.equal(beforeVerify.provisioningState, 'PENDING');

      const verificationToken = new URL(signup.verificationUrl).searchParams.get('token');
      const verify = await fetch(`${baseUrl}/api/billing/verify-email?token=${encodeURIComponent(verificationToken)}`);
      assert.equal(verify.status, 200);
      const [organization, channel] = await Promise.all([
        raw.organization.findUniqueOrThrow({ where: { id: signup.organizationId } }),
        raw.organizationChannel.findUniqueOrThrow({
          where: { organizationId_kind: { organizationId: signup.organizationId, kind: 'OPENWA' } },
        }),
      ]);
      assert.ok(organization.emailVerifiedAt);
      // Verification takes the organization off PENDING; provisioning then
      // moves it to PROVISIONING. Which of the two is visible here depends on
      // whether the queued job has run, so both are accepted — asserting one
      // exactly would be a test that fails on timing rather than on truth.
      assert.ok(
        ['ACTIVE', 'PROVISIONING'].includes(organization.status),
        `expected the organization off PENDING, got ${organization.status}`,
      );
      // The trial runs on a real paid plan, and tier must agree with the
      // subscription or detectQuotaDrift fires on every trial in the system.
      assert.notEqual(organization.tier, 'FREE');
      const subscription = await raw.subscription.findFirstOrThrow({
        where: { organizationId: signup.organizationId },
      });
      assert.equal(subscription.status, 'TRIALING');
      assert.equal(subscription.planCode, organization.tier);
      assert.ok(subscription.trialEndsAt, 'a trial must carry a deadline');
      // Nothing was paid, so nothing was activated.
      assert.equal(subscription.activatedAt, null);
      // The property that actually matters, and the only one here that is not
      // subject to a queue: the plan being trialled grants a WhatsApp
      // connection. A trial without one is a trial of a product the tenant
      // cannot use.
      const { PLAN_ENTITLEMENTS } = require('../src/modules/billing/plans');
      assert.equal(PLAN_ENTITLEMENTS[subscription.planCode].autoProvisionGateway, true);
      assert.ok(channel, 'the workspace has a gateway channel row');
    });
    await check('billing: extending a trial moves the deadline forward from now', async () => {
      // Owner-only, so this needs a PLATFORM token. Minted against this
      // harness's own throwaway secret, against an identity it creates itself —
      // no real credential is read or written anywhere.
      const ownerIdentity = await raw.identity.create({
        data: {
          email: `owner-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'OWNER',
        },
      });
      const ownerToken = jwt.sign(
        { scope: 'PLATFORM', id: ownerIdentity.id, email: ownerIdentity.email, platformRole: 'OWNER' },
        jwtSecret,
        { expiresIn: '10m' },
      );
      const asOwner = (path, body) =>
        fetch(`${baseUrl}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify(body),
        });

      const subscription = await raw.subscription.create({
        data: {
          organizationId: orgA.organizationId,
          planCode: 'GROWTH',
          provider: 'manual',
          status: 'TRIALING',
          // Already over, which is the case that matters: extending by three
          // hours from *this* would land three hours in the past and the owner
          // would be clicking a button that visibly does nothing.
          trialEndsAt: new Date(Date.now() - 5 * 3600_000),
        },
      });

      const response = await asOwner(
        `/api/platform/subscribers/${orgA.organizationId}/billing/extend-trial`,
        { hours: 3, reason: 'bleed-probe' },
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.ok(new Date(payload.trialEndsAt).getTime() > Date.now(), 'the new deadline must be in the future');

      // Written down in the same transaction as the change itself.
      const audited = await raw.platformAuditLog.count({
        where: { action: 'platform.trial.extended', targetOrgId: orgA.organizationId },
      });
      assert.equal(audited, 1);

      // A converted subscriber has no trial to extend, and says so.
      await raw.subscription.update({ where: { id: subscription.id }, data: { status: 'ACTIVE' } });
      const converted = await asOwner(
        `/api/platform/subscribers/${orgA.organizationId}/billing/extend-trial`,
        { hours: 3 },
      );
      assert.equal(converted.status, 409);

      const rejected = await asOwner(
        `/api/platform/subscribers/${orgA.organizationId}/billing/extend-trial`,
        { hours: -1 },
      );
      assert.equal(rejected.status, 400);

      await raw.platformAuditLog.deleteMany({ where: { targetOrgId: orgA.organizationId } });
      await raw.subscription.delete({ where: { id: subscription.id } });
      await raw.identity.delete({ where: { id: ownerIdentity.id } });
    });
    const mintPlatformToken = (identity) =>
      jwt.sign(
        { scope: 'PLATFORM', id: identity.id, email: identity.email, platformRole: identity.platformRole },
        jwtSecret,
        { expiresIn: '10m' },
      );

    await check('staff: the owner can hire, scope and disable an advisor', async () => {
      // Before this existed, hiring a support advisor meant an UPDATE against
      // the production database.
      const owner = await raw.identity.create({
        data: {
          email: `owner-staff-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'OWNER',
        },
      });
      const ownerToken = mintPlatformToken(owner);
      const asOwner = (method, path, body) =>
        fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      const listed = await (await asOwner('GET', '/api/platform/staff')).json();
      assert.ok(Object.keys(listed.catalogue).length > 5, 'the catalogue comes from the server');
      assert.ok(listed.suggested.length > 0, 'a starting point is offered');

      const email = `advisor-gate-${Date.now()}@platform.test`;
      const short = await asOwner('POST', '/api/platform/staff', {
        email, password: 'tooshort', permissions: ['subscriber:read'],
      });
      assert.equal(short.status, 400, 'a short staff password is refused');

      const created = await asOwner('POST', '/api/platform/staff', {
        email,
        password: 'a-long-enough-staff-password',
        // One that does not exist, beside two that do.
        permissions: ['subscriber:read', 'trial:extend', 'not:a:permission'],
      });
      assert.equal(created.status, 201);
      const advisor = await created.json();
      assert.deepEqual(
        [...advisor.platformPermissions].sort(),
        ['subscriber:read', 'trial:extend'],
        'unknown permissions are dropped rather than stored',
      );

      // Who can see every subscriber is exactly the question an owner gets
      // asked one day, and 'I think so' is not an answer.
      const audited = await raw.platformAuditLog.count({
        where: { action: 'platform.staff.created', targetOrgName: email },
      });
      assert.equal(audited, 1, 'hiring is written down');

      // The owner is not editable from the staff screen: there is no version
      // of this product where a mis-click locks the owner out of it.
      const touchOwner = await asOwner('PATCH', `/api/platform/staff/${owner.id}`, { disabled: true });
      assert.equal(touchOwner.status, 403);

      const disabled = await asOwner('PATCH', `/api/platform/staff/${advisor.id}`, { disabled: true });
      assert.equal(disabled.status, 200);
      assert.ok((await disabled.json()).platformDisabledAt, 'disabling is recorded, not deleted');

      await raw.platformAuditLog.deleteMany({ where: { targetOrgName: email } });
      await raw.identity.delete({ where: { id: advisor.id } });
      await raw.identity.delete({ where: { id: owner.id } });
    });
    await check('staff: an advisor reaches only what they were granted', async () => {
      // The whole point of scoped support access. An advisor granted trials
      // and nothing else must be able to extend a trial and must not be able
      // to move money or switch a business off.
      const advisor = await raw.identity.create({
        data: {
          email: `advisor-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'SUPPORT',
          platformPermissions: ['subscriber:read', 'trial:extend'],
        },
      });
      const token = mintPlatformToken(advisor);
      const as = (method, path, body) =>
        fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      assert.equal((await as('GET', '/api/platform/subscribers')).status, 200, 'granted read must work');

      // Granted, and the subscriber has no trial — so the refusal must be
      // about the trial, never about permission.
      const extend = await as('POST', `/api/platform/subscribers/${orgA.organizationId}/billing/extend-trial`, { hours: 3 });
      assert.notEqual(extend.status, 403, 'a granted permission must not 403');

      for (const [method, path, body] of [
        ['POST', `/api/platform/subscribers/${orgA.organizationId}/billing/activate`, { planCode: 'BUSINESS' }],
        ['PATCH', `/api/platform/subscribers/${orgA.organizationId}/commercials`, { discountPercent: 90 }],
        ['PATCH', `/api/platform/subscribers/${orgA.organizationId}/status`, { status: 'SUSPENDED' }],
        ['POST', `/api/platform/subscribers/${orgA.organizationId}/gateway/suspend`, {}],
        ['GET', '/api/platform/billing/summary', undefined],
      ]) {
        const response = await as(method, path, body);
        assert.equal(response.status, 403, `${method} ${path} must be refused`);
        const payload = await response.json();
        // The refusal names the permission, so an owner reading a support
        // ticket knows which box to tick rather than guessing.
        assert.ok(payload.permission, 'the refusal must name the permission');
      }

      // Staff management is never grantable: an advisor who could grant
      // permissions could grant themselves permissions.
      await raw.identity.update({
        where: { id: advisor.id },
        data: { platformPermissions: ['subscriber:read', 'trial:extend', 'staff:manage'] },
      });
      assert.equal((await as('GET', '/api/platform/staff')).status, 403,
        'staff management must stay owner-only even if somebody stores the string');

      await raw.identity.delete({ where: { id: advisor.id } });
    });
    await check('staff: a disabled advisor is refused mid-token', async () => {
      // Tokens last seven days. Disabling at login alone leaves whatever token
      // they hold working for the rest of the week — the week you disabled
      // them for.
      const advisor = await raw.identity.create({
        data: {
          email: `disabled-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'SUPPORT',
          platformPermissions: ['subscriber:read'],
        },
      });
      const token = mintPlatformToken(advisor);
      const read = () =>
        fetch(`${baseUrl}/api/platform/subscribers`, { headers: { Authorization: `Bearer ${token}` } });

      assert.equal((await read()).status, 200);
      await raw.identity.update({ where: { id: advisor.id }, data: { platformDisabledAt: new Date() } });
      // Same token, immediately after.
      assert.equal((await read()).status, 403, 'the existing token must stop working at once');

      await raw.identity.delete({ where: { id: advisor.id } });
    });
    await check('staff: revoking a permission takes effect on the next request', async () => {
      // The permissions are read from the database per request rather than
      // trusted from the token, so a revocation cannot wait for expiry.
      const advisor = await raw.identity.create({
        data: {
          email: `revoked-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'SUPPORT',
          platformPermissions: ['subscriber:read'],
        },
      });
      const token = mintPlatformToken(advisor);
      const read = () =>
        fetch(`${baseUrl}/api/platform/subscribers`, { headers: { Authorization: `Bearer ${token}` } });

      assert.equal((await read()).status, 200);
      await raw.identity.update({ where: { id: advisor.id }, data: { platformPermissions: [] } });
      assert.equal((await read()).status, 403, 'the same token must lose the permission immediately');

      await raw.identity.delete({ where: { id: advisor.id } });
    });
    await check('billing: MRR counts money paid, not money hoped for', async () => {
      // The bug this exists to prevent: MRR used to include TRIALING. That
      // cost nothing while trials ran on the free plan at zero, and became a
      // lie the moment they moved to a real paid plan — every open trial
      // would have added its full list price to reported revenue.
      const ownerIdentity = await raw.identity.create({
        data: {
          email: `owner-mrr-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'OWNER',
        },
      });
      const ownerToken = jwt.sign(
        { scope: 'PLATFORM', id: ownerIdentity.id, email: ownerIdentity.email, platformRole: 'OWNER' },
        jwtSecret,
        { expiresIn: '10m' },
      );
      const asOwner = (path, init) =>
        fetch(`${baseUrl}${path}`, {
          ...init,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}`, ...(init?.headers || {}) },
        });

      const before = await (await asOwner('/api/platform/billing/summary')).json();

      const trial = await raw.subscription.create({
        data: {
          organizationId: orgA.organizationId,
          planCode: 'BUSINESS',
          provider: 'manual',
          status: 'TRIALING',
          trialEndsAt: new Date(Date.now() + 3600_000),
        },
      });

      const after = await (await asOwner('/api/platform/billing/summary')).json();
      assert.equal(after.mrrCents, before.mrrCents, 'a trial must not move revenue');
      assert.equal(after.trials.open, before.trials.open + 1, 'but it must be counted as a trial');
      assert.ok(after.trials.potentialCents > before.trials.potentialCents,
        'and its value must show up as potential, kept separate from revenue');

      // Converting is what moves the number.
      await raw.subscription.update({ where: { id: trial.id }, data: { status: 'ACTIVE' } });
      const converted = await (await asOwner('/api/platform/billing/summary')).json();
      assert.ok(converted.mrrCents > before.mrrCents, 'converting must move revenue');

      await raw.subscription.delete({ where: { id: trial.id } });
      await raw.identity.delete({ where: { id: ownerIdentity.id } });
    });
    await check('billing: the trial offer is settable, and refuses a plan with no gateway', async () => {
      const ownerIdentity = await raw.identity.create({
        data: {
          email: `owner-trial-${Date.now()}@platform.test`,
          passwordHash: 'not-used-by-token-verification',
          platformRole: 'OWNER',
        },
      });
      const ownerToken = jwt.sign(
        { scope: 'PLATFORM', id: ownerIdentity.id, email: ownerIdentity.email, platformRole: 'OWNER' },
        jwtSecret,
        { expiresIn: '10m' },
      );
      const patch = (body) =>
        fetch(`${baseUrl}/api/platform/trial/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify(body),
        });

      const saved = await (await patch({ hours: 48 })).json();
      assert.equal(saved.hours, 48);

      // A trial on FREE grants no WhatsApp connection, which is the one thing
      // the trial exists to demonstrate. Refused rather than honoured.
      const refused = await patch({ planCode: 'FREE' });
      assert.equal(refused.status, 400);

      // Back to the shipped default so this check leaves nothing behind.
      const restored = await (await patch({ hours: 3 })).json();
      assert.equal(restored.hours, 3);

      await raw.identity.delete({ where: { id: ownerIdentity.id } });
    });
    await check('billing: a tenant admin cannot extend their own trial', async () => {
      // The whole point of an owner-only route. A subscriber who could grant
      // themselves more time does not have a trial, they have a free product.
      const response = await fetch(
        `${baseUrl}/api/platform/subscribers/${orgA.organizationId}/billing/extend-trial`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ hours: 999 }),
        },
      );
      assert.ok([401, 403].includes(response.status), `expected a refusal, got ${response.status}`);
    });
    await check('billing: invalid webhook signatures are rejected by the active provider', async () => {
      const response = await fetch(`${baseUrl}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: 'invalid-signature', type: 'manual.subscription_activated' }),
      });
      assert.equal(response.status, 400);
    });
    await check('billing: duplicate provider event IDs are processed exactly once', async () => {
      const { handlePaymentWebhook } = require('../src/modules/billing/billing.service');
      const { setPaymentProviderForTests } = require('../src/modules/billing/provider-registry');
      let verified = 0;
      setPaymentProviderForTests({
        provider: 'fake',
        async createCheckout() { return { checkoutUrl: 'internal://fake', externalRef: 'fake-ref' }; },
        async getCheckoutStatus() { return { status: 'pending' }; },
        async changeSubscription() {},
        async cancelSubscription() {},
        async verifyWebhook(rawBody) {
          verified += 1;
          const payload = JSON.parse(rawBody.toString('utf8'));
          return { valid: true, eventId: payload.eventId, type: payload.type, payload };
        },
        async listInvoices() { return []; },
      });
      try {
        const rawBody = Buffer.from(JSON.stringify({ eventId: 'evt_duplicate_once', type: 'fake.noop' }));
        const first = await handlePaymentWebhook(rawBody, {});
        const second = await handlePaymentWebhook(rawBody, {});
        assert.deepEqual(first, { duplicate: false, processed: true });
        assert.deepEqual(second, { duplicate: true, processed: false });
        assert.equal(verified, 2);
        assert.equal(await raw.paymentEvent.count({ where: { provider: 'fake', eventId: 'evt_duplicate_once' } }), 1);
      } finally {
        setPaymentProviderForTests(null);
      }
    });
    await check('billing: downgrade overage preserves data, blocks outbound, and allows inbound metering', async () => {
      const { activateManualSubscription } = require('../src/modules/billing/billing.service');
      const { assertMetricAvailable, prepareOutboundSend } = require('../src/modules/usage/entitlements');
      const { getMetricUsage, recordMessageUsage, recordUsageEvents } = require('../src/modules/usage/usage.service');
      await activateManualSubscription(orgA.organizationId, 'BUSINESS');
      await runAsOrganization(orgA.organizationId, () => recordUsageEvents(
        Array.from({ length: 2501 }, (_, index) => ({
          metric: 'active_contacts',
          subjectId: `downgrade-active-${index}`,
        })),
      ));
      const contactCountBefore = await raw.contact.count({ where: { organizationId: orgA.organizationId } });
      await activateManualSubscription(orgA.organizationId, 'GROWTH');
      const [organization, contactCountAfter] = await Promise.all([
        raw.organization.findUniqueOrThrow({ where: { id: orgA.organizationId } }),
        raw.contact.count({ where: { organizationId: orgA.organizationId } }),
      ]);
      assert.equal(contactCountAfter, contactCountBefore);
      assert.ok(organization.downgradeGraceEndsAt);
      await raw.contact.create({
        data: {
          id: 'bleed_downgrade_new_contact',
          organizationId: orgA.organizationId,
          phone: '972599999999',
          name: 'Downgrade New',
        },
      });
      await runAsOrganization(orgA.organizationId, async () => {
        await assert.rejects(() => assertMetricAvailable('active_contacts'), (error) => error.code === 'USAGE_QUOTA_EXCEEDED');
        await assert.rejects(() => prepareOutboundSend('972599999999'), (error) => error.code === 'USAGE_QUOTA_EXCEEDED');
        const beforeInbound = await getMetricUsage('messages_inbound');
        await recordMessageUsage('INBOUND', orgA.records[0].contact.id, 'inbound-during-downgrade-grace');
        assert.equal(await getMetricUsage('messages_inbound'), beforeInbound + 1n);
      });
    });
    await check('billing: composite FK rejects cross-org invoice subscription writes', async () => {
      const subscriptionB = await raw.subscription.create({
        data: {
          organizationId: orgB.organizationId,
          planCode: 'GROWTH',
          provider: 'manual',
          status: 'ACTIVE',
          subscriptionRef: `manual-cross-${Date.now()}`,
        },
      });
      await assert.rejects(() =>
        raw.invoice.create({
          data: {
            organizationId: orgA.organizationId,
            subscriptionId: subscriptionB.id,
            provider: 'manual',
            invoiceRef: `invoice-cross-${Date.now()}`,
            status: 'OPEN',
          },
        }),
      );
    });
    await check('consent: composite FK rejects a cross-org consent event', async () => {
      // Consent history is the record a subscriber stands behind if anyone
      // asks why they messaged someone. An event attached to another
      // organization's contact would put one tenant's evidence on another
      // tenant's customer.
      await assert.rejects(() =>
        raw.consentEvent.create({
          data: {
            organizationId: orgA.organizationId,
            contactId: orgB.records[0].contact.id,
            fromValue: 'UNKNOWN',
            toValue: 'OPTED_OUT',
            source: 'agent',
          },
        }),
      );
    });
    await check('consent: events never cross organizations on read', async () => {
      const write = (org) =>
        runAsOrganization(org.organizationId, () =>
          scoped.consentEvent.create({
            data: {
              organizationId: org.organizationId,
              contactId: org.records[0].contact.id,
              fromValue: 'UNKNOWN',
              toValue: 'OPTED_IN',
              source: 'agent',
              actorName: 'bleed-probe',
            },
          }),
        );

      await write(orgA);
      await write(orgB);

      const seenByA = await runAsOrganization(orgA.organizationId, () =>
        scoped.consentEvent.findMany({ select: { organizationId: true } }),
      );
      assert.ok(seenByA.length > 0);
      assert.ok(seenByA.every((row) => row.organizationId === orgA.organizationId));
    });
    await check('inbox views: composite FK rejects a cross-org owner', async () => {
      // A saved view owned by a user in another organization would be a view
      // neither workspace can account for: invisible to the org that owns the
      // row, and surviving in the org whose user was deleted. The pair has to
      // match a single User, so the database refuses it rather than trusting
      // whichever route wrote it.
      await assert.rejects(() =>
        raw.inboxView.create({
          data: {
            organizationId: orgA.organizationId,
            ownerId: orgB.userId,
            name: 'cross-org owner',
            filter: {},
          },
        }),
      );
    });
    await check('inbox views: never cross organizations on read', async () => {
      // Shared views carry no owner, so nothing about the row itself scopes it
      // to a workspace except organizationId. A leak here would put one
      // subscriber's saved filters — and their names — in another's inbox.
      const write = (org, ownerId) =>
        runAsOrganization(org.organizationId, () =>
          scoped.inboxView.create({
            data: {
              organizationId: org.organizationId,
              ownerId,
              name: 'bleed-probe',
              filter: { status: ['OPEN'] },
            },
          }),
        );

      // One private and one shared in each org: the shared row is the one with
      // no owner to scope it.
      await write(orgA, orgA.userId);
      await write(orgA, null);
      await write(orgB, orgB.userId);
      await write(orgB, null);

      const seen = await runAsOrganization(orgA.organizationId, () =>
        scoped.inboxView.findMany({ select: { organizationId: true } }),
      );
      assert.ok(seen.length > 0);
      assert.ok(seen.every((row) => row.organizationId === orgA.organizationId));
    });
    await check('billing: composite FK rejects cross-org receipt invoice writes', async () => {
      // A receipt is the record that money was taken. Pointing one at another
      // organization's invoice would credit that org's balance from this org's
      // payment — the database refuses it rather than trusting the caller.
      const invoiceB = await raw.invoice.create({
        data: {
          organizationId: orgB.organizationId,
          provider: 'manual',
          invoiceRef: `invoice-receipt-cross-${Date.now()}`,
          status: 'OPEN',
          amountDueCents: 1000,
        },
      });
      await assert.rejects(() =>
        raw.paymentReceipt.create({
          data: {
            organizationId: orgA.organizationId,
            invoiceId: invoiceB.id,
            reference: `rcpt-cross-${Date.now()}`,
            amountCents: 1000,
            currency: 'USD',
            method: 'cash',
            paidAt: new Date(),
          },
        }),
      );
    });
    await check('billing: receipts never cross organizations on read', async () => {
      const write = (organizationId, reference) =>
        runAsOrganization(organizationId, () =>
          scoped.paymentReceipt.create({
            data: {
              organizationId,
              reference,
              amountCents: 500,
              currency: 'USD',
              method: 'cash',
              paidAt: new Date(),
            },
          }),
        );

      const stamp = Date.now();
      await write(orgA.organizationId, `rcpt-a-${stamp}`);
      await write(orgB.organizationId, `rcpt-b-${stamp}`);

      const seenByA = await runAsOrganization(orgA.organizationId, () =>
        scoped.paymentReceipt.findMany({ select: { organizationId: true } }),
      );
      assert.ok(seenByA.length > 0);
      assert.ok(seenByA.every((row) => row.organizationId === orgA.organizationId));
    });
    await check('webhooks: delivery logs never cross organizations', async () => {
      const write = (organizationId, direction, ok) =>
        runAsOrganization(organizationId, () =>
          scoped.webhookDeliveryLog.create({
            data: {
              organizationId,
              direction,
              webhookId: 'bleed--' + organizationId,
              eventType: 'probe',
              ok,
              durationMs: 5,
            },
          }),
        );

      await write(orgA.organizationId, 'OUTBOUND', false);
      await write(orgB.organizationId, 'INBOUND', true);

      const seenByA = await runAsOrganization(orgA.organizationId, () =>
        scoped.webhookDeliveryLog.findMany({ select: { organizationId: true, webhookId: true } }),
      );
      const seenByB = await runAsOrganization(orgB.organizationId, () =>
        scoped.webhookDeliveryLog.findMany({ select: { organizationId: true, webhookId: true } }),
      );

      assert.ok(
        seenByA.length > 0 && seenByA.every((row) => row.organizationId === orgA.organizationId),
        'org a must see only its own delivery logs',
      );
      assert.ok(
        seenByB.length > 0 && seenByB.every((row) => row.organizationId === orgB.organizationId),
        'org b must see only its own delivery logs',
      );

      // The failure rate is the number the health view leads with, so it is the
      // one that must not absorb another tenant's failures.
      const failuresForB = await runAsOrganization(orgB.organizationId, () =>
        scoped.webhookDeliveryLog.count({ where: { ok: false } }),
      );
      assert.equal(failuresForB, 0, 'org b must not count org a webhook failures');
    });

    await check('webhooks: a delivery log cannot be attached to another org workflow', async () => {
      const workflowA = await runAsOrganization(orgA.organizationId, () =>
        scoped.workflow.create({
          data: {
            id: 'bleed_wf_a',
            organizationId: orgA.organizationId,
            name: 'bleed workflow a',
            triggerType: 'CONVERSATION_CREATED',
            configJson: { actions: [] },
          },
        }),
      );

      // The composite FK is the boundary here, not the extension: org B naming
      // org A's workflow must fail at the database.
      await assert.rejects(() =>
        runAsOrganization(orgB.organizationId, () =>
          scoped.webhookDeliveryLog.create({
            data: {
              organizationId: orgB.organizationId,
              direction: 'OUTBOUND',
              webhookId: 'bleed--cross',
              eventType: 'probe',
              workflowId: workflowA.id,
              ok: false,
              durationMs: 1,
            },
          }),
        ),
      );
    });

    await check('lifecycle: stages never cross organizations', async () => {
      const create = (organizationId, name) =>
        runAsOrganization(organizationId, () =>
          scoped.lifecycleStage.create({
            data: { organizationId, name, orderIndex: 0 },
          }),
        );

      await create(orgA.organizationId, 'Bleed Stage A');
      await create(orgB.organizationId, 'Bleed Stage B');

      const stagesForB = await runAsOrganization(orgB.organizationId, () =>
        scoped.lifecycleStage.findMany({ select: { name: true, organizationId: true } }),
      );

      assert.ok(
        stagesForB.every((row) => row.organizationId === orgB.organizationId),
        'org b must see only its own stages',
      );
      assert.ok(
        !stagesForB.some((row) => row.name === 'Bleed Stage A'),
        'org a stage must not appear in org b pipeline',
      );

      // Same name in two tenants is legitimate — the unique constraint is
      // per-organization, and a shared vocabulary is the normal case.
      await create(orgA.organizationId, 'Shared Name');
      await create(orgB.organizationId, 'Shared Name');

      // ...but twice in one tenant is not.
      await assert.rejects(() => create(orgA.organizationId, 'Shared Name'));
    });

    await check('analytics: hourly rollup buckets never cross organizations', async () => {
      const { recomputeHours, floorToHour } = require('../src/modules/analytics/rollup.service');
      const hour = floorToHour(new Date());

      // Org A has a message in this hour; org B has none.
      await runAsOrganization(orgA.organizationId, () =>
        scoped.message.create({
          data: {
            id: 'bleed_rollup_msg_a',
            organizationId: orgA.organizationId,
            conversationId: orgA.records[0].conversation.id,
            direction: 'INBOUND',
            body: 'counted for org a only',
            timestamp: new Date(hour.getTime() + 60000),
          },
        }),
      );

      await recomputeHours(orgA.organizationId, [hour]);
      await recomputeHours(orgB.organizationId, [hour]);

      const bucketOf = (organizationId) =>
        runAsOrganization(organizationId, () =>
          scoped.analyticsHourly.findFirst({ where: { hourStart: hour } }),
        );

      const beforeA = await bucketOf(orgA.organizationId);
      const beforeB = await bucketOf(orgB.organizationId);
      assert.ok(beforeA, 'org a should have a bucket for this hour');
      assert.ok(beforeB, 'org b should have a bucket for this hour');

      // Both fixtures seed their own traffic, so the absolute counts are not
      // zero and asserting on them would prove nothing. What isolation means
      // here is that one more message in A moves A by exactly one and leaves
      // B untouched.
      await runAsOrganization(orgA.organizationId, () =>
        scoped.message.create({
          data: {
            id: 'bleed_rollup_msg_a2',
            organizationId: orgA.organizationId,
            conversationId: orgA.records[0].conversation.id,
            direction: 'INBOUND',
            body: 'second message for org a only',
            timestamp: new Date(hour.getTime() + 120000),
          },
        }),
      );

      await recomputeHours(orgA.organizationId, [hour]);
      await recomputeHours(orgB.organizationId, [hour]);

      const afterA = await bucketOf(orgA.organizationId);
      const afterB = await bucketOf(orgB.organizationId);

      assert.equal(
        afterA.inbound - beforeA.inbound,
        1,
        'org a bucket must count exactly its own new message',
      );
      assert.equal(
        afterB.inbound - beforeB.inbound,
        0,
        'org b bucket must not move when org a receives a message',
      );

      // A caller asking explicitly for another tenant’s rows does not get an
      // empty result — it gets its own. The extension overwrites the
      // `organizationId` in `where` rather than intersecting with it, so the
      // property worth asserting is that nothing returned belongs to org A.
      const attempted = await runAsOrganization(orgB.organizationId, () =>
        scoped.analyticsHourly.findMany({ where: { organizationId: orgA.organizationId } }),
      );
      assert.ok(
        attempted.every((row) => row.organizationId === orgB.organizationId),
        'a cross-tenant filter must not widen the scope past the caller',
      );
    });

    await check('analytics: report aggregates are scoped to the caller organization', async () => {
      const reporting = require('../src/modules/analytics/reporting.service');
      const period = { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) };

      const inboundOf = (report) => report.headlines.find((h) => h.key === 'inbound').value;
      const overviewFor = (organizationId) =>
        runAsOrganization(organizationId, () => reporting.overview(period, {}, organizationId));

      const beforeA = inboundOf(await overviewFor(orgA.organizationId));
      const beforeB = inboundOf(await overviewFor(orgB.organizationId));

      // Both fixtures carry seeded traffic, so isolation is a statement about
      // movement: A’s new message must be visible to A and invisible to B.
      await runAsOrganization(orgA.organizationId, () =>
        scoped.message.create({
          data: {
            id: 'bleed_overview_msg_a',
            organizationId: orgA.organizationId,
            conversationId: orgA.records[0].conversation.id,
            direction: 'INBOUND',
            body: 'overview isolation probe',
            timestamp: new Date(),
          },
        }),
      );

      const afterA = inboundOf(await overviewFor(orgA.organizationId));
      const afterB = inboundOf(await overviewFor(orgB.organizationId));

      assert.equal(afterA - beforeA, 1, 'org a must count its own inbound message');
      assert.equal(afterB - beforeB, 0, 'org b must not count org a inbound messages');
    });

    await check('analytics: campaign reply counting does not traverse into another organization', async () => {
      const reporting = require('../src/modules/analytics/reporting.service');
      const period = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 3600_000) };

      // This is the one report query that walks nested relation filters, and
      // the tenancy extension does not descend into those — so it is the first
      // place a cross-tenant read could appear.
      const rowsB = await runAsOrganization(orgB.organizationId, () =>
        reporting.campaignPerformance(period, orgB.organizationId),
      );
      assert.ok(Array.isArray(rowsB));
      assert.ok(
        rowsB.every((row) => row.replied === 0),
        'org b must not attribute org a replies to its campaigns',
      );
    });

    await check('database: cross-org nested write is rejected by a composite FK', async () => {
      await assert.rejects(() =>
        runAsOrganization(orgA.organizationId, () =>
          scoped.conversation.create({
            data: {
              id: 'bleed_nested_parent_a',
              organizationId: orgA.organizationId,
              displayId: 9999,
              contactId: orgA.records[0].contact.id,
              sessionId: orgA.sessionId,
              messages: {
                create: {
                  id: 'bleed_nested_child_b',
                  organizationId: orgB.organizationId,
                  direction: 'INBOUND',
                  body: 'nested child must be rejected by database',
                },
              },
            },
          }),
        ),
      );
    });
  } catch (error) {
    record(
      'database: clean migration chain supports the current Prisma schema and fixtures',
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    if (backendChild && backendChild.exitCode === null) backendChild.kill('SIGTERM');
    const gatewayQueueModule = require.cache[require.resolve('../src/workers/gateway-provisioning.queue')];
    if (gatewayQueueModule) await require('../src/workers/gateway-provisioning.queue').gatewayProvisioningQueue.close().catch(() => {});
    const billingQueueModule = require.cache[require.resolve('../src/workers/billing-reconciliation.worker')];
    if (billingQueueModule) await require('../src/workers/billing-reconciliation.worker').billingReconciliationQueue.close().catch(() => {});
    // Any queue whose module was loaded keeps a Redis connection open, and an
    // unclosed one makes this harness hang after reporting success rather than
    // exit — a green run that never returns is worse than a red one.
    const rollupQueueModule = require.cache[require.resolve('../src/workers/analytics-rollup.worker')];
    if (rollupQueueModule) await require('../src/workers/analytics-rollup.worker').analyticsRollupQueue.close().catch(() => {});
    const healthQueueModule = require.cache[require.resolve('../src/workers/gateway-health.worker')];
    if (healthQueueModule) await require('../src/workers/gateway-health.worker').gatewayHealthQueue.close().catch(() => {});
    const appPrismaModule = require.cache[require.resolve('../src/prisma')];
    if (appPrismaModule) await require('../src/prisma').prisma.$disconnect().catch(() => {});
    await raw.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((error) => {
      record('database: drop disposable schema', false, String(error));
    });
    await admin.$disconnect().catch(() => {});
  }
}

async function workerAudits() {
  const incoming = require('../src/workers/incoming-message.worker');
  const campaign = require('../src/workers/campaign.worker');
  const escalation = require('../src/workers/escalation.worker');
  // incoming-message.worker imports the workflow queue, whose module-scope
  // Redis connection would otherwise keep this process alive after every check
  // has passed — the harness would hang rather than fail, which is worse.
  const workflow = require('../src/workers/workflow.worker');
  try {
    await check('worker: incoming handler rejects missing organization context', async () => {
      await assert.rejects(() => incoming.processIncomingMessageJob({}), /missing organizationId/);
    });
    await check('worker: campaign handler rejects missing organization context', async () => {
      await assert.rejects(() => campaign.processCampaignJob({}), /missing organizationId/);
    });
    await check('worker: escalation handler rejects missing organization context', async () => {
      await assert.rejects(() => escalation.processEscalationJob({}), /missing organizationId/);
    });
  } finally {
    await Promise.allSettled([
      incoming.incomingMessageQueue.close(),
      campaign.campaignQueue.close(),
      escalation.escalationQueue.close(),
      workflow.workflowQueue.close(),
    ]);
  }
}

async function main() {
  process.stdout.write('RabiTech tenant isolation and usage-metering harness\n\n');
  const tscCli = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  command('baseline: backend typecheck', process.execPath, [tscCli, '--noEmit', '-p', '.']);
  command('baseline: Prisma constructor lint', process.execPath, ['scripts/lint-prisma-client.js']);
  staticAudits();
  await databaseAudits();
  await workerAudits();

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    process.stdout.write('Failed checks:\n');
    failed.forEach((result) => process.stdout.write(`- ${result.name}\n`));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
