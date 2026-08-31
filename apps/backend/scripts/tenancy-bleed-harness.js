#!/usr/bin/env node

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { io: createSocketClient } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');
const results = [];

// Repo root, not apps/backend. There is one .env for this project and it lives
// at the top; a second copy under apps/backend drifted from it and pointed this
// gate at `localhost:5432` — a different Postgres entirely, where the harness
// would have created its disposable schema and proved nothing about isolation.
// Two files meant two truths, and the wrong one was silently winning.
require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });
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

/** Last `lines` lines of a child's output, so a failure is legible, not a wall. */
function tailLines(text, lines = 20) {
  const trimmed = String(text || '').trimEnd();
  if (!trimmed) return '';
  const split = trimmed.split(/\r?\n/);
  return split.length <= lines ? trimmed : split.slice(-lines).join('\n');
}

/**
 * A gate step that runs a child process.
 *
 * **The timeout is the point.** `spawnSync` without one blocks this process
 * forever, and the harness is single-threaded, so a single stuck child hangs
 * the whole isolation gate with nothing on stdout to say why. That is not
 * hypothetical: on 2026-08-29 a degraded Docker host port proxy left
 * `prisma migrate deploy` waiting on a half-open socket, and the gate sat
 * silent for 33 minutes until it was killed by hand. Orphaned
 * `rabitech_bleed_*` schemas show it had happened before, unnoticed. A release
 * blocker that can hang indefinitely without output is not a safety net — it
 * is a coin flip nobody is watching.
 *
 * `rabitech_diff_shadow`, `rabitech_p1b_shadow` and `rabitech_p1d_debug` were
 * listed here too, and are not this. They carry a pre-tenancy schema — `Zone`,
 * `Sequence`, `GroupMessage` — so they cannot be corpses of a gate that only
 * ever ran against the current one. See D-8 in docs/KNOWN-DEFECTS.md.
 *
 * So: bound every child, and report the tail of what it said. A gate may fail.
 * It may not hang.
 */
const COMMAND_TIMEOUT_MS = Number(process.env.HARNESS_COMMAND_TIMEOUT_MS || 300_000);

function command(name, executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });

  // spawnSync reports a timeout as an error with the child already killed.
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    const reason = timedOut
      ? `timed out after ${timeoutMs}ms and was killed`
      : `could not run: ${result.error.message}`;
    const trailing = tailLines(`${result.stdout || ''}\n${result.stderr || ''}`);
    record(name, false, trailing ? `${reason}\n${trailing}` : reason);
    return false;
  }

  if (result.status !== 0) {
    const output = tailLines(`${result.stdout || ''}\n${result.stderr || ''}`);
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

  const { renderDynamicVariables } = require('../src/utils/template');
  const rendered = renderDynamicVariables(
    'Hi $contact.name / $contact.order_ref / $system.current_date / $contact.missing',
    {
      contact: { id: 'contact-a', name: 'Maya', customFields: { order_ref: 'A-42' } },
      timezone: 'UTC',
      now: new Date('2026-08-26T10:20:30.000Z'),
    },
  );
  record(
    'audit: Snippet variables resolve standard, custom, and system values without erasing unknown fields',
    rendered === 'Hi Maya / A-42 / 2026-08-26 / $contact.missing',
    rendered,
  );

  // The capability principle, as something a machine can check.
  //
  // Channels differ - Meta has a 24-hour service window and cannot open a
  // conversation, OpenWA has neither restriction - and the ONLY sanctioned way
  // for the UI to learn that is the capability descriptor. A component that asks
  // "is this Meta?" has to be edited every time a channel is added, and until
  // someone remembers to, it forbids what one channel allows or offers what
  // another rejects. Asking "can this channel start a conversation?" is a
  // question about the rule, and a new channel answers it by existing.
  //
  // Kept as a literal grep because that is exactly what makes it enforceable:
  // the principle is otherwise a paragraph in a type definition that nothing
  // stops the next component from ignoring.
  const frontendRoot = path.resolve(REPO_ROOT, 'apps', 'frontend');
  const uiDirs = ['app', 'components', 'lib', 'hooks'];
  const kindComparisons = [];
  for (const dir of uiDirs) {
    const full = path.join(frontendRoot, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of walk(full)) {
      if (!/\.(?:ts|tsx)$/.test(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        // Comparisons only. Passing a kind as data - a request body naming which
        // channel to activate - is legitimate and not what this forbids.
        if (/[=!]==\s*['"`](?:WHATSAPP_CLOUD|META)['"`]/.test(line)
          || /['"`](?:WHATSAPP_CLOUD|META)['"`]\s*[=!]==/.test(line)) {
          kindComparisons.push(`${path.relative(frontendRoot, file).replace(/\\/g, '/')}:${index + 1}`);
        }
      });
    }
  }
  // Note this matches comments as well as code, deliberately. The cost is
  // rewording a sentence; the benefit is a rule with no exceptions to argue
  // about, and it has already caught one comment that quoted the very pattern
  // it was warning against.
  record(
    'audit: no frontend component branches on channel identity instead of capabilities',
    kindComparisons.length === 0,
    kindComparisons.join(', '),
  );

  const openwaWebhookSource = fs.readFileSync(
    path.join(ROOT, 'src', 'webhooks', 'openwa.webhook.ts'), 'utf8');
  const metaWebhookSource = fs.readFileSync(
    path.join(ROOT, 'src', 'webhooks', 'meta.webhook.ts'), 'utf8');
  const incomingWorkerSource = fs.readFileSync(
    path.join(ROOT, 'src', 'workers', 'incoming-message.worker.ts'), 'utf8');
  const conversationSource = fs.readFileSync(
    path.join(ROOT, 'src', 'modules', 'conversations', 'conversations.routes.ts'), 'utf8');
  const directProviderIdWrites = conversationSource.match(
    /waMessageId:\s*result\.providerMessageId/g,
  ) || [];
  record(
    'audit: direct sends persist provider message ids for later acknowledgements',
    directProviderIdWrites.length >= 3,
    `found ${directProviderIdWrites.length} persisted direct-send results`,
  );
  const filenameHandoffFailures = [];
  if (!/mediaFileName:\s*msg\.media\?\.filename/.test(openwaWebhookSource)) {
    filenameHandoffFailures.push('OpenWA media.filename is not extracted');
  }
  if (!/mediaFileName:\s*payload\.mediaFileName/.test(openwaWebhookSource)) {
    filenameHandoffFailures.push('OpenWA filename is not queued');
  }
  if (!/mediaFileName\s*=\s*stored\.fileName\s*\|\|\s*mediaFileName/.test(metaWebhookSource)
    || !/\n\s*mediaFileName,\n\s*fromMe: false/.test(metaWebhookSource)) {
    filenameHandoffFailures.push('Meta filename is not queued');
  }
  if (!/mediaFileName:\s*hasMedia\s*\?\s*mediaFileName\s*:\s*null/.test(incomingWorkerSource)) {
    filenameHandoffFailures.push('queued filename is not written to Message.mediaFileName');
  }
  record(
    'audit: inbound media filenames reach Message.mediaFileName on OpenWA and Meta',
    filenameHandoffFailures.length === 0,
    filenameHandoffFailures.join(' | '),
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
      DISABLE_WEEKLY_RECAP_WORKER: '1',
      DISABLE_META_TEMPLATE_SYNC_WORKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The child is intentionally quiet, but a pipe still has a finite buffer.
  // Drain both streams or a verbose provisioning pass eventually blocks the
  // backend inside write(), and the next HTTP assertion waits forever.
  child.stdout.resume();
  child.stderr.resume();
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
  const snippetHarnessRoot = path.resolve(REPO_ROOT, '.tools', 'snippet-harness');
  const snippetUploadDir = path.resolve(snippetHarnessRoot, schemaName);
  if (!snippetUploadDir.startsWith(`${snippetHarnessRoot}${path.sep}`)) {
    throw new Error('Snippet harness upload path escaped its scratch directory');
  }
  const previousSnippetUploadDir = process.env.SNIPPET_UPLOAD_DIR;
  process.env.SNIPPET_UPLOAD_DIR = snippetUploadDir;
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
    // Load the edition catalogue before any check runs, which is what the
    // server's boot gate now does before it opens the port.
    //
    // Without this the harness is not testing the product. getEdition no
    // longer falls back to PLAN_ENTITLEMENTS - an unloaded catalogue resolves
    // to the restricted floor, which grants nothing - so every entitlement
    // check before the first explicit refresh would assert against zeros. That
    // is correct behaviour for a process that cannot read the catalogue, and
    // the wrong starting state for a test suite, because the real process
    // refuses to serve at all in that state.
    await runAsPlatform('bleed-editions-boot', () =>
      require('../src/modules/billing/editions.service').refreshEditions());

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
    let restrictedAgentId;
    let restrictedAgentToken;
    let restrictedAgentIdentityId;
    let invitedSupervisorId;
    let invitedSupervisorIdentityId;

    await check('snippets: topics, files, and mutations remain workspace-scoped', async () => {
      const topicResponse = await fetch(`${baseUrl}/api/snippets/topics`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Billing' }),
      });
      const topicText = await topicResponse.text();
      assert.equal(topicResponse.status, 201, topicText);
      const topic = JSON.parse(topicText);

      const snippetResponse = await fetch(`${baseUrl}/api/snippets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Invoice copy', shortCode: 'invoice',
          body: 'Hello $contact.name, invoice $contact.invoice_id is attached.',
          topicIds: [topic.id],
        }),
      });
      const snippetText = await snippetResponse.text();
      assert.equal(snippetResponse.status, 201, snippetText);
      const snippet = JSON.parse(snippetText);
      assert.deepEqual(snippet.topics.map((row) => row.id), [topic.id]);

      const upload = await fetch(`${baseUrl}/api/snippets/${snippet.id}/attachments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'text/plain',
          'X-File-Name': encodeURIComponent('invoice-guide.txt'),
        },
        body: Buffer.from('workspace A only'),
      });
      const uploadText = await upload.text();
      assert.equal(upload.status, 201, uploadText);
      const attachment = JSON.parse(uploadText);
      assert.equal(attachment.fileName, 'invoice-guide.txt');

      const asset = await fetch(`${baseUrl}${attachment.url}`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), 'workspace A only');

      const listB = await fetch(`${baseUrl}/api/snippets`, { headers: { Authorization: `Bearer ${tokenB}` } });
      assert.equal(listB.status, 200);
      const snippetsB = await listB.json();
      assert.ok(snippetsB.length > 0);
      assert.ok(snippetsB.every((row) => row.organizationId === orgB.organizationId));
      assert.ok(!snippetsB.some((row) => row.id === snippet.id));

      const crossUpdate = await fetch(`${baseUrl}/api/snippets/${snippet.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Cross-tenant edit' }),
      });
      assert.equal(crossUpdate.status, 404);

      const row = await raw.messageTemplate.findUnique({ where: { id: snippet.id } });
      const topicB = await raw.snippetTopic.create({ data: { organizationId: orgB.organizationId, name: 'Billing' } });
      await assert.rejects(
        raw.snippetTopicAssignment.create({ data: {
          organizationId: orgB.organizationId,
          templateId: row.id,
          topicId: topicB.id,
        } }),
        (error) => error?.code === 'P2003',
      );
    });

    await check('contact metadata: Tags, fields, provenance, roles, and validation remain workspace-scoped', async () => {
      const makeRoleToken = (user, identity, role) => jwt.sign({
        scope: 'ORGANIZATION', id: user.id, email: identity.email, name: user.name,
        role, organizationId: orgA.organizationId, tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });
      const [managerIdentity, agentIdentity] = await Promise.all([
        raw.identity.create({ data: { email: 'metadata-manager@rabitech.test', passwordHash: 'not-used' } }),
        raw.identity.create({ data: { email: 'metadata-agent@rabitech.test', passwordHash: 'not-used' } }),
      ]);
      const [manager, agent] = await Promise.all([
        raw.user.create({ data: { organizationId: orgA.organizationId, identityId: managerIdentity.id, name: 'Metadata Manager', role: 'SUPERVISOR' } }),
        raw.user.create({ data: { organizationId: orgA.organizationId, identityId: agentIdentity.id, name: 'Metadata Agent', role: 'AGENT' } }),
      ]);
      const managerToken = makeRoleToken(manager, managerIdentity, 'SUPERVISOR');
      const agentToken = makeRoleToken(agent, agentIdentity, 'AGENT');

      const createTag = await fetch(`${baseUrl}/api/contacts/tags`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renewal', description: 'Contract follow-up', colorCode: '#0f766e', emoji: 'R' }),
      });
      const createTagText = await createTag.text();
      assert.equal(createTag.status, 201, createTagText);
      const tag = JSON.parse(createTagText);
      assert.equal(tag.contactCount, 0);

      const agentSettingsWrite = await fetch(`${baseUrl}/api/contacts/tags`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Agent settings escape' }),
      });
      assert.equal(agentSettingsWrite.status, 403);

      const agentAssignment = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}/tags`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Agent-created' }),
      });
      const agentAssignmentText = await agentAssignment.text();
      assert.equal(agentAssignment.status, 201, agentAssignmentText);
      const agentTag = JSON.parse(agentAssignmentText);
      assert.equal(agentTag.source, 'MANUAL');
      assert.equal(agentTag.assignedById, agent.id);
      assert.equal(agentTag.assignedByName, agent.name);

      const assigned = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}/tags`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: tag.id }),
      });
      const assignedText = await assigned.text();
      assert.equal(assigned.status, 201, assignedText);
      const assignments = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}/tags`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((response) => response.json());
      const renewalAssignment = assignments.find((row) => row.id === tag.id);
      assert.equal(renewalAssignment.source, 'MANUAL');
      assert.equal(renewalAssignment.assignedById, orgA.userId);
      assert.ok(renewalAssignment.assignedAt);

      const crossContact = await fetch(`${baseUrl}/api/contacts/${orgB.records[0].contact.id}/tags`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(crossContact.status, 404);
      const crossTagEdit = await fetch(`${baseUrl}/api/contacts/tags/${tag.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cross-tenant edit' }),
      });
      assert.equal(crossTagEdit.status, 404);

      const wrongCount = await fetch(`${baseUrl}/api/contacts/tags/${tag.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmCount: 0 }),
      });
      assert.equal(wrongCount.status, 409);
      assert.equal((await wrongCount.json()).expectedCount, 1);
      const rightCount = await fetch(`${baseUrl}/api/contacts/tags/${tag.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmCount: 1 }),
      });
      assert.equal(rightCount.status, 200, await rightCount.text());

      const createField = await fetch(`${baseUrl}/api/contacts/custom-fields`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Account Tier', dataType: 'list', allowedValues: ['Standard', 'Gold'] }),
      });
      const createFieldText = await createField.text();
      assert.equal(createField.status, 201, createFieldText);
      const field = JSON.parse(createFieldText);
      assert.equal(field.slug, 'account_tier');
      assert.equal(field.dataType, 'list');

      const immutablePatch = await fetch(`${baseUrl}/api/contacts/custom-fields/${field.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Customer Tier', slug: 'changed_id', dataType: 'number', allowedValues: ['Standard', 'Gold', 'Platinum'] }),
      });
      const immutablePatchText = await immutablePatch.text();
      assert.equal(immutablePatch.status, 200, immutablePatchText);
      const immutableResult = JSON.parse(immutablePatchText);
      assert.equal(immutableResult.slug, 'account_tier');
      assert.equal(immutableResult.dataType, 'list');
      assert.deepEqual(immutableResult.allowedValues, ['Standard', 'Gold', 'Platinum']);

      const createDateField = await fetch(`${baseUrl}/api/contacts/custom-fields`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renewal Date', slug: 'renewal_date', dataType: 'date' }),
      });
      const createDateFieldText = await createDateField.text();
      assert.equal(createDateField.status, 201, createDateFieldText);
      const dateField = JSON.parse(createDateFieldText);
      const invalidDate = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}/custom-fields/renewal_date`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: '2026-02-31' }),
      });
      assert.equal(invalidDate.status, 400);
      const validDate = await fetch(`${baseUrl}/api/contacts/${orgA.records[0].contact.id}/custom-fields/renewal_date`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: '2028-02-29' }),
      });
      assert.equal(validDate.status, 200, await validDate.text());

      const invalidImport = await fetch(`${baseUrl}/api/contacts/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          consentAffirmed: true,
          defaultCountryCode: '970',
          rows: [{ phone: '599777888', name: 'Invalid Date Import', customFields: { renewal_date: '2027-13-01' } }],
        }),
      });
      const invalidImportText = await invalidImport.text();
      assert.equal(invalidImport.status, 200, invalidImportText);
      const importSummary = JSON.parse(invalidImportText);
      assert.equal(importSummary.failed, 1);
      assert.equal(importSummary.created, 0);

      const saveView = await fetch(`${baseUrl}/api/contacts/contact-fields/view`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: [
          { fieldKey: `custom:${dateField.id}`, visibility: 'ALWAYS_SHOW' },
          { fieldKey: 'firstName', visibility: 'ALWAYS_SHOW' },
          { fieldKey: `custom:${field.id}`, visibility: 'HIDE_WHEN_EMPTY' },
        ] }),
      });
      assert.equal(saveView.status, 200, await saveView.text());
      const viewA = await fetch(`${baseUrl}/api/contacts/contact-fields`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json());
      assert.equal(viewA[0].fieldKey, `custom:${dateField.id}`);
      const viewB = await fetch(`${baseUrl}/api/contacts/contact-fields`, { headers: { Authorization: `Bearer ${tokenB}` } }).then((response) => response.json());
      assert.ok(!viewB.some((row) => row.id === field.id || row.id === dateField.id));

      const managerDelete = await fetch(`${baseUrl}/api/contacts/custom-fields/${field.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${managerToken}` },
      });
      assert.equal(managerDelete.status, 403);
      const crossDelete = await fetch(`${baseUrl}/api/contacts/custom-fields/${field.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(crossDelete.status, 404);
      const ownerDelete = await fetch(`${baseUrl}/api/contacts/custom-fields/${field.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(ownerDelete.status, 200, await ownerDelete.text());
    });

    await check('contacts: merge suggestions, confirmation boundary, export permissions, and audit stay tenant-scoped', async () => {
      const primary = await raw.contact.create({
        data: { id: 'bleed_merge_primary_a', organizationId: orgA.organizationId, phone: '972500000201', name: 'Merge Candidate' },
      });
      const secondary = await raw.contact.create({
        data: { id: 'bleed_merge_secondary_a', organizationId: orgA.organizationId, phone: '972500000202', name: ' merge   candidate ' },
      });
      const foreign = await raw.contact.create({
        data: { id: 'bleed_merge_foreign_b', organizationId: orgB.organizationId, phone: '972500000203', name: 'Merge Candidate' },
      });
      const secondaryConversation = await raw.conversation.create({
        data: {
          id: 'bleed_merge_conversation_a',
          organizationId: orgA.organizationId,
          displayId: 2201,
          contactId: secondary.id,
          sessionId: orgA.sessionId,
          status: 'OPEN',
        },
      });
      const agentIdentity = await raw.identity.create({
        data: { email: 'merge-agent@rabitech.test', passwordHash: 'not-used' },
      });
      const agent = await raw.user.create({
        data: { organizationId: orgA.organizationId, identityId: agentIdentity.id, name: 'Merge Agent', role: 'AGENT' },
      });
      const agentToken = jwt.sign({
        scope: 'ORGANIZATION', id: agent.id, email: agentIdentity.email, name: agent.name,
        role: 'AGENT', organizationId: orgA.organizationId, tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });

      const suggestionsResponse = await fetch(`${baseUrl}/api/contacts/merge-suggestions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const suggestionsText = await suggestionsResponse.text();
      assert.equal(suggestionsResponse.status, 200, suggestionsText);
      const suggestions = JSON.parse(suggestionsText).suggestions;
      const suggestion = suggestions.find((row) => (
        row.primary.id === primary.id && row.secondary.id === secondary.id
      ));
      assert.ok(suggestion, 'same-name contacts did not produce a deterministic merge suggestion');
      assert.ok(suggestions.every((row) => row.primary.id !== foreign.id && row.secondary.id !== foreign.id),
        'org A received a merge suggestion containing an org B contact');

      const agentSuggestions = await fetch(`${baseUrl}/api/contacts/merge-suggestions`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      assert.equal(agentSuggestions.status, 403, 'an agent could inspect merge candidates without merge permission');
      const agentExport = await fetch(`${baseUrl}/api/contacts/export`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      assert.equal(agentExport.status, 403, 'an agent could export contacts without export permission');

      const crossMerge = await fetch(`${baseUrl}/api/contacts/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryContactId: primary.id, secondaryContactId: foreign.id }),
      });
      assert.equal(crossMerge.status, 400, 'cross-tenant merge was accepted by the route');
      const foreignAfterAttempt = await raw.contact.findUnique({ where: { id: foreign.id } });
      assert.equal(foreignAfterAttempt.isArchived, false, 'cross-tenant merge changed org B');

      // The route check is defense in depth. The composite child key is the
      // database boundary: even a deliberately broken route cannot attach an
      // org B contact to an org A conversation.
      await assert.rejects(
        () => raw.conversation.update({ where: { id: secondaryConversation.id }, data: { contactId: foreign.id } }),
        (error) => error?.code === 'P2003',
        'the database accepted a cross-tenant conversation/contact reference',
      );

      const exported = await fetch(`${baseUrl}/api/contacts/export`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const csv = await exported.text();
      assert.equal(exported.status, 200, csv);
      assert.match(csv, /Merge Candidate/);
      assert.doesNotMatch(csv, /bleed_merge_foreign_b/);
      const exportAudit = await raw.auditLog.findFirst({
        where: { organizationId: orgA.organizationId, action: 'contact.exported', resourceId: orgA.organizationId },
        orderBy: { timestamp: 'desc' },
      });
      assert.ok(exportAudit, 'contact export did not create an audit record');

      const mergedResponse = await fetch(`${baseUrl}/api/contacts/merge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryContactId: primary.id, secondaryContactId: secondary.id }),
      });
      const mergedText = await mergedResponse.text();
      assert.equal(mergedResponse.status, 200, mergedText);
      assert.equal(JSON.parse(mergedText).id, primary.id);
      const [secondaryAfter, conversationAfter] = await Promise.all([
        raw.contact.findUnique({ where: { id: secondary.id } }),
        raw.conversation.findUnique({ where: { id: secondaryConversation.id } }),
      ]);
      assert.equal(secondaryAfter.isArchived, true, 'the confirmed secondary contact was not archived');
      assert.equal(conversationAfter.contactId, primary.id, 'secondary conversation was not moved to the primary contact');
      const mergeAudit = await raw.auditLog.findFirst({
        where: { organizationId: orgA.organizationId, action: 'contact.merged', resourceId: primary.id },
        orderBy: { timestamp: 'desc' },
      });
      assert.ok(mergeAudit, 'contact merge did not create an audit record');

      await raw.user.delete({ where: { id: agent.id } });
      await raw.identity.delete({ where: { id: agentIdentity.id } });
      await raw.conversation.delete({ where: { id: secondaryConversation.id } });
      await raw.contact.deleteMany({ where: { id: { in: [primary.id, secondary.id, foreign.id] } } });
    });

    await check('workspace settings: policy and recap recipients remain organization-scoped', async () => {
      const beforeB = await raw.organizationConfig.findUnique({ where: { organizationId: orgB.organizationId } });
      const update = await fetch(`${baseUrl}/api/system/workspace-settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bleed Workspace Alpha',
          timezone: 'Asia/Hebron',
          userInactivityTimeoutMinutes: 5,
          weeklyRecapEnabled: true,
          weeklyRecapRecipientIds: [orgA.userId],
        }),
      });
      assert.equal(update.status, 200);
      const updated = await update.json();
      assert.equal(updated.name, 'Bleed Workspace Alpha');
      assert.equal(updated.timezone, 'Asia/Hebron');
      assert.equal(updated.userInactivityTimeoutMinutes, 5);
      assert.equal(updated.weeklyRecapEnabled, true);
      assert.deepEqual(updated.weeklyRecapRecipientIds, [orgA.userId]);
      assert.ok(updated.eligibleRecipients.every((user) => user.id !== orgB.userId));

      const crossRecipient = await fetch(`${baseUrl}/api/system/workspace-settings`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ weeklyRecapRecipientIds: [orgB.userId] }),
      });
      assert.equal(crossRecipient.status, 400);
      assert.equal(await raw.weeklyRecapRecipient.count({
        where: { organizationId: orgA.organizationId, userId: orgB.userId },
      }), 0);

      await assert.rejects(
        raw.weeklyRecapRecipient.create({
          data: { organizationId: orgA.organizationId, userId: orgB.userId },
        }),
        (error) => error?.code === 'P2003',
      );

      const afterB = await raw.organizationConfig.findUnique({ where: { organizationId: orgB.organizationId } });
      assert.equal(afterB.timezone, beforeB.timezone);
      assert.equal(afterB.userInactivityTimeoutMinutes, beforeB.userInactivityTimeoutMinutes);
      assert.equal(afterB.weeklyRecapEnabled, beforeB.weeklyRecapEnabled);

      const policyAgentIdentity = await raw.identity.create({
        data: { email: 'policy-agent@rabitech.test', passwordHash: 'not-used' },
      });
      const policyAgent = await raw.user.create({
        data: {
          organizationId: orgA.organizationId,
          identityId: policyAgentIdentity.id,
          name: 'Policy Agent',
          role: 'AGENT',
        },
      });
      const agentToken = jwt.sign({
        scope: 'ORGANIZATION', id: policyAgent.id, email: policyAgentIdentity.email, name: policyAgent.name,
        role: 'AGENT', organizationId: orgA.organizationId, tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });
      const forbidden = await fetch(`${baseUrl}/api/system/workspace-settings`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      });
      assert.equal(forbidden.status, 403);
      await raw.user.delete({ where: { id: policyAgent.id } });
      await raw.identity.delete({ where: { id: policyAgentIdentity.id } });
    });

    await check('workspace users: Manager invitations are Agent-only, tenant-scoped, and single-use', async () => {
      await raw.organization.update({ where: { id: orgA.organizationId }, data: { tier: 'BUSINESS' } });
      const supervisorIdentity = await raw.identity.create({
        data: {
          email: 'bleed-manager@rabitech.test',
          passwordHash: await bcrypt.hash('Manager-Password-123!', 10),
        },
      });
      const supervisor = await raw.user.create({
        data: {
          organizationId: orgA.organizationId,
          identityId: supervisorIdentity.id,
          name: 'Manager A',
          role: 'SUPERVISOR',
        },
      });
      invitedSupervisorId = supervisor.id;
      invitedSupervisorIdentityId = supervisorIdentity.id;
      const managerToken = jwt.sign({
        scope: 'ORGANIZATION', id: supervisor.id, email: supervisorIdentity.email,
        name: supervisor.name, role: 'SUPERVISOR', organizationId: orgA.organizationId,
        tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });

      const deniedRole = await fetch(`${baseUrl}/api/system/user-invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'denied-owner@rabitech.test', role: 'SUPERVISOR' }),
      });
      assert.equal(deniedRole.status, 403);

      const invited = await fetch(`${baseUrl}/api/system/user-invitations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Restricted Agent', email: 'restricted-agent@rabitech.test', role: 'AGENT' }),
      });
      assert.equal(invited.status, 201);
      const invitation = await invited.json();
      assert.ok(invitation.inviteUrl);
      const inviteToken = new URL(invitation.inviteUrl).searchParams.get('token');
      assert.ok(inviteToken);

      const preview = await fetch(`${baseUrl}/api/auth/invitations/${encodeURIComponent(inviteToken)}`);
      assert.equal(preview.status, 200);
      assert.equal((await preview.json()).workspaceName, 'Bleed Workspace Alpha');

      const accepted = await fetch(`${baseUrl}/api/auth/invitations/${encodeURIComponent(inviteToken)}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Restricted Agent', password: 'Agent-Password-123!' }),
      });
      assert.equal(accepted.status, 201);
      restrictedAgentId = (await accepted.json()).user.id;
      restrictedAgentIdentityId = (await raw.identity.findUnique({
        where: { email: 'restricted-agent@rabitech.test' },
        select: { id: true },
      })).id;
      restrictedAgentToken = jwt.sign({
        scope: 'ORGANIZATION', id: restrictedAgentId, email: 'restricted-agent@rabitech.test',
        name: 'Restricted Agent', role: 'AGENT', organizationId: orgA.organizationId,
        tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });

      const reuse = await fetch(`${baseUrl}/api/auth/invitations/${encodeURIComponent(inviteToken)}`);
      assert.equal(reuse.status, 404);

      const listB = await fetch(`${baseUrl}/api/system/user-invitations`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(listB.status, 200);
      assert.ok(!(await listB.json()).some((row) => row.email === 'restricted-agent@rabitech.test'));

      const managerCannotEdit = await fetch(`${baseUrl}/api/system/users/${restrictedAgentId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${managerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ restrictWorkflows: true }),
      });
      assert.equal(managerCannotEdit.status, 403);
    });

    await check('workspace users: contact visibility, masking, and workflow restrictions are server-enforced', async () => {
      assert.ok(restrictedAgentId && restrictedAgentToken);
      await raw.contact.update({
        where: { id: orgA.records[0].contact.id },
        data: { assigneeId: restrictedAgentId, email: 'visible@rabitech.test' },
      });
      const hiddenContact = await raw.contact.create({
        data: {
          id: 'bleed_hidden_contact_a',
          organizationId: orgA.organizationId,
          phone: '+972500000099',
          email: 'hidden@rabitech.test',
          name: 'Hidden Contact A',
        },
      });

      const restricted = await fetch(`${baseUrl}/api/system/users/${restrictedAgentId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restrictContactVisibility: true,
          contactVisibilityScope: 'SELF',
          restrictWorkflows: true,
          maskPhoneAndEmail: true,
        }),
      });
      assert.equal(restricted.status, 200);

      const contacts = await fetch(`${baseUrl}/api/contacts?paginated=1`, {
        headers: { Authorization: `Bearer ${restrictedAgentToken}` },
      });
      assert.equal(contacts.status, 200);
      const contactBody = await contacts.json();
      assert.deepEqual(contactBody.items.map((row) => row.id), [orgA.records[0].contact.id]);
      assert.equal(contactBody.items[0].phone, '••••••');
      assert.equal(contactBody.items[0].email, '••••••');

      const hidden = await fetch(`${baseUrl}/api/contacts/${hiddenContact.id}`, {
        headers: { Authorization: `Bearer ${restrictedAgentToken}` },
      });
      assert.equal(hidden.status, 404);

      const workflows = await fetch(`${baseUrl}/api/workflows/schema`, {
        headers: { Authorization: `Bearer ${restrictedAgentToken}` },
      });
      assert.equal(workflows.status, 403);
      assert.equal((await workflows.json()).code, 'USER_WORKFLOW_RESTRICTED');

      const profile = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${restrictedAgentToken}` },
      });
      assert.equal(profile.status, 200);
      const me = await profile.json();
      assert.equal(me.maskPhoneAndEmail, true);
      assert.ok(me.permissions.every((permission) => !permission.startsWith('workflow:')));

      const foreignTeam = await raw.team.create({
        data: {
          organizationId: orgB.organizationId,
          name: 'Foreign Team B',
          slug: 'foreign-team-b',
        },
      });
      await assert.rejects(
        raw.userInvitation.create({
          data: {
            organizationId: orgA.organizationId,
            email: 'cross-team@rabitech.test',
            role: 'AGENT',
            primaryTeamId: foreignTeam.id,
            tokenHash: 'cross-team-invitation-hash',
            invitedByName: 'Harness',
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
        (error) => error?.code === 'P2003',
      );

      // This harness is sequential. Restore the baseline fixture so later
      // metering and billing checks keep proving their own assumptions rather
      // than counting users and contacts introduced above.
      await raw.contact.update({
        where: { id: orgA.records[0].contact.id },
        data: { assigneeId: null, email: null },
      });
      await raw.contact.delete({ where: { id: hiddenContact.id } });
      await raw.userInvitation.deleteMany({ where: { organizationId: orgA.organizationId } });
      await raw.user.delete({ where: { id: restrictedAgentId } });
      await raw.identity.delete({ where: { id: restrictedAgentIdentityId } });
      await raw.user.delete({ where: { id: invitedSupervisorId } });
      await raw.identity.delete({ where: { id: invitedSupervisorIdentityId } });
      await raw.organization.update({ where: { id: orgA.organizationId }, data: { tier: 'FREE' } });
    });

    await check('teams: membership replacement is atomic and tenant-scoped', async () => {
      const memberIdentity = await raw.identity.create({
        data: { email: 'team-member-a@rabitech.test', passwordHash: 'not-used' },
      });
      const member = await raw.user.create({
        data: {
          organizationId: orgA.organizationId,
          identityId: memberIdentity.id,
          name: 'Team Member A',
          role: 'AGENT',
        },
      });

      const createdA = await fetch(`${baseUrl}/api/system/teams`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Routing A', color: '#2563EB' }),
      });
      const createdB = await fetch(`${baseUrl}/api/system/teams`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Routing B', color: '#059669' }),
      });
      assert.equal(createdA.status, 201);
      assert.equal(createdB.status, 201);
      const teamA = await createdA.json();
      const teamB = await createdB.json();

      const assigned = await fetch(`${baseUrl}/api/system/teams/${teamA.id}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [member.id] }),
      });
      assert.equal(assigned.status, 200);
      assert.deepEqual((await assigned.json()).memberIds, [member.id]);

      const foreignUser = await fetch(`${baseUrl}/api/system/teams/${teamA.id}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [orgB.userId] }),
      });
      assert.equal(foreignUser.status, 400);

      const foreignTeam = await fetch(`${baseUrl}/api/system/teams/${teamB.id}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [member.id] }),
      });
      assert.equal(foreignTeam.status, 404);

      const listedA = await fetch(`${baseUrl}/api/system/teams`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then((response) => response.json());
      assert.deepEqual(listedA.find((team) => team.id === teamA.id).memberIds, [member.id]);
      assert.ok(!listedA.some((team) => team.id === teamB.id));

      const cleared = await fetch(`${baseUrl}/api/system/teams/${teamA.id}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [] }),
      });
      assert.equal(cleared.status, 200);
      assert.equal(await raw.userTeam.count({ where: { organizationId: orgA.organizationId, teamId: teamA.id } }), 0);

      await raw.user.delete({ where: { id: member.id } });
      await raw.identity.delete({ where: { id: memberIdentity.id } });
      const deletedA = await fetch(`${baseUrl}/api/system/teams/${teamA.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const deletedB = await fetch(`${baseUrl}/api/system/teams/${teamB.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.equal(deletedA.status, 200);
      assert.equal(deletedB.status, 200);
    });

    await check('auth: workspace inactivity policy expires only the idle login session', async () => {
      const password = 'Idle-Session-Password-123!';
      await raw.identity.update({
        where: { id: orgA.identityId },
        data: { passwordHash: await bcrypt.hash(password, 10) },
      });
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'bleed-a@rabitech.test', password }),
      });
      assert.equal(login.status, 200);
      const loggedIn = await login.json();
      const decoded = jwt.decode(loggedIn.token);
      assert.ok(decoded.sessionId);

      const active = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${loggedIn.token}` },
      });
      assert.equal(active.status, 200);

      await raw.authSession.update({
        where: { id: decoded.sessionId },
        data: { lastSeenAt: new Date(Date.now() - 6 * 60_000) },
      });
      const expired = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${loggedIn.token}` },
      });
      assert.equal(expired.status, 401);
      assert.equal((await expired.json()).code, 'SESSION_IDLE_TIMEOUT');
      assert.ok((await raw.authSession.findUnique({ where: { id: decoded.sessionId } })).revokedAt);

      const legacyStillWorks = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(legacyStillWorks.status, 200);
    });

    await check('notifications: archive and restore remain user- and organization-scoped', async () => {
      const [noticeA, noticeB] = await Promise.all([
        raw.notification.create({
          data: {
            organizationId: orgA.organizationId,
            userId: orgA.userId,
            type: 'MENTION',
            title: 'Archive probe A',
            body: 'organization A',
          },
        }),
        raw.notification.create({
          data: {
            organizationId: orgB.organizationId,
            userId: orgB.userId,
            type: 'MENTION',
            title: 'Archive probe B',
            body: 'organization B',
          },
        }),
      ]);

      const list = async (scope) => {
        const response = await fetch(`${baseUrl}/api/notifications?scope=${scope}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(response.status, 200);
        return response.json();
      };

      const beforeArchive = await list('new');
      assert.ok(beforeArchive.notifications.some((row) => row.id === noticeA.id));
      assert.ok(!beforeArchive.notifications.some((row) => row.id === noticeB.id));

      const crossArchive = await fetch(`${baseUrl}/api/notifications/${noticeB.id}/archive`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(crossArchive.status, 404);

      const archived = await fetch(`${baseUrl}/api/notifications/${noticeA.id}/archive`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(archived.status, 200);
      assert.ok(!(await list('new')).notifications.some((row) => row.id === noticeA.id));
      assert.ok((await list('archived')).notifications.some((row) => row.id === noticeA.id));

      const restored = await fetch(`${baseUrl}/api/notifications/${noticeA.id}/unarchive`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(restored.status, 200);
      assert.ok((await list('new')).notifications.some((row) => row.id === noticeA.id));
    });

    await check('profile: personal preferences update only the authenticated organization user', async () => {
      const beforeB = await raw.user.findUnique({ where: { id: orgB.userId } });
      const response = await fetch(`${baseUrl}/api/auth/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Profile Alpha',
          phone: '+970 599 123456',
          locale: 'en',
          theme: 'dark',
          avatarUrl: 'https://assets.example.test/avatar-a.png',
          onboardingLifecycleComplete: true,
        }),
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.name, 'Profile Alpha');
      assert.equal(updated.locale, 'en');
      assert.equal(updated.theme, 'dark');
      assert.equal(updated.onboardingLifecycleComplete, true);

      const afterB = await raw.user.findUnique({ where: { id: orgB.userId } });
      assert.equal(afterB.name, beforeB.name);
      assert.equal(afterB.locale, beforeB.locale);
      assert.equal(afterB.theme, beforeB.theme);
      assert.equal(afterB.avatarUrl, beforeB.avatarUrl);
      assert.equal(afterB.onboardingLifecycleComplete, beforeB.onboardingLifecycleComplete);

      const invalid = await fetch(`${baseUrl}/api/auth/me`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'cross-tenant' }),
      });
      assert.equal(invalid.status, 400);
    });

    await check('notifications: delivery preferences update only the authenticated organization user', async () => {
      const beforeB = await raw.user.findUnique({ where: { id: orgB.userId } });
      const response = await fetch(`${baseUrl}/api/auth/me/notification-preferences`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationNewMessage: 'OFF',
          notificationAssignment: 'IN_APP',
          notificationMention: 'OFF',
          notificationResolution: 'IN_APP',
          notificationEscalation: 'OFF',
          notificationSound: false,
        }),
      });
      assert.equal(response.status, 200);
      const updated = await response.json();
      assert.equal(updated.notificationNewMessage, 'OFF');
      assert.equal(updated.notificationMention, 'OFF');
      assert.equal(updated.notificationEscalation, 'OFF');
      assert.equal(updated.notificationSound, false);

      const currentA = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(currentA.status, 200);
      const profileA = await currentA.json();
      assert.equal(profileA.notificationNewMessage, 'OFF');
      assert.equal(profileA.notificationSound, false);

      const afterB = await raw.user.findUnique({ where: { id: orgB.userId } });
      assert.equal(afterB.notificationNewMessage, beforeB.notificationNewMessage);
      assert.equal(afterB.notificationAssignment, beforeB.notificationAssignment);
      assert.equal(afterB.notificationMention, beforeB.notificationMention);
      assert.equal(afterB.notificationResolution, beforeB.notificationResolution);
      assert.equal(afterB.notificationEscalation, beforeB.notificationEscalation);
      assert.equal(afterB.notificationSound, beforeB.notificationSound);

      const invalid = await fetch(`${baseUrl}/api/auth/me/notification-preferences`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationSound: 'yes' }),
      });
      assert.equal(invalid.status, 400);
    });

    await check('auth: TOTP challenges and recovery codes are encrypted, revocable, and single-use', async () => {
      const identityId = 'bleed_identity_2fa';
      const userId = 'bleed_user_2fa';
      const email = 'bleed-2fa@rabitech.test';
      const password = 'StrongPass-2FA-123!';
      await raw.identity.create({
        data: { id: identityId, email, passwordHash: await bcrypt.hash(password, 10) },
      });
      await raw.user.create({
        data: {
          id: userId,
          identityId,
          organizationId: orgA.organizationId,
          name: 'Two Factor Operator',
          role: 'ADMIN',
        },
      });
      const enrollmentToken = jwt.sign({
        scope: 'ORGANIZATION',
        id: userId,
        email,
        name: 'Two Factor Operator',
        role: 'ADMIN',
        organizationId: orgA.organizationId,
        tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });
      const authHeaders = {
        Authorization: `Bearer ${enrollmentToken}`,
        'Content-Type': 'application/json',
      };

      const setupResponse = await fetch(`${baseUrl}/api/auth/me/2fa/setup`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ currentPassword: password }),
      });
      assert.equal(setupResponse.status, 200);
      const setup = await setupResponse.json();
      assert.ok(setup.secret);
      assert.ok(setup.setupToken);
      assert.match(setup.qrDataUrl, /^data:image\/png;base64,/);

      const { generateTotp } = require('../src/modules/auth/two-factor.service');
      const enableResponse = await fetch(`${baseUrl}/api/auth/me/2fa/enable`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ setupToken: setup.setupToken, code: generateTotp(setup.secret) }),
      });
      assert.equal(enableResponse.status, 200);
      const enabled = await enableResponse.json();
      assert.equal(enabled.recoveryCodes.length, 10);
      assert.equal(new Set(enabled.recoveryCodes).size, 10);

      const storedIdentity = await raw.identity.findUnique({ where: { id: identityId } });
      assert.ok(storedIdentity.totpEnabledAt);
      assert.ok(storedIdentity.totpSecretEnc);
      assert.notEqual(storedIdentity.totpSecretEnc, setup.secret);
      assert.equal(await raw.identityRecoveryCode.count({ where: { identityId, usedAt: null } }), 10);

      const revoked = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${enrollmentToken}` } });
      assert.equal(revoked.status, 401);

      const passwordLogin = async () => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        assert.equal(response.status, 202);
        const body = await response.json();
        assert.equal(body.requiresTwoFactor, true);
        assert.ok(body.challengeToken);
        assert.equal(body.token, undefined);
        return body.challengeToken;
      };
      const verifyLogin = (challengeToken, code) => fetch(`${baseUrl}/api/auth/2fa/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
      });

      const totpChallenge = await passwordLogin();
      const loginCode = generateTotp(setup.secret);
      const totpLogin = await verifyLogin(totpChallenge, loginCode);
      assert.equal(totpLogin.status, 200);
      const totpSession = await totpLogin.json();
      assert.ok(totpSession.token);
      assert.equal((await verifyLogin(totpChallenge, loginCode)).status, 401);

      const recoveryChallenge = await passwordLogin();
      const recoveryLogin = await verifyLogin(recoveryChallenge, enabled.recoveryCodes[0]);
      assert.equal(recoveryLogin.status, 200);
      const recoverySession = await recoveryLogin.json();
      assert.ok(recoverySession.token);
      assert.equal(await raw.identityRecoveryCode.count({ where: { identityId, usedAt: null } }), 9);

      const replayChallenge = await passwordLogin();
      assert.equal((await verifyLogin(replayChallenge, enabled.recoveryCodes[0])).status, 401);

      const disableResponse = await fetch(`${baseUrl}/api/auth/me/2fa`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${recoverySession.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ currentPassword: password, code: enabled.recoveryCodes[1] }),
      });
      assert.equal(disableResponse.status, 200);
      const disabled = await raw.identity.findUnique({ where: { id: identityId } });
      assert.equal(disabled.totpSecretEnc, null);
      assert.equal(disabled.totpEnabledAt, null);
      assert.equal(await raw.identityRecoveryCode.count({ where: { identityId } }), 0);

      const plainLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(plainLogin.status, 200);
      assert.ok((await plainLogin.json()).token);
    });

    const socketA = await connectSocket(baseUrl, token);
    const socketB = await connectSocket(baseUrl, tokenB);
    sockets.push(socketA, socketB);

    await check('socket: removing a team member revokes live room access without disconnecting them', async () => {
      const team = await raw.team.create({
        data: {
          organizationId: orgA.organizationId,
          name: 'Live Room Team',
          slug: 'live-room-team',
        },
      });
      const identity = await raw.identity.create({
        data: { email: 'live-room-agent@rabitech.test', passwordHash: 'not-used' },
      });
      const user = await raw.user.create({
        data: {
          organizationId: orgA.organizationId,
          identityId: identity.id,
          name: 'Live Room Agent',
          role: 'AGENT',
          primaryTeamId: team.id,
        },
      });
      await raw.userTeam.create({
        data: { organizationId: orgA.organizationId, userId: user.id, teamId: team.id },
      });
      await raw.conversation.update({
        where: { id: orgA.records[0].conversation.id },
        data: { teamId: team.id },
      });

      const staleTeamToken = jwt.sign({
        scope: 'ORGANIZATION', id: user.id, email: identity.email, name: user.name,
        role: 'AGENT', organizationId: orgA.organizationId, tokenVersion: 0,
        primaryTeamId: team.id, teamIds: [team.id],
      }, jwtSecret, { expiresIn: '10m' });
      const agentSocket = await connectSocket(baseUrl, staleTeamToken);
      sockets.push(agentSocket);

      const removed = await fetch(`${baseUrl}/api/system/teams/${team.id}/members`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: [] }),
      });
      assert.equal(removed.status, 200);
      await sleep(100);
      assert.equal(agentSocket.connected, true, 'membership refresh disconnected the active client');

      const rejection = new Promise((resolve) => agentSocket.once('error', resolve));
      agentSocket.emit('join_conversation', orgA.records[0].conversation.id);
      const error = await Promise.race([rejection, sleep(1000).then(() => null)]);
      assert.ok(error, 'a removed member retained conversation room access from a stale JWT');

      agentSocket.disconnect();
      await raw.conversation.update({
        where: { id: orgA.records[0].conversation.id },
        data: { teamId: null },
      });
      await raw.user.delete({ where: { id: user.id } });
      await raw.identity.delete({ where: { id: identity.id } });
      await raw.team.delete({ where: { id: team.id } });
    });

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
      const workerIdentity = await raw.identity.create({
        data: { email: 'branding-worker@rabitech.test', passwordHash: 'not-used' },
      });
      const worker = await raw.user.create({
        data: {
          organizationId: orgA.organizationId,
          identityId: workerIdentity.id,
          name: 'Branding Worker',
          role: 'AGENT',
        },
      });
      const workerToken = jwt.sign({
        scope: 'ORGANIZATION',
        id: worker.id,
        email: workerIdentity.email,
        name: worker.name,
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
      await raw.user.delete({ where: { id: worker.id } });
      await raw.identity.delete({ where: { id: workerIdentity.id } });
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
        /*
          A limit of zero is refused as a capability the edition does not
          include, not as an exhausted quota. This assertion used to require
          USAGE_QUOTA_EXCEEDED and a message telling the caller to wait — which
          is false at zero from any layer, because the reset grants zero again.

          Stricter than it was: it now also asserts the message makes no promise
          about a reset, which is the part that was actually misleading.
        */
        await assert.rejects(
          () => prepareOutboundSend(orgA.records[0].contact.phone),
          (error) => error.code === 'PLAN_UPGRADE_REQUIRED'
            && error.status === 402
            && error.metric === 'messages_outbound'
            && !/resets|1st|wait until/i.test(error.message),
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

    await check('lifecycle: rename, default selection, deletion, and reassignment are atomic and tenant-scoped', async () => {
      const headersA = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const headersB = { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' };
      const createStage = async (headers, name) => {
        const response = await fetch(`${baseUrl}/api/lifecycle-stages`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ name, kind: 'ACTIVE', color: '#2563EB' }),
        });
        assert.equal(response.status, 201);
        return response.json();
      };

      const sourceA = await createStage(headersA, 'HTTP Source A');
      const replacementA = await createStage(headersA, 'HTTP Replacement A');
      await createStage(headersB, 'HTTP Source A');
      await raw.contact.update({
        where: { id: orgA.records[0].contact.id },
        data: { lifecycleStage: 'HTTP Source A' },
      });
      await raw.contact.update({
        where: { id: orgB.records[0].contact.id },
        data: { lifecycleStage: 'HTTP Source A' },
      });

      const crossTenant = await fetch(`${baseUrl}/api/lifecycle-stages/${sourceA.id}`, {
        method: 'PATCH',
        headers: headersB,
        body: JSON.stringify({ description: 'must not be visible' }),
      });
      assert.equal(crossTenant.status, 404);

      const renamed = await fetch(`${baseUrl}/api/lifecycle-stages/${sourceA.id}`, {
        method: 'PATCH',
        headers: headersA,
        body: JSON.stringify({ name: 'HTTP Renamed A' }),
      });
      assert.equal(renamed.status, 200);
      assert.equal((await raw.contact.findUnique({ where: { id: orgA.records[0].contact.id } })).lifecycleStage, 'HTTP Renamed A');
      assert.equal((await raw.contact.findUnique({ where: { id: orgB.records[0].contact.id } })).lifecycleStage, 'HTTP Source A');

      const firstDefault = await fetch(`${baseUrl}/api/lifecycle-stages/${sourceA.id}`, {
        method: 'PATCH', headers: headersA, body: JSON.stringify({ isDefault: true }),
      });
      assert.equal(firstDefault.status, 200);
      const nextDefault = await fetch(`${baseUrl}/api/lifecycle-stages/${replacementA.id}`, {
        method: 'PATCH', headers: headersA, body: JSON.stringify({ isDefault: true }),
      });
      assert.equal(nextDefault.status, 200);
      const defaultsA = await raw.lifecycleStage.findMany({
        where: { organizationId: orgA.organizationId, isDefault: true },
        select: { id: true },
      });
      assert.deepEqual(defaultsA, [{ id: replacementA.id }]);

      const deleted = await fetch(`${baseUrl}/api/lifecycle-stages/${sourceA.id}`, {
        method: 'DELETE',
        headers: headersA,
        body: JSON.stringify({ reassignToStageId: replacementA.id }),
      });
      assert.equal(deleted.status, 200);
      assert.equal((await raw.contact.findUnique({ where: { id: orgA.records[0].contact.id } })).lifecycleStage, 'HTTP Replacement A');
      assert.equal((await raw.contact.findUnique({ where: { id: orgB.records[0].contact.id } })).lifecycleStage, 'HTTP Source A');
    });

    // ----------------------------------------------------------------
    // Conversation Operations (migration 64).
    //
    // These run against the disposable schema, which has all 64
    // migrations applied. That makes this the last cheap place to find
    // a defect in migration 64 - before it reaches live data.
    // ----------------------------------------------------------------
    let convOpsSeq = 0;
    const lifecycle = () => require('../src/modules/conversations/conversation-lifecycle.service');
    const autoCloseWorker = () => require('../src/workers/auto-close.worker');

    // Dedicated fixtures: these checks must never depend on rows an
    // earlier check already mutated.
    const newConversation = async (org, suffix, data = {}) => {
      convOpsSeq += 1;
      return raw.conversation.create({
        data: {
          id: `bleed_convops_${suffix}`,
          organizationId: org.organizationId,
          displayId: 9000 + convOpsSeq,
          contactId: org.records[0].contact.id,
          sessionId: org.sessionId,
          status: 'OPEN',
          ...data,
        },
      });
    };
    const newCategory = (org, suffix, name) =>
      raw.conversationCategory.create({
        data: { id: `bleed_cat_${suffix}`, organizationId: org.organizationId, name },
      });
    const closuresFor = (conversationId) =>
      raw.conversationClosure.findMany({ where: { conversationId }, orderBy: { closedAt: 'asc' } });
    const setPolicy = (org, data) =>
      raw.organizationConfig.update({ where: { organizationId: org.organizationId }, data });

    await check('conversations: category management is enforced by the stored role, not the token claim', async () => {
      const mkUser = async (suffix, role) => {
        await raw.identity.create({
          data: { id: `bleed_ident_${suffix}`, email: `bleed-${suffix}@rabitech.test`, passwordHash: 'not-used' },
        });
        const user = await raw.user.create({
          data: {
            id: `bleed_actor_${suffix}`,
            organizationId: orgA.organizationId,
            identityId: `bleed_ident_${suffix}`,
            name: `Actor ${suffix}`,
            role,
          },
        });
        return user.id;
      };
      const mkToken = (userId, roleClaim) => jwt.sign({
        scope: 'ORGANIZATION',
        id: userId,
        email: 'bleed-actor@rabitech.test',
        name: 'Actor',
        role: roleClaim,
        organizationId: orgA.organizationId,
        tokenVersion: 0,
      }, jwtSecret, { expiresIn: '10m' });

      const agentId = await mkUser('agent', 'AGENT');
      const viewerId = await mkUser('viewer', 'VIEWER');

      const createCategory = (tok, name) => fetch(`${baseUrl}/api/conversation-settings/categories`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(5000),
      });

      const asAdmin = await createCategory(token, 'Role Gate Allowed');
      assert.ok(asAdmin.status < 400, `admin must be allowed, got ${asAdmin.status}`);

      assert.equal((await createCategory(mkToken(agentId, 'AGENT'), 'Agent Denied')).status, 403);
      assert.equal((await createCategory(mkToken(viewerId, 'VIEWER'), 'Viewer Denied')).status, 403);

      // A forged claim must not buy authority. The role is read from the
      // user row, so escalating it in the token changes nothing.
      assert.equal((await createCategory(mkToken(agentId, 'ADMIN'), 'Forged Claim')).status, 403);
    });

    await check('conversations: another organization category is not found, never forbidden', async () => {
      const { closeConversation } = lifecycle();
      const categoryB = await newCategory(orgB, 'xorg_b', 'Org B Only');
      const conversation = await newConversation(orgA, 'xorg');

      const error = await runAsOrganization(orgA.organizationId, () =>
        closeConversation({
          conversationId: conversation.id,
          source: 'MANUAL',
          categoryId: categoryB.id,
        }).then(() => null, (err) => err));

      assert.ok(error, 'closing with another org category must fail');
      assert.equal(error.code, 'CLOSING_CATEGORY_NOT_FOUND');
      // 403 would confirm the row exists. Absence and denial must be
      // indistinguishable across a tenant boundary.
      assert.equal(error.status, 404);
      assert.equal((await closuresFor(conversation.id)).length, 0);
    });

    await check('conversations: closing policy cannot be bypassed by calling the service directly', async () => {
      const { closeConversation } = lifecycle();
      await setPolicy(orgA, {
        manualClosingNotesEnabled: true,
        manualClosingNoteMode: 'CATEGORY_AND_SUMMARY_REQUIRED',
      });
      const category = await newCategory(orgA, 'policy_a', 'Policy Category');

      const noCategory = await newConversation(orgA, 'policy_nocat');
      const missingCategory = await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: noCategory.id, source: 'MANUAL' })
          .then(() => null, (err) => err));
      assert.equal(missingCategory && missingCategory.code, 'CLOSING_CATEGORY_REQUIRED');

      const noSummary = await newConversation(orgA, 'policy_nosum');
      const missingSummary = await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: noSummary.id, source: 'MANUAL', categoryId: category.id })
          .then(() => null, (err) => err));
      assert.equal(missingSummary && missingSummary.code, 'CLOSING_SUMMARY_REQUIRED');

      // Neither rejection may leave a partial episode behind.
      assert.equal((await closuresFor(noCategory.id)).length, 0);
      assert.equal((await closuresFor(noSummary.id)).length, 0);
      assert.equal((await raw.conversation.findUnique({ where: { id: noCategory.id } })).status, 'OPEN');

      await setPolicy(orgA, { manualClosingNotesEnabled: false, manualClosingNoteMode: 'OPTIONAL' });
    });

    await check('conversations: a closure keeps its category name after the category is deleted', async () => {
      const { closeConversation } = lifecycle();
      const category = await newCategory(orgA, 'doomed', 'Doomed Category');
      const conversation = await newConversation(orgA, 'survives');

      await runAsOrganization(orgA.organizationId, () =>
        closeConversation({
          conversationId: conversation.id,
          source: 'MANUAL',
          categoryId: category.id,
          summary: 'kept',
        }));

      await raw.conversationCategory.delete({ where: { id: category.id } });

      const [closure] = await closuresFor(conversation.id);
      assert.ok(closure, 'closure must survive its category');
      // categoryId carries no foreign key on purpose; categoryName is the
      // snapshot that makes historic reporting stable.
      assert.equal(closure.categoryName, 'Doomed Category');
      assert.equal(closure.summary, 'kept');
    });

    await check('conversations: closing twice is idempotent and appends one episode', async () => {
      const { closeConversation } = lifecycle();
      const conversation = await newConversation(orgA, 'idempotent');

      const first = await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'first' }));
      const second = await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'second' }));

      assert.equal(first.changed, true);
      assert.equal(second.changed, false, 'a second close must not change state');

      const closures = await closuresFor(conversation.id);
      assert.equal(closures.length, 1, 'duplicate close must not append a second episode');
      assert.equal(closures[0].summary, 'first');
    });

    await check('conversations: reopening starts a new episode and preserves the earlier one', async () => {
      const { closeConversation, reopenConversation } = lifecycle();
      const conversation = await newConversation(orgA, 'episodes');

      await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'episode one' }));
      const [firstBefore] = await closuresFor(conversation.id);

      await runAsOrganization(orgA.organizationId, () => reopenConversation(conversation.id));
      assert.equal((await raw.conversation.findUnique({ where: { id: conversation.id } })).status, 'OPEN');

      await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'episode two' }));

      const closures = await closuresFor(conversation.id);
      assert.equal(closures.length, 2, 'reopen then close must append a second episode');
      assert.equal(closures[0].summary, 'episode one');
      assert.equal(closures[1].summary, 'episode two');
      // History is immutable: the first episode must be unchanged.
      assert.deepEqual(closures[0], firstBefore);
    });

    await check('conversations: a manual close leaves the assignment alone', async () => {
      const { closeConversation } = lifecycle();
      const conversation = await newConversation(orgA, 'assigned', { assignedToId: orgA.userId });

      await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'still assigned' }));

      const after = await raw.conversation.findUnique({ where: { id: conversation.id } });
      assert.equal(after.status, 'RESOLVED');
      assert.equal(after.assignedToId, orgA.userId, 'closing must not unassign');
    });

    await check('conversations: auto-close fires only for a current, due deadline', async () => {
      const { processAutoCloseJob, recoverConversationAutoCloseJobs } = autoCloseWorker();
      const { cancelConversationAutoClose } = lifecycle();
      await setPolicy(orgA, { autoCloseEnabled: true });

      const past = new Date(Date.now() - 60000);
      const future = new Date(Date.now() + 3600000);

      // Stale: the deadline moved on, so an older job is a no-op.
      const stale = await newConversation(orgA, 'ac_stale', { autoCloseEligible: true, autoCloseAt: past });
      assert.equal(
        await processAutoCloseJob({
          organizationId: orgA.organizationId,
          conversationId: stale.id,
          expectedAt: new Date(past.getTime() - 30000).toISOString(),
        }),
        false,
        'a superseded deadline must not close anything',
      );
      assert.equal((await raw.conversation.findUnique({ where: { id: stale.id } })).status, 'OPEN');

      // Not yet due.
      const early = await newConversation(orgA, 'ac_early', { autoCloseEligible: true, autoCloseAt: future });
      assert.equal(
        await processAutoCloseJob({
          organizationId: orgA.organizationId,
          conversationId: early.id,
          expectedAt: future.toISOString(),
        }),
        false,
        'a future deadline must not close early',
      );

      // Due and current: closes, and records the source.
      const due = await newConversation(orgA, 'ac_due', { autoCloseEligible: true, autoCloseAt: past });
      assert.equal(
        await processAutoCloseJob({
          organizationId: orgA.organizationId,
          conversationId: due.id,
          expectedAt: past.toISOString(),
        }),
        true,
      );
      const [dueClosure] = await closuresFor(due.id);
      assert.equal(dueClosure.source, 'AUTO_CLOSE');

      // A customer reply cancels the timer.
      const replied = await newConversation(orgA, 'ac_cancel', { autoCloseEligible: true, autoCloseAt: past });
      await runAsOrganization(orgA.organizationId, () => cancelConversationAutoClose(replied.id));
      assert.equal((await raw.conversation.findUnique({ where: { id: replied.id } })).autoCloseAt, null);
      assert.equal(
        await processAutoCloseJob({
          organizationId: orgA.organizationId,
          conversationId: replied.id,
          expectedAt: past.toISOString(),
        }),
        false,
        'a cancelled timer must not fire',
      );

      // Startup recovery re-arms every persisted deadline it can see.
      const recovered = await recoverConversationAutoCloseJobs();
      assert.ok(recovered >= 1, 'startup recovery must find persisted deadlines');

      await setPolicy(orgA, { autoCloseEnabled: false });
    });

    await check('conversations: only a human customer-facing send arms the auto-close timer', async () => {
      const { markSuccessfulHumanOutbound } = lifecycle();

      await setPolicy(orgA, { autoCloseEnabled: false });
      const disabled = await newConversation(orgA, 'sched_off', { autoCloseEligible: true });
      assert.equal(
        await runAsOrganization(orgA.organizationId, () => markSuccessfulHumanOutbound(disabled.id)),
        null,
        'no timer may be armed while auto-close is off',
      );
      assert.equal((await raw.conversation.findUnique({ where: { id: disabled.id } })).autoCloseAt, null);

      await setPolicy(orgA, { autoCloseEnabled: true, autoCloseDurationMinutes: 60 });
      const armed = await newConversation(orgA, 'sched_on', { autoCloseEligible: true });
      const deadline = await runAsOrganization(orgA.organizationId, () =>
        markSuccessfulHumanOutbound(armed.id));
      assert.ok(deadline instanceof Date, 'a human send must arm the timer');

      const row = await raw.conversation.findUnique({ where: { id: armed.id } });
      assert.ok(row.lastHumanOutboundAt, 'the send must be recorded');
      assert.ok(row.autoCloseAt, 'the deadline must persist');

      await setPolicy(orgA, { autoCloseEnabled: false });
    });

    await check('conversations: closures and categories never cross an organization boundary', async () => {
      const { closeConversation } = lifecycle();
      const conversation = await newConversation(orgA, 'isolation');
      await runAsOrganization(orgA.organizationId, () =>
        closeConversation({ conversationId: conversation.id, source: 'MANUAL', summary: 'org a only' }));

      const seenByB = await runAsOrganization(orgB.organizationId, () =>
        scoped.conversationClosure.findMany({ select: { organizationId: true, summary: true } }));
      assert.ok(
        seenByB.every((row) => row.organizationId === orgB.organizationId),
        'org b must see only its own closures',
      );
      assert.ok(
        !seenByB.some((row) => row.summary === 'org a only'),
        'an org a closure must be invisible to org b',
      );

      const categoriesForB = await runAsOrganization(orgB.organizationId, () =>
        scoped.conversationCategory.findMany({ select: { organizationId: true } }));
      assert.ok(
        categoriesForB.every((row) => row.organizationId === orgB.organizationId),
        'org b must see only its own categories',
      );

      // The database, not the application, is the boundary: a closure
      // pointing at another organization conversation must be rejected.
      await assert.rejects(() =>
        raw.conversationClosure.create({
          data: {
            organizationId: orgB.organizationId,
            conversationId: conversation.id,
            source: 'MANUAL',
            openedAt: new Date(),
          },
        }));
    });


    await check('conversations: closure reporting reconciles exactly with the stored closures', async () => {
      const { closureReport } = require('../src/modules/analytics/reporting.service');

      // A deliberately awkward spread. Uncategorised closures and absent
      // summaries are the cases a naive report drops, and dropping them is
      // exactly how a breakdown stops summing to its own total.
      const windowStart = new Date('2026-07-01T00:00:00.000Z');
      const windowEnd = new Date('2026-08-01T00:00:00.000Z');
      const at = (day) => new Date(`2026-07-${String(day).padStart(2, '0')}T12:00:00.000Z`);

      const host = await newConversation(orgA, 'recon_host');
      const seed = (suffix, categoryName, summary, source, day) =>
        raw.conversationClosure.create({
          data: {
            id: `bleed_recon_${suffix}`,
            organizationId: orgA.organizationId,
            conversationId: host.id,
            categoryId: null,
            categoryName,
            summary,
            source,
            openedAt: at(day),
            closedAt: at(day),
          },
        });

      await seed('a1', 'Resolved', 'answered', 'MANUAL', 2);
      await seed('a2', 'Resolved', null, 'MANUAL', 3);
      await seed('a3', 'Duplicate', 'dupe of 12', 'MANUAL', 4);
      await seed('a4', null, null, 'AUTO_CLOSE', 5);
      await seed('a5', null, 'closed by timer', 'AUTO_CLOSE', 6);
      await seed('a6', 'Deleted Category', 'name survived', 'WORKFLOW', 7);

      // Another organization closing in the same window must not appear.
      const hostB = await newConversation(orgB, 'recon_host_b');
      await raw.conversationClosure.create({
        data: {
          id: 'bleed_recon_b1',
          organizationId: orgB.organizationId,
          conversationId: hostB.id,
          categoryName: 'Org B Category',
          summary: 'org b summary',
          source: 'MANUAL',
          openedAt: at(8),
          closedAt: at(8),
        },
      });

      // Outside the window: proves the period is applied at the source rather
      // than by trimming results afterwards.
      await raw.conversationClosure.create({
        data: {
          id: 'bleed_recon_outside',
          organizationId: orgA.organizationId,
          conversationId: host.id,
          categoryName: 'Resolved',
          summary: 'too early',
          source: 'MANUAL',
          openedAt: new Date('2026-06-01T12:00:00.000Z'),
          closedAt: new Date('2026-06-01T12:00:00.000Z'),
        },
      });

      const report = await runAsOrganization(orgA.organizationId, () =>
        closureReport({ from: windowStart, to: windowEnd }));

      const storedTotal = await raw.conversationClosure.count({
        where: {
          organizationId: orgA.organizationId,
          closedAt: { gte: windowStart, lt: windowEnd },
        },
      });

      const sum = (rows) => rows.reduce((running, row) => running + row.count, 0);

      // Reconciliation stated as equalities, not as spot checks. Each of these
      // is the whole property, not a sample of it.
      assert.equal(report.total, storedTotal, 'report total must equal the stored row count');
      assert.equal(sum(report.byCategory), report.total, 'category counts must sum to total');
      assert.equal(sum(report.bySource), report.total, 'source counts must sum to total');
      assert.equal(
        report.summaries.withSummary + report.summaries.withoutSummary,
        report.total,
        'summary coverage must sum to total',
      );

      // The uncategorised bucket is reported, not hidden. Without it the
      // category sum above would silently fall short.
      const uncategorised = report.byCategory.find((row) => row.key === null);
      assert.ok(uncategorised, 'uncategorised closures must appear as their own bucket');
      assert.equal(uncategorised.count, 2);

      // A category name outlives its category row, so historic reports stay put.
      assert.ok(
        report.byCategory.some((row) => row.key === 'Deleted Category'),
        'a snapshot name must still group after the category is gone',
      );

      // Isolation: org B closed inside the same window and must be absent.
      assert.ok(
        !report.byCategory.some((row) => row.key === 'Org B Category'),
        'another organization closure must not enter this report',
      );
      assert.equal(report.total, 6, 'exactly the six org A closures inside the window');

      // The same reconciliation must hold for org B, from its own side.
      const reportB = await runAsOrganization(orgB.organizationId, () =>
        closureReport({ from: windowStart, to: windowEnd }));
      assert.equal(reportB.total, 1);
      assert.equal(sum(reportB.byCategory), reportB.total);
      assert.equal(sum(reportB.bySource), reportB.total);
    });

    await check('billing: the seeded edition catalogue matches PLAN_ENTITLEMENTS field for field', async () => {
      const { PLAN_ENTITLEMENTS } = require('../src/modules/billing/plans');

      // Plan is platform-owned global config, so it is read through the
      // un-extended client: there is no organization to scope it to.
      const rows = await raw.plan.findMany();
      const byCode = Object.fromEntries(rows.map((row) => [row.code, row]));

      // Every field the constant carries. Listed explicitly rather than derived
      // from Object.keys so that adding a column to one side and forgetting the
      // other fails here instead of passing quietly.
      const fields = [
        'name',
        'monthlyPriceCents',
        'pricingModel',
        'monthlyActiveContactsLimit',
        'monthlyOutboundMessagesLimit',
        'monthlyCampaignSendsLimit',
        'customFieldsLimit',
        'usersLimit',
        'workflowsLimit',
        'campaignRateMax',
        'campaignRateDurationMs',
        'autoProvisionGateway',
        'customDomain',
        'whiteLabel',
        'maskContactDetails',
      ];

      for (const [code, expected] of Object.entries(PLAN_ENTITLEMENTS)) {
        const row = byCode[code];
        assert.ok(row, `edition ${code} is missing from the catalogue`);
        for (const field of fields) {
          assert.deepEqual(
            row[field],
            expected[field],
            `${code}.${field}: database has ${JSON.stringify(row[field])}, constant has ${JSON.stringify(expected[field])}`,
          );
        }
        // Not in the constant - the settled default, carried unenforced.
        assert.deepEqual(row.allowedChannels, ['OPENWA'], `${code}.allowedChannels`);
      }

      // A row the constant does not know about would resolve to nothing at the
      // enforcement sites, so the catalogue must not grow behind the code.
      assert.equal(
        rows.length,
        Object.keys(PLAN_ENTITLEMENTS).length,
        'the catalogue has editions the constant does not define',
      );

      // Enterprise promises unlimited. Null is that promise; the billion-row
      // sentinel belongs to OrganizationConfig, whose columns are NOT NULL, and
      // must never leak into the catalogue where it reads as a bizarre quota.
      const enterprise = byCode.ENTERPRISE;
      assert.equal(enterprise.monthlyActiveContactsLimit, null);
      assert.equal(enterprise.monthlyOutboundMessagesLimit, null);
      assert.equal(enterprise.usersLimit, null);
    });

    await check('billing: feature grants are enforced from the catalogue, not a parallel constant', async () => {
      const { refreshEditions, getEdition, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');
      const { canCustomizeFooter, assertFooterEntitlement } = require('../src/modules/branding/branding.service');

      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      // Baseline: the seeded catalogue says GROWTH grants neither.
      assert.equal(getEdition('GROWTH').whiteLabel, false);
      assert.equal(getEdition('GROWTH').customDomain, false);
      assert.equal(canCustomizeFooter('GROWTH'), false, 'GROWTH must not customise the footer');
      assert.throws(() => assertFooterEntitlement('GROWTH', { customFooter: 'x' }));
      assert.throws(() => assertFooterEntitlement('GROWTH', { customDomain: 'x.example' }));

      // Grant both on the edition. If branding still consulted its own tier
      // Sets this would change nothing, which is exactly the defect being
      // retired: a toggle that writes a field no enforcement path reads.
      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { whiteLabel: true, customDomain: true },
      });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      assert.equal(canCustomizeFooter('GROWTH'), true, 'the catalogue must be what branding reads');
      assert.doesNotThrow(() => assertFooterEntitlement('GROWTH', { customFooter: 'Mine' }));
      assert.doesNotThrow(() => assertFooterEntitlement('GROWTH', { customDomain: 'x.example' }));

      // maskContactDetails resolves from the same catalogue.
      await raw.plan.update({ where: { code: 'GROWTH' }, data: { maskContactDetails: true } });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
      assert.equal(getEdition('GROWTH').maskContactDetails, true);

      // autoProvisionGateway is stored but deliberately NOT enforced. Asserting
      // that keeps the claim honest: if someone later wires it, this fails and
      // the schema comment and console copy have to be corrected with it.
      const provisioningReads = fs
        .readFileSync(path.join(ROOT, 'src/modules/billing/billing.service.ts'), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('autoProvisionGateway'));
      assert.ok(
        provisioningReads.every((line) => line.includes('entitlements.autoProvisionGateway')),
        'autoProvisionGateway may only be reported, never used to permit or refuse',
      );

      // Restore the seeded values so later checks see the catalogue as shipped.
      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { whiteLabel: false, customDomain: false, maskContactDetails: false },
      });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
    });

    await check('billing: editing an edition is a new baseline, not drift', async () => {
      const { refreshEditions, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');
      const { getBillingSummary } = require('../src/modules/billing/billing.service');

      // Put org A on GROWTH with config matching the catalogue exactly, and
      // stamp the config in the past so an edition edit lands after it.
      const growth = await raw.plan.findUnique({ where: { code: 'GROWTH' } });
      await raw.organization.update({
        where: { id: orgA.organizationId },
        data: { tier: 'GROWTH' },
      });
      await raw.organizationConfig.update({
        where: { organizationId: orgA.organizationId },
        data: {
          monthlyActiveContactsLimit: growth.monthlyActiveContactsLimit,
          monthlyOutboundMessagesLimit: growth.monthlyOutboundMessagesLimit,
          monthlyCampaignSendsLimit: growth.monthlyCampaignSendsLimit,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      const before = await runAsOrganization(orgA.organizationId, () => getBillingSummary(orgA.organizationId));
      assert.deepEqual(before.quotaDrift, [], 'config matching the catalogue is never drift');

      // The owner raises the allowance. Every organization on GROWTH now has a
      // config that no longer matches the edition - by design, not by tampering.
      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { monthlyActiveContactsLimit: growth.monthlyActiveContactsLimit + 500 },
      });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      const after = await runAsOrganization(orgA.organizationId, () => getBillingSummary(orgA.organizationId));
      assert.deepEqual(
        after.quotaDrift,
        [],
        'an edition edit is a new baseline; a detector that fires on every org is one nobody reads',
      );

      // The detector must still work. Tamper with config *after* the edit, and
      // the divergence is no longer explained by the edition.
      await raw.organizationConfig.update({
        where: { organizationId: orgA.organizationId },
        data: { monthlyActiveContactsLimit: 7, updatedAt: new Date() },
      });
      const tampered = await runAsOrganization(orgA.organizationId, () => getBillingSummary(orgA.organizationId));
      assert.ok(
        tampered.quotaDrift.some((row) => row.metric === 'active_contacts'),
        'out-of-band config changes must still be reported',
      );

      // Restore.
      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { monthlyActiveContactsLimit: growth.monthlyActiveContactsLimit },
      });
      await raw.organization.update({ where: { id: orgA.organizationId }, data: { tier: 'FREE' } });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
    });

    // resolveEntitlements reads override, then subscription, then tier. Earlier
    // billing checks leave live subscriptions on these fixtures, so setting tier
    // alone is silently ignored - correct behaviour, and caught here by a check
    // that asserted against it. These four checks are about the catalogue, not
    // about subscription precedence, so they clear the subscription and let tier
    // govern.
    const setTierGoverned = async (org, tier) => {
      await raw.subscription.deleteMany({ where: { organizationId: org.organizationId } });
      await raw.organization.update({ where: { id: org.organizationId }, data: { tier } });
    };

    await check('billing: Standard resolves end-to-end as messaging only', async () => {
      const { refreshEditions, getEdition, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');
      const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      const standard = getEdition('STANDARD');
      assert.ok(standard, 'STANDARD must resolve');
      assert.equal(standard.code, 'STANDARD');

      // Messaging is the scope, so the two messaging allowances are real.
      assert.ok((standard.monthlyActiveContactsLimit ?? 0) > 0, 'Standard must allow contacts');
      assert.ok((standard.monthlyOutboundMessagesLimit ?? 0) > 0, 'Standard must allow outbound');

      // Everything past inbound and outbound is closed. Zero, not "a few":
      // a tier granting three workflows invites an argument about why not four.
      assert.equal(standard.monthlyCampaignSendsLimit, 0, 'broadcasting is not messaging');
      assert.equal(standard.customFieldsLimit, 0);
      assert.equal(standard.workflowsLimit, 0);
      assert.equal(standard.whiteLabel, false);
      assert.equal(standard.customDomain, false);
      assert.equal(standard.maskContactDetails, false);
      assert.equal(standard.autoProvisionGateway, false);

      // And it resolves for a real organization, not just in the catalogue.
      await setTierGoverned(orgB, 'STANDARD');
      const effective = await runAsPlatform('bleed-resolve-entitlements', () => resolveEntitlements(orgB.organizationId));
      assert.equal(effective.plan, 'STANDARD');
      assert.equal(effective.planName, 'Standard');
      assert.equal(effective.seatLimit, standard.usersLimit);

      await setTierGoverned(orgB, 'FREE');
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
    });

    await check('billing: the catalogue is platform-owned and cannot be reached by a tenant actor', async () => {
      // Plan is in PLATFORM_MODELS, so the extension does not inject an
      // organizationId. Read under a tenant scope it returns the global
      // catalogue rather than an empty set - the correct behaviour for shared
      // config, and the reason the HTTP layer is what must refuse a tenant.
      const underTenant = await runAsOrganization(orgA.organizationId, () =>
        scoped.plan.findMany({ select: { code: true } }));
      assert.ok(underTenant.length >= 5, 'the catalogue is global, not tenant-filtered');

      // The boundary that matters is the endpoint. An organization token, even
      // an ADMIN one, is not a platform actor.
      const asTenant = await fetch(`${baseUrl}/api/platform/editions`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      assert.ok([401, 403].includes(asTenant.status), `tenant read must be refused, got ${asTenant.status}`);

      const writeAsTenant = await fetch(`${baseUrl}/api/platform/editions/GROWTH`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyPriceCents: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      assert.ok([401, 403].includes(writeAsTenant.status), `tenant write must be refused, got ${writeAsTenant.status}`);

      // The price must be untouched by the refused write.
      const growth = await raw.plan.findUnique({ where: { code: 'GROWTH' } });
      assert.equal(growth.monthlyPriceCents, 4900, 'a refused write must change nothing');
    });

    await check('billing: editing one edition does not move another tenant', async () => {
      const { refreshEditions, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');
      const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');

      await setTierGoverned(orgA, 'GROWTH');
      await setTierGoverned(orgB, 'BUSINESS');
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      const beforeB = await runAsPlatform('bleed-resolve-entitlements', () => resolveEntitlements(orgB.organizationId));

      // Move GROWTH substantially. Org B is on BUSINESS and must not notice.
      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { monthlyPriceCents: 9900, monthlyActiveContactsLimit: 99999, whiteLabel: true },
      });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      const afterB = await runAsPlatform('bleed-resolve-entitlements', () => resolveEntitlements(orgB.organizationId));
      assert.equal(afterB.plan, beforeB.plan);
      assert.equal(afterB.listPriceCents, beforeB.listPriceCents, 'another edition price must not leak');
      assert.equal(afterB.seatLimit, beforeB.seatLimit);
      assert.deepEqual(afterB.limits, beforeB.limits, 'another edition limits must not leak');

      // And org A, which is on GROWTH, does see it.
      const afterA = await runAsPlatform('bleed-resolve-entitlements', () => resolveEntitlements(orgA.organizationId));
      assert.equal(afterA.listPriceCents, 9900, 'the edited edition must apply to its own tenants');

      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { monthlyPriceCents: 4900, monthlyActiveContactsLimit: 2500, whiteLabel: false },
      });
      await setTierGoverned(orgA, 'FREE');
      await setTierGoverned(orgB, 'FREE');
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
    });

    await check('billing: deactivating an edition retires it without orphaning its subscribers', async () => {
      const { refreshEditions, getEdition, getEditions, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');
      const { resolveEntitlements } = require('../src/modules/billing/entitlements.resolver');

      await setTierGoverned(orgA, 'GROWTH');
      // A distinguishable value, so a silent fall back to the shipped constant
      // is visible rather than looking like a correct answer.
      await raw.plan.update({ where: { code: 'GROWTH' }, data: { monthlyActiveContactsLimit: 4242 } });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
      assert.equal(getEdition('GROWTH').monthlyActiveContactsLimit, 4242);

      await raw.plan.update({ where: { code: 'GROWTH' }, data: { isActive: false } });
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());

      // Retired from the price list...
      assert.ok(
        !getEditions().some((edition) => edition.code === 'GROWTH'),
        'a deactivated edition must leave the published catalogue',
      );

      // ...but still resolving, with its edited value intact. Falling back to
      // the constant here would silently change what a paying subscriber is
      // entitled to as a side effect of a pricing-page edit.
      assert.equal(
        getEdition('GROWTH').monthlyActiveContactsLimit,
        4242,
        'a subscriber on a retired edition keeps the edition they are on',
      );
      const stillResolves = await runAsPlatform('bleed-resolve-entitlements', () => resolveEntitlements(orgA.organizationId));
      assert.equal(stillResolves.plan, 'GROWTH');

      await raw.plan.update({
        where: { code: 'GROWTH' },
        data: { isActive: true, monthlyActiveContactsLimit: 2500 },
      });
      await setTierGoverned(orgA, 'FREE');
      await runAsPlatform('bleed-editions-refresh', () => refreshEditions());
    });

    await check('billing: the edition catalogue loads on a timer, with no ambient scope', async () => {
      const { refreshEditions, getEdition, resetEditionCacheForTests } = require('../src/modules/billing/editions.service');

      resetEditionCacheForTests();

      // Called exactly as the background timer calls it: no runAsPlatform, no
      // request, no tenant. This is the shape that was broken for the whole
      // life of the feature - the refresh threw TENANT_ISOLATION_VIOLATION on
      // every tick, its own catch turned that into a log line, and getEdition
      // fell back to the constant forever. The catalogue was owner-editable in
      // the database and inert in the running process, and nothing failed,
      // because the fallback returns plausible values.
      //
      // Every other check wrapped the call in runAsPlatform, which is why they
      // all passed while the product did not work.
      const loaded = await refreshEditions();
      assert.ok(loaded >= 5, `unscoped refresh must load the catalogue, loaded ${loaded}`);

      // And the loaded values must be the database's, not the constant's.
      await raw.plan.update({ where: { code: 'BUSINESS' }, data: { monthlyPriceCents: 20900 } });
      const reloaded = await refreshEditions();
      assert.ok(reloaded >= 5);
      assert.equal(
        getEdition('BUSINESS').monthlyPriceCents,
        20900,
        'an unscoped refresh must read the database, not fall back to the constant',
      );

      await raw.plan.update({ where: { code: 'BUSINESS' }, data: { monthlyPriceCents: 19900 } });
      await refreshEditions();
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

    await check('database: a where-less updateMany cannot reach another tenant', async () => {
      // updateMany and deleteMany take an OPTIONAL where, unlike update and
      // delete. The tenant extension used to inject organizationId only into
      // an existing where, so a call with none ran with no tenant predicate at
      // all - the two operations that touch the most rows were the two that
      // could run unscoped, silently, raising nothing.
      //
      // Live example this is written against: creating a team with
      // isDefault:true ran team.updateMany({ data: { isDefault: false } }) and
      // cleared isDefault on every team in every organization on the platform.
      const teamA = { id: 'bleed_manyops_team_a', organizationId: orgA.organizationId, name: 'Many A', slug: 'many-a', isDefault: true };
      const teamB = { id: 'bleed_manyops_team_b', organizationId: orgB.organizationId, name: 'Many B', slug: 'many-b', isDefault: true };
      await raw.team.create({ data: teamA });
      await raw.team.create({ data: teamB });

      try {
        // Exactly the shape of the shipped bug: no where at all.
        await runAsOrganization(orgA.organizationId, () =>
          scoped.team.updateMany({ data: { isDefault: false } }));

        const afterA = await raw.team.findUnique({ where: { id: teamA.id } });
        const afterB = await raw.team.findUnique({ where: { id: teamB.id } });
        assert.equal(afterA.isDefault, false, "the org A team should have been updated");
        assert.equal(
          afterB.isDefault,
          true,
          'a where-less updateMany in org A reached org B - the tenant predicate was not applied',
        );

        // Same again for the destructive twin, which is the one that cannot be
        // undone if it ever escapes its tenant.
        await runAsOrganization(orgA.organizationId, () => scoped.team.deleteMany({}));
        assert.equal(
          await raw.team.count({ where: { id: teamB.id } }),
          1,
          'a where-less deleteMany in org A destroyed org B rows',
        );
        assert.equal(
          await raw.team.count({ where: { id: teamA.id } }),
          0,
          "org A's own deleteMany should still delete org A rows",
        );
      } finally {
        await raw.team.deleteMany({ where: { id: { in: [teamA.id, teamB.id] } } });
      }
    });
    await check('meta ingest: a status for one tenant cannot touch another tenant message', async () => {
      const { applyMetaStatus } = require('../src/webhooks/meta.webhook');

      // Meta reports on the whole phone number and keys receipts by wamid. Two
      // organizations can hold rows carrying the SAME waMessageId - the unique
      // constraint is per organization, deliberately - so the ack path must be
      // scoped, not keyed on the wamid alone.
      const convA = await raw.conversation.findFirst({
        where: { organizationId: orgA.organizationId }, select: { id: true },
      });
      const convB = await raw.conversation.findFirst({
        where: { organizationId: orgB.organizationId }, select: { id: true },
      });
      await raw.message.create({ data: {
        id: 'bleed_meta_ack_a', organizationId: orgA.organizationId, conversationId: convA.id,
        direction: 'OUTBOUND', body: 'a', waMessageId: 'wamid.shared', status: 'SENT',
      } });
      await raw.message.create({ data: {
        id: 'bleed_meta_ack_b', organizationId: orgB.organizationId, conversationId: convB.id,
        direction: 'OUTBOUND', body: 'b', waMessageId: 'wamid.shared', status: 'SENT',
      } });
      await raw.campaign.create({
        data: {
          id: 'bleed_meta_ack_campaign_a', organizationId: orgA.organizationId,
          title: 'Org A campaign', message: 'a', status: 'SENDING', sessionId: orgA.sessionId,
        },
      });
      await raw.campaign.create({
        data: {
          id: 'bleed_meta_ack_campaign_b', organizationId: orgB.organizationId,
          title: 'Org B campaign', message: 'b', status: 'SENDING', sessionId: orgB.sessionId,
        },
      });
      await raw.campaignRecipient.create({
        data: {
          id: 'bleed_meta_ack_recipient_a', organizationId: orgA.organizationId,
          campaignId: 'bleed_meta_ack_campaign_a', contactId: orgA.records[0].contact.id,
          status: 'sent', waMessageId: 'wamid.campaign-shared', sentAt: new Date(),
        },
      });
      await raw.campaignRecipient.create({
        data: {
          id: 'bleed_meta_ack_recipient_b', organizationId: orgB.organizationId,
          campaignId: 'bleed_meta_ack_campaign_b', contactId: orgB.records[0].contact.id,
          status: 'sent', waMessageId: 'wamid.campaign-shared', sentAt: new Date(),
        },
      });

      try {
        // Applied in org B scope, with org A row created FIRST. A lookup that
        // is not tenant-scoped returns org A deterministically, so this cannot
        // pass by ordering luck - the first version of this check did exactly
        // that and survived a mutation that broke the boundary.
        await runAsOrganization(orgB.organizationId, () =>
          applyMetaStatus(orgB.organizationId, 'wamid.shared', 'READ'));

        const a = await raw.message.findUniqueOrThrow({ where: { id: 'bleed_meta_ack_a' }, select: { status: true } });
        const b = await raw.message.findUniqueOrThrow({ where: { id: 'bleed_meta_ack_b' }, select: { status: true } });
        assert.equal(b.status, 'READ', 'the ack must advance the message in its own organization');
        assert.equal(a.status, 'SENT', 'an ack in org B advanced an identically-keyed message in org A');

        // Campaign sends do not have Message rows. The Meta path must still
        // settle the recipient, while the identical id in org B remains alone.
        await runAsOrganization(orgA.organizationId, () =>
          applyMetaStatus(orgA.organizationId, 'wamid.campaign-shared', 'READ'));
        const recipientA = await raw.campaignRecipient.findUniqueOrThrow({
          where: { id: 'bleed_meta_ack_recipient_a' }, select: { status: true },
        });
        const recipientB = await raw.campaignRecipient.findUniqueOrThrow({
          where: { id: 'bleed_meta_ack_recipient_b' }, select: { status: true },
        });
        assert.equal(recipientA.status, 'read', 'Meta did not advance a campaign-only receipt');
        assert.equal(recipientB.status, 'sent', 'a Meta campaign ack crossed the organization boundary');

        await runAsOrganization(orgA.organizationId, () =>
          applyMetaStatus(orgA.organizationId, 'wamid.campaign-shared', 'DELIVERED'));
        const ordered = await raw.campaignRecipient.findUniqueOrThrow({
          where: { id: 'bleed_meta_ack_recipient_a' }, select: { status: true },
        });
        assert.equal(ordered.status, 'read', 'a late Meta delivered receipt walked a campaign back from read');
      } finally {
        await raw.campaignRecipient.deleteMany({
          where: { id: { in: ['bleed_meta_ack_recipient_a', 'bleed_meta_ack_recipient_b'] } },
        });
        await raw.campaign.deleteMany({
          where: { id: { in: ['bleed_meta_ack_campaign_a', 'bleed_meta_ack_campaign_b'] } },
        });
        await raw.message.deleteMany({ where: { id: { in: ['bleed_meta_ack_a', 'bleed_meta_ack_b'] } } });
      }
    });

    await check('meta ingest: a redelivered message cannot produce a second row', async () => {
      // Meta retries any webhook it did not see acknowledged, so the same
      // message arrives more than once. BullMQ deduplicates on the job id, and
      // the database is the net under it: waMessageId is unique per
      // organization, and NOT globally - two tenants may legitimately hold the
      // same id, which is what the check above depends on.
      const conv = await raw.conversation.findFirst({
        where: { organizationId: orgA.organizationId }, select: { id: true },
      });
      await raw.message.create({ data: {
        id: 'bleed_dedupe_1', organizationId: orgA.organizationId, conversationId: conv.id,
        direction: 'INBOUND', body: 'first', waMessageId: 'wamid.retry',
      } });
      try {
        await assert.rejects(
          () => raw.message.create({ data: {
            id: 'bleed_dedupe_2', organizationId: orgA.organizationId, conversationId: conv.id,
            direction: 'INBOUND', body: 'retry', waMessageId: 'wamid.retry',
          } }),
          /Unique constraint|P2002/,
          'a redelivered Meta message must not create a second row',
        );

        const convB = await raw.conversation.findFirst({
          where: { organizationId: orgB.organizationId }, select: { id: true },
        });
        await raw.message.create({ data: {
          id: 'bleed_dedupe_3', organizationId: orgB.organizationId, conversationId: convB.id,
          direction: 'INBOUND', body: 'other tenant', waMessageId: 'wamid.retry',
        } });
        await raw.message.delete({ where: { id: 'bleed_dedupe_3' } });
      } finally {
        await raw.message.deleteMany({ where: { id: { in: ['bleed_dedupe_1', 'bleed_dedupe_2'] } } });
      }
    });

    await check('meta ingest: an unrenderable message type is kept as a type, never as a sentence', async () => {
      const { normalizeMetaMessages, normalizeMetaStatuses } = require('../src/modules/channels/meta-inbound');

      const wrap = (message) => ({
        contacts: [{ wa_id: '972500000001', profile: { name: 'Maya' } }],
        messages: [message],
      });

      const [text] = normalizeMetaMessages(wrap({
        id: 'wamid.t', from: '972500000001', timestamp: '1756500000', type: 'text',
        text: { body: 'hello' },
      }));
      assert.equal(text.body, 'hello');
      assert.equal(text.placeholder, false);
      assert.equal(text.contactName, 'Maya', 'the profile name must come across from contacts[]');
      assert.equal(text.phone, '972500000001');

      const [image] = normalizeMetaMessages(wrap({
        id: 'wamid.i', from: '+972500000001', timestamp: '1756500000', type: 'image',
        image: { id: 'MEDIA_1', mime_type: 'image/jpeg', caption: 'look' },
      }));
      assert.equal(image.mediaId, 'MEDIA_1');
      assert.equal(image.body, 'look', 'a caption is the customer word and belongs in the body');
      assert.equal(image.phone, '972500000001', 'a leading + must be normalised away');

      const [document] = normalizeMetaMessages(wrap({
        id: 'wamid.d', from: '972500000001', timestamp: '1756500000', type: 'document',
        document: { id: 'MEDIA_2', mime_type: 'application/pdf', filename: 'invoice-2026.pdf' },
      }));
      assert.equal(document.fileName, 'invoice-2026.pdf', 'Meta document.filename must survive normalisation');

      // The rule this check exists for: store the TYPE, never a sentence. A
      // stored "[location]" cannot be translated afterwards, which is the
      // defect behind Respond.io's [Deleted Workflow].
      const [location] = normalizeMetaMessages(wrap({
        id: 'wamid.l', from: '972500000001', timestamp: '1756500000', type: 'location',
        location: { latitude: 31.9, longitude: 35.2 },
      }));
      assert.equal(location.placeholder, true);
      assert.equal(location.metaType, 'location');
      assert.equal(location.body, '', 'a placeholder must carry no prose at all');

      const [exotic] = normalizeMetaMessages(wrap({
        id: 'wamid.x', from: '972500000001', timestamp: '1756500000', type: 'something_new',
      }));
      assert.equal(exotic.placeholder, true);
      assert.equal(exotic.metaType, 'unsupported', 'an unknown type must land on a type we have copy for');

      // Nothing usable is silently dropped: a message with no id or no sender
      // cannot be attributed, and is the one case that is skipped.
      assert.equal(normalizeMetaMessages(wrap({ type: 'text', text: { body: 'x' } })).length, 0);

      // Statuses map onto this product's vocabulary, and an unmapped one is
      // skipped rather than guessed - the ack ladder only moves forward, so a
      // wrong guess is not correctable.
      const statuses = normalizeMetaStatuses({ statuses: [
        { id: 'wamid.a', status: 'delivered' },
        { id: 'wamid.b', status: 'read' },
        { id: 'wamid.c', status: 'invented' },
        { status: 'read' },
      ] });
      assert.deepEqual(statuses, [
        { waMessageId: 'wamid.a', status: 'DELIVERED' },
        { waMessageId: 'wamid.b', status: 'READ' },
      ]);
    });

    await check('messages: a delivery ack can never walk a message backwards', async () => {
      const { advanceMessageStatus } = require('../src/utils/message-status');

      // WhatsApp redelivers acks and does not order them, and Meta retries any
      // webhook it did not see acknowledged. Applied naively, a late 'delivered'
      // overwrites a 'read' and an agent watches a message they know was read
      // revert - with nothing having changed except network timing.
      //
      // CLAUDE.md states this invariant. Until 2026-08-30 it was enforced for
      // campaign recipients and NOT for the Message row sitting beside them, so
      // it held for one of the two things it was written about.
      assert.equal(advanceMessageStatus('DELIVERED', 'READ'), 'READ', 'read must advance past delivered');
      assert.equal(advanceMessageStatus('READ', 'DELIVERED'), null, 'a late delivered must not undo a read');
      assert.equal(advanceMessageStatus('READ', 'SENT'), null, 'a late sent must not undo a read');
      assert.equal(advanceMessageStatus('READ', 'READ'), null, 'a repeated ack writes nothing');

      // FAILED sits between SENT and DELIVERED, which settles the awkward cases
      // without a special branch anywhere.
      assert.equal(advanceMessageStatus('SENT', 'FAILED'), 'FAILED', 'a send that failed must record it');
      assert.equal(advanceMessageStatus('DELIVERED', 'FAILED'), null, 'a delivered message cannot later fail');
      assert.equal(advanceMessageStatus('FAILED', 'DELIVERED'), 'DELIVERED', 'real delivery corrects a wrong failure');
      assert.equal(advanceMessageStatus('FAILED', 'SENT'), null, 'sent is not evidence against a failure');

      // An unknown status is not a reason to overwrite a known one.
      assert.equal(advanceMessageStatus('READ', 'NONSENSE'), null);

      // And the same rule holds against the database, not just in the helper -
      // replaying an out-of-order ack sequence must leave the message READ.
      const conversation = await raw.conversation.findFirst({
        where: { organizationId: orgA.organizationId },
        select: { id: true },
      });
      await raw.message.create({ data: {
        id: 'bleed_ack_message', organizationId: orgA.organizationId,
        conversationId: conversation.id, direction: 'OUTBOUND', body: 'ack ordering',
        waMessageId: 'wamid.bleed_ack', status: 'SENT',
      } });
      try {
        for (const incoming of ['DELIVERED', 'READ', 'DELIVERED', 'SENT', 'FAILED']) {
          const current = await raw.message.findUniqueOrThrow({
            where: { id: 'bleed_ack_message' }, select: { status: true },
          });
          const advanced = advanceMessageStatus(current.status, incoming);
          if (advanced) {
            await raw.message.update({ where: { id: 'bleed_ack_message' }, data: { status: advanced } });
          }
        }
        const final = await raw.message.findUniqueOrThrow({
          where: { id: 'bleed_ack_message' }, select: { status: true },
        });
        assert.equal(final.status, 'READ', 'an out-of-order ack replay must settle on READ');
      } finally {
        await raw.message.deleteMany({
          where: { organizationId: orgA.organizationId, id: 'bleed_ack_message' },
        });
      }
    });

    await check('channels: two ACTIVE channels are refused, never silently picked', async () => {
      const { ChannelService, setActiveChannelKind } = require('../src/modules/channels/channel.service');

      const ids = ['bleed_chan_openwa', 'bleed_chan_meta'];
      await raw.organizationChannel.create({ data: {
        id: ids[0], organizationId: orgA.organizationId, kind: 'OPENWA', status: 'ACTIVE',
        baseUrl: 'http://openwa.invalid', apiKeyEnc: '', webhookToken: 'bleed-switch-openwa',
      } });
      await raw.organizationChannel.create({ data: {
        id: ids[1], organizationId: orgA.organizationId, kind: 'WHATSAPP_CLOUD', status: 'ACTIVE',
        baseUrl: 'https://graph.facebook.com/v21.0', apiKeyEnc: '', webhookToken: 'bleed-switch-meta',
      } });

      try {
        // The old resolver took findFirst({status:'ACTIVE'}) with no ordering,
        // so this exact state resolved to whichever row came back first: the
        // same tenant could send through OpenWA on one request and Meta on the
        // next, with nothing raised and no way to notice except customers
        // replying to a number that was not the one they wrote to.
        await assert.rejects(
          () => runAsOrganization(orgA.organizationId, () =>
            ChannelService.sendText('session', '+972500000001', 'hello')),
          /CHANNEL_AMBIGUOUS/,
          'two ACTIVE channels must raise, not resolve to an arbitrary one',
        );

        // The switch leaves exactly one active, and leaves it in one statement
        // so nothing can observe zero.
        await runAsOrganization(orgA.organizationId, () => setActiveChannelKind('OPENWA'));
        const after = await raw.organizationChannel.findMany({
          where: { organizationId: orgA.organizationId, id: { in: ids } },
          select: { kind: true, status: true },
        });
        assert.equal(
          after.filter((row) => row.status === 'ACTIVE').length,
          1,
          'after a switch exactly one channel must be ACTIVE',
        );
        assert.equal(after.find((row) => row.status === 'ACTIVE').kind, 'OPENWA');

        // A workspace with channels but none active must say so distinctly. The
        // generic OpenWA failure sends an agent to debug a healthy gateway.
        await raw.organizationChannel.updateMany({
          where: { organizationId: orgA.organizationId, id: { in: ids } },
          data: { status: 'INACTIVE' },
        });
        await assert.rejects(
          () => runAsOrganization(orgA.organizationId, () =>
            ChannelService.sendText('session', '+972500000001', 'hello')),
          /CHANNEL_NOT_ACTIVE/,
          'no active channel must be named, not reported as a gateway fault',
        );
      } finally {
        await raw.organizationChannel.deleteMany({
          where: { organizationId: orgA.organizationId, id: { in: ids } },
        });
      }
    });

    await check('channels: the Meta service window is enforced before Meta is called', async () => {
      const { serviceWindowFor, SERVICE_WINDOW_MS } = require('../src/modules/channels/service-window');

      // Its own contact and thread, because the seeded fixtures already carry an
      // INBOUND message - the first version of this check reused one and passed
      // for the wrong reason, reading a window held open by seed data rather
      // than by anything under test.
      const contactId = 'bleed_window_contact';
      const conversationId = 'bleed_window_conversation';
      await raw.contact.create({ data: {
        id: contactId, organizationId: orgA.organizationId,
        phone: '+972599000111', name: 'Service Window',
      } });
      await raw.conversation.create({ data: {
        id: conversationId, organizationId: orgA.organizationId, displayId: 98765,
        contactId, sessionId: orgA.sessionId,
      } });

      try {
        // Never written: no window at all. Distinct from a window that closed,
        // and given a different message because the remedies differ - one waits
        // for the customer, the other cannot be fixed by waiting.
        const never = await runAsOrganization(orgA.organizationId, () => serviceWindowFor(contactId));
        assert.equal(never.open, false);
        assert.equal(never.lastInboundAt, null, 'a contact who never wrote has no last inbound');

        await raw.message.create({ data: {
          id: 'bleed_window_inbound', organizationId: orgA.organizationId,
          conversationId, direction: 'INBOUND', body: 'hello',
          timestamp: new Date(Date.now() - 60_000),
        } });
        const open = await runAsOrganization(orgA.organizationId, () => serviceWindowFor(contactId));
        assert.equal(open.open, true, 'a message a minute old must leave the window open');

        // Age it past 24 hours, then reply. The OUTBOUND message must NOT
        // reopen the window. Conversation.lastMessageAt moves on outbound, which
        // is precisely why the window is computed from inbound only: believing a
        // window is open when Meta considers it shut is the direction of error
        // that spends a number's quality rating on rejected sends.
        await raw.message.update({
          where: { id: 'bleed_window_inbound' },
          data: { timestamp: new Date(Date.now() - SERVICE_WINDOW_MS - 60_000) },
        });
        await raw.message.create({ data: {
          id: 'bleed_window_outbound', organizationId: orgA.organizationId,
          conversationId, direction: 'OUTBOUND', body: 'agent reply',
          timestamp: new Date(),
        } });

        const closed = await runAsOrganization(orgA.organizationId, () => serviceWindowFor(contactId));
        assert.equal(closed.open, false, 'an outbound message must not reopen the service window');
        assert.ok(closed.lastInboundAt, 'a closed window still knows when it closed');
        assert.ok(closed.expiresAt < new Date(), 'a closed window reports an expiry in the past');

        // And the window belongs to the contact, not to whoever asks: org B must
        // not be able to read org A's window into its own send decision.
        const fromOrgB = await runAsOrganization(orgB.organizationId, () => serviceWindowFor(contactId));
        assert.equal(fromOrgB.lastInboundAt, null, 'org B read org A inbound history through the window check');
      } finally {
        await raw.message.deleteMany({ where: { organizationId: orgA.organizationId, conversationId } });
        await raw.conversation.deleteMany({ where: { organizationId: orgA.organizationId, id: conversationId } });
        await raw.contact.deleteMany({ where: { organizationId: orgA.organizationId, id: contactId } });
      }
    });

    await check('meta webhook: a payload naming one tenant cannot enter another tenant scope', async () => {
      const crypto = require('crypto');
      const { getTenantId } = require('../src/lib/tenant-context');
      const {
        dispatchMetaWebhookPayload,
        organizationForPhoneNumberId,
        verifyMetaSignature,
      } = require('../src/webhooks/meta.webhook');

      // Meta posts every customer's messages to ONE url, so the phone number id
      // in the body is the only thing that says whose message this is. This is
      // the single place the system picks an organization from data the outside
      // world supplied, and a wrong pick here delivers one business's customer
      // conversations into another business's inbox.
      const channelA = await raw.organizationChannel.create({ data: {
        id: 'bleed_meta_channel_a', organizationId: orgA.organizationId, kind: 'WHATSAPP_CLOUD',
        status: 'ACTIVE', baseUrl: 'https://graph.facebook.com/v21.0', apiKeyEnc: '',
        webhookToken: 'bleed-meta-token-a',
      } });
      const channelB = await raw.organizationChannel.create({ data: {
        id: 'bleed_meta_channel_b', organizationId: orgB.organizationId, kind: 'WHATSAPP_CLOUD',
        status: 'ACTIVE', baseUrl: 'https://graph.facebook.com/v21.0', apiKeyEnc: '',
        webhookToken: 'bleed-meta-token-b',
      } });
      await raw.metaChannelCredential.create({ data: {
        id: 'bleed_meta_cred_a', organizationId: orgA.organizationId, channelId: channelA.id,
        phoneNumberId: 'PN_ORG_A', wabaId: 'WABA_A', businessPortfolioId: 'PORTFOLIO_A',
        accessTokenEnc: require('../src/lib/credential-crypto').encryptCredential('stub-token-a'), status: 'ACTIVE',
      } });
      await raw.metaChannelCredential.create({ data: {
        id: 'bleed_meta_cred_b', organizationId: orgB.organizationId, channelId: channelB.id,
        phoneNumberId: 'PN_ORG_B', wabaId: 'WABA_B', businessPortfolioId: 'PORTFOLIO_B',
        accessTokenEnc: require('../src/lib/credential-crypto').encryptCredential('stub-token-b'), status: 'ACTIVE',
      } });

      const templateA = await raw.metaMessageTemplate.create({ data: {
        id: 'bleed_meta_template_a', organizationId: orgA.organizationId, wabaId: 'WABA_A',
        providerId: 'provider-template-a', name: 'order_ready', language: 'ar', category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Order ready' }], status: 'DRAFT', isSupported: true,
      } });
      await raw.metaMessageTemplate.create({ data: {
        id: 'bleed_meta_template_b', organizationId: orgB.organizationId, wabaId: 'WABA_B',
        providerId: 'provider-template-b', name: 'order_ready', language: 'ar', category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Order ready' }], status: 'DRAFT', isSupported: true,
      } });
      const templateOtherWaba = await raw.metaMessageTemplate.create({ data: {
        id: 'bleed_meta_template_other_waba', organizationId: orgA.organizationId, wabaId: 'WABA_OLD',
        name: 'old_waba_template', language: 'ar', category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Old WABA' }], status: 'DRAFT', isSupported: true,
      } });
      const lifecycleTemplateIds = [];

      try {
        const payloadFor = (phoneNumberId, wabaId) => ({
          object: 'whatsapp_business_account',
          entry: [{ id: wabaId, changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: phoneNumberId },
            messages: [{ id: 'wamid.harness', from: '972500000001', type: 'text' }],
          } }] }],
        });

        const { isMetaTemplateSendable, submitMetaTemplate } = require('../src/modules/meta-templates/meta-templates.service');
        assert.equal(isMetaTemplateSendable('APPROVED'), true, 'exact APPROVED status must be sendable');
        assert.equal(isMetaTemplateSendable('PAUSED'), false, 'PAUSED template was treated as sendable');
        assert.equal(isMetaTemplateSendable('APPROVED', new Date()), false, 'archived template was treated as sendable');

        let crossedWaba = false;
        await assert.rejects(
          () => runAsOrganization(orgB.organizationId, () => submitMetaTemplate(templateA.id, {
            create: async () => { crossedWaba = true; return { id: 'must-not-be-created', status: 'PENDING' }; },
            list: async () => ({ data: [] }),
          })),
          (error) => error?.code === 'META_TEMPLATE_NOT_FOUND',
          'a template from WABA A was accepted through WABA B',
        );
        assert.equal(crossedWaba, false, 'the provider was called with a template from another WABA');
        await assert.rejects(
          () => runAsOrganization(orgA.organizationId, () => submitMetaTemplate(templateOtherWaba.id, {
            create: async () => { crossedWaba = true; return { id: 'must-not-be-created', status: 'PENDING' }; },
            list: async () => ({ data: [] }),
          })),
          (error) => error?.code === 'META_TEMPLATE_NOT_FOUND',
          'a template from an old WABA was accepted in the same organization',
        );
        assert.equal(crossedWaba, false, 'the provider was called with a template from an old WABA');
        await assert.rejects(
          () => raw.metaChannelCredential.update({ where: { id: 'bleed_meta_cred_b' }, data: { businessPortfolioId: 'PORTFOLIO_A' } }),
          (error) => error?.code === 'P2002',
          'the database permitted sharing one Business Portfolio across organizations',
        );

        const { createMetaTemplateDraft, syncCurrentMetaTemplates, archiveMetaTemplate } = require('../src/modules/meta-templates/meta-templates.service');
        const lifecycleDraft = await runAsOrganization(orgA.organizationId, () => createMetaTemplateDraft({
          name: 'stub_lifecycle', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: 'Stub body' }],
        }));
        lifecycleTemplateIds.push(lifecycleDraft.id);
        assert.equal(lifecycleDraft.status, 'DRAFT');
        const lifecycleSubmitted = await runAsOrganization(orgA.organizationId, () => submitMetaTemplate(lifecycleDraft.id, {
          create: async (wabaId, accessToken, payload) => {
            assert.equal(wabaId, 'WABA_A');
            assert.equal(accessToken, 'stub-token-a');
            assert.equal(payload.category, 'UTILITY');
            return { ...payload, id: 'provider-stub-lifecycle', status: 'PENDING' };
          },
          list: async () => ({ data: [] }),
        }));
        assert.equal(lifecycleSubmitted.providerId, 'provider-stub-lifecycle');
        assert.equal(lifecycleSubmitted.status, 'PENDING');

        let listCalls = 0;
        const synced = await runAsOrganization(orgA.organizationId, () => syncCurrentMetaTemplates({
          create: async () => ({ id: 'unused' }),
          list: async (_wabaId, _accessToken, after) => {
            listCalls += 1;
            if (!after) return { data: [{ id: 'provider-imported', name: 'imported_template', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Imported' }] }], paging: { cursors: { after: 'cursor-1' } } };
            return { data: [{ id: 'provider-paused', name: 'paused_template', language: 'ar', category: 'MARKETING', status: 'PAUSED', components: [{ type: 'BODY', text: 'Paused' }] }] };
          },
        }));
        assert.equal(listCalls, 2, 'template polling did not follow the provider cursor');
        assert.equal(synced.pages, 2);
        const importedTemplate = await raw.metaMessageTemplate.findFirst({ where: { providerId: 'provider-imported' } });
        const polledPausedTemplate = await raw.metaMessageTemplate.findFirst({ where: { providerId: 'provider-paused' } });
        lifecycleTemplateIds.push(importedTemplate.id, polledPausedTemplate.id);
        assert.equal(importedTemplate.status, 'APPROVED');
        assert.equal(polledPausedTemplate.status, 'PAUSED');
        const archived = await runAsOrganization(orgA.organizationId, () => archiveMetaTemplate(lifecycleDraft.id));
        assert.ok(archived.archivedAt, 'archive did not record archivedAt');
        assert.equal(archived.sendable, false, 'archived template remained sendable');

        // Record the scope each change entered AND what it could read from
        // inside it. An organizationId passed around as a string proves nothing;
        // being unable to see the other tenant is the property that matters.
        const entered = [];
        const recorder = async () => {
          const visible = await scoped.metaChannelCredential.findMany({ select: { phoneNumberId: true } });
          entered.push({ scope: getTenantId(), visible: visible.map((row) => row.phoneNumberId).sort() });
        };

        await dispatchMetaWebhookPayload(payloadFor('PN_ORG_A', 'WABA_A'), recorder);
        assert.deepEqual(
          entered.map((item) => item.scope),
          [orgA.organizationId],
          'a payload naming org A must enter org A scope, and no other',
        );
        assert.deepEqual(
          entered[0].visible,
          ['PN_ORG_A'],
          'from inside org A scope the webhook could read another tenant credential',
        );

        entered.length = 0;
        await dispatchMetaWebhookPayload(payloadFor('PN_ORG_B', 'WABA_B'), recorder);
        assert.deepEqual(entered.map((item) => item.scope), [orgB.organizationId]);
        assert.deepEqual(entered[0].visible, ['PN_ORG_B']);

        // Switching away retains the credential so late delivery receipts can
        // still settle, but customer messages from that inactive number must
        // not enter any tenant scope. Otherwise the shared send path replies
        // through the newly ACTIVE channel and creates a split-brain thread.
        await raw.organizationChannel.update({
          where: { id: channelA.id },
          data: { status: 'INACTIVE' },
        });
        await dispatchMetaWebhookPayload({
          object: 'whatsapp_business_account',
          entry: [{ id: 'WABA_A', changes: [{ field: 'message_template_status_update', value: {
            message_template_id: 'provider-template-a', event: 'PAUSED', reason: 'quality',
          } }] }],
        });
        const pausedTemplate = await raw.metaMessageTemplate.findUnique({ where: { id: templateA.id } });
        assert.equal(pausedTemplate.status, 'PAUSED', 'WABA template status webhook did not preserve PAUSED');
        assert.equal(isMetaTemplateSendable(pausedTemplate.status), false, 'PAUSED template crossed the sendability boundary');

        await dispatchMetaWebhookPayload({
          object: 'whatsapp_business_account',
          entry: [{ id: 'WABA_A', changes: [{ field: 'message_template_status_update', value: {
            message_template_id: 'provider-template-a', event: 'PROVIDER_FUTURE_STATUS',
          } }] }],
        });
        const unknownTemplateStatus = await raw.metaMessageTemplate.findUnique({ where: { id: templateA.id } });
        assert.equal(unknownTemplateStatus.status, 'PROVIDER_FUTURE_STATUS', 'unknown provider status was coerced');

        await dispatchMetaWebhookPayload({
          object: 'whatsapp_business_account',
          entry: [{ id: 'WABA_B', changes: [{ field: 'message_template_status_update', value: {
            message_template_id: 'provider-template-a', event: 'APPROVED',
          } }] }],
        });
        const crossWabaStatus = await raw.metaMessageTemplate.findUnique({ where: { id: templateA.id } });
        assert.equal(crossWabaStatus.status, 'PROVIDER_FUTURE_STATUS', 'a WABA B event changed a WABA A template');
        entered.length = 0;
        await dispatchMetaWebhookPayload(payloadFor('PN_ORG_A', 'WABA_A'), recorder);
        assert.equal(
          entered.length,
          0,
          'an inactive Meta channel admitted a customer message into the inbox',
        );
        const inactiveResolution = await organizationForPhoneNumberId('PN_ORG_A');
        assert.equal(inactiveResolution.channelStatus, 'INACTIVE');

        const inactiveReceipts = [];
        await dispatchMetaWebhookPayload({
          object: 'whatsapp_business_account',
          entry: [{ id: 'WABA_A', changes: [{ field: 'messages', value: {
            metadata: { phone_number_id: 'PN_ORG_A' },
            messages: [{ id: 'wamid.must-not-enter', from: '972500000001', type: 'text' }],
            statuses: [{ id: 'wamid.before-switch', status: 'delivered' }],
          } }] }],
        }, async (context) => {
          inactiveReceipts.push({
            scope: getTenantId(),
            messages: context.value.messages,
            statuses: context.value.statuses,
          });
        });
        assert.equal(inactiveReceipts.length, 1, 'an inactive Meta channel dropped a pre-switch status receipt');
        assert.equal(inactiveReceipts[0].scope, orgA.organizationId);
        assert.equal(inactiveReceipts[0].messages, undefined, 'inactive Meta content reached the status-only handler');
        assert.equal(inactiveReceipts[0].statuses.length, 1);

        await raw.organizationChannel.update({
          where: { id: channelA.id },
          data: { status: 'ACTIVE' },
        });

        // An unrecognised number is dropped, never guessed onto whichever tenant
        // happens to be first. There is no fallback by design.
        entered.length = 0;
        await dispatchMetaWebhookPayload(payloadFor('PN_NOT_REGISTERED', 'WABA_X'), recorder);
        assert.equal(entered.length, 0, 'an unrecognised phone_number_id entered a tenant scope');
        assert.equal(await organizationForPhoneNumberId('PN_NOT_REGISTERED'), null);
        assert.equal(await organizationForPhoneNumberId(''), null);

        // Meta packs changes for several numbers into one delivery. Each must
        // land in its own scope, and neither may see the other.
        entered.length = 0;
        await dispatchMetaWebhookPayload({
          object: 'whatsapp_business_account',
          entry: [
            payloadFor('PN_ORG_A', 'WABA_A').entry[0],
            payloadFor('PN_ORG_B', 'WABA_B').entry[0],
          ],
        }, recorder);
        assert.deepEqual(
          entered.map((item) => item.scope),
          [orgA.organizationId, orgB.organizationId],
          'a mixed-tenant delivery did not scope each change to its own organization',
        );
        assert.deepEqual(entered[0].visible, ['PN_ORG_A']);
        assert.deepEqual(entered[1].visible, ['PN_ORG_B']);

        // The signature gate, over raw bytes. A body that differs from the one
        // Meta signed - by a single trailing space - must not verify.
        const previousSecret = process.env.META_APP_SECRET;
        process.env.META_APP_SECRET = 'harness-app-secret-value';
        const body = Buffer.from(JSON.stringify(payloadFor('PN_ORG_A', 'WABA_A')), 'utf8');
        const signature = 'sha256=' + crypto
          .createHmac('sha256', 'harness-app-secret-value').update(body).digest('hex');
        assert.equal(verifyMetaSignature(body, signature), true, 'a correctly signed body was rejected');
        assert.equal(
          verifyMetaSignature(Buffer.concat([body, Buffer.from(' ')]), signature),
          false,
          'a tampered body passed signature verification',
        );
        assert.equal(verifyMetaSignature(body, 'sha256=deadbeef'), false);
        assert.equal(verifyMetaSignature(body, undefined), false);
        delete process.env.META_APP_SECRET;
        assert.equal(
          verifyMetaSignature(body, signature),
          false,
          'the webhook verified a signature with no META_APP_SECRET configured - it must fail closed',
        );
        if (previousSecret === undefined) delete process.env.META_APP_SECRET;
        else process.env.META_APP_SECRET = previousSecret;
      } finally {
        await raw.metaMessageTemplate.deleteMany({
          where: { id: { in: ['bleed_meta_template_a', 'bleed_meta_template_b', 'bleed_meta_template_other_waba', ...lifecycleTemplateIds] } },
        });
        await raw.metaChannelCredential.deleteMany({
          where: { id: { in: ['bleed_meta_cred_a', 'bleed_meta_cred_b'] } },
        });
        await raw.organizationChannel.deleteMany({
          where: { id: { in: ['bleed_meta_channel_a', 'bleed_meta_channel_b'] } },
        });
      }
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
    if (backendChild && backendChild.exitCode === null) {
      // Defensive cleanup, not the fix for anything. Measured on 2026-08-29:
      // the child was never what held the loop - see closeLoadedQueues below.
      // Kept because the parent holds both of this child's stdio pipes, so
      // bounding the wait and destroying them is correct regardless.
      backendChild.kill('SIGKILL');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer.unref?.();
        backendChild.once('exit', () => { clearTimeout(timer); resolve(); });
      });
      backendChild.stdout?.destroy();
      backendChild.stderr?.destroy();
      backendChild.unref?.();
    }
    await closeLoadedQueues();
    const appPrismaModule = require.cache[require.resolve('../src/prisma')];
    if (appPrismaModule) await require('../src/prisma').prisma.$disconnect().catch(() => {});
    await raw.$disconnect().catch(() => {});
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch((error) => {
      record('database: drop disposable schema', false, String(error));
    });
    await admin.$disconnect().catch(() => {});
    fs.rmSync(snippetUploadDir, { recursive: true, force: true });
    if (previousSnippetUploadDir === undefined) delete process.env.SNIPPET_UPLOAD_DIR;
    else process.env.SNIPPET_UPLOAD_DIR = previousSnippetUploadDir;
  }
}

// Every queue module builds its Queue at module load, so merely requiring one
// opens a Redis connection. An unclosed connection keeps Node's event loop
// alive, and the harness then hangs after reporting instead of exiting — a
// green run that never returns is worse than a red one.
//
// This is a sweep rather than a fixed list of closes because *when* a module is
// loaded varies by path. It must be called again after every step that can load
// more of them; closing an already-closed BullMQ queue is a no-op, so calling it
// more than once is free.
const QUEUE_MODULES = [
  ['../src/workers/gateway-provisioning.queue', 'gatewayProvisioningQueue'],
  ['../src/workers/billing-reconciliation.worker', 'billingReconciliationQueue'],
  ['../src/workers/analytics-rollup.worker', 'analyticsRollupQueue'],
  ['../src/workers/gateway-health.worker', 'gatewayHealthQueue'],
  ['../src/workers/auto-close.queue', 'conversationAutoCloseQueue'],
  ['../src/workers/incoming-message.worker', 'incomingMessageQueue'],
  ['../src/workers/campaign.worker', 'campaignQueue'],
  ['../src/workers/escalation.worker', 'escalationQueue'],
  ['../src/workers/workflow.worker', 'workflowQueue'],
  ['../src/workers/meta-template-sync.worker', 'metaTemplateSyncQueue'],
];

async function closeLoadedQueues() {
  await Promise.allSettled(QUEUE_MODULES.map(async ([specifier, exportName]) => {
    let resolved;
    try { resolved = require.resolve(specifier); } catch { return; }
    if (!require.cache[resolved]) return;
    const queue = require(specifier)[exportName];
    if (queue && typeof queue.close === 'function') await queue.close().catch(() => {});
  }));
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
  // Must run after workerAudits, not only inside databaseAudits' finally.
  // On the early-failure path databaseAudits sweeps while auto-close.queue and
  // gateway-provisioning.queue are not yet in require.cache, so both are
  // skipped; workerAudits then requires incoming-message.worker, which
  // transitively loads both and opens two Redis connections after the only
  // sweep that would have closed them. That is the whole of the "harness does
  // not exit when it fails early" bug — measured, not inferred.
  await closeLoadedQueues();

  const failed = results.filter((result) => !result.passed);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    process.stdout.write('Failed checks:\n');
    failed.forEach((result) => process.stdout.write(`- ${result.name}\n`));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // A gate may fail; it may not hang.
    //
    // Two separate leaks have now kept this process alive after it finished
    // reporting: an unclosed BullMQ queue handle, and a spawned child whose
    // stdio pipes the parent still held. Both are fixed at the root. This is
    // the net under the third one.
    //
    // unref'd deliberately. If the event loop is empty the process exits on its
    // own and this timer never fires, so nothing is truncated on the normal
    // path. If something still holds the loop five seconds after the summary
    // was written, that is a leak nobody anticipated - and a result nobody can
    // read, because the process never returns, is worse than an abrupt exit
    // carrying the correct code.
    const drainGuard = setTimeout(() => process.exit(process.exitCode || 0), 5000);
    drainGuard.unref?.();
  });
