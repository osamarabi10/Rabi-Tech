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
    await check('billing: free signup verifies email without auto-provisioning a gateway', async () => {
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
      assert.equal(organization.status, 'ACTIVE');
      assert.equal(organization.tier, 'FREE');
      assert.equal(channel.provisioningState, 'PENDING');
      assert.equal(channel.apiPort, null);
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
