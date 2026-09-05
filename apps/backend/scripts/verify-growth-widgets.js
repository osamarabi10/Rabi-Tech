/**
 * Growth widgets: is the attribution path actually connected?
 *
 * ## Two halves, and only one of them can answer the question
 *
 * The structural half greps source for identifiers — that every
 * `AcquisitionSource` member is written by something, that every attribution
 * column on `Contact` is populated somewhere, that the one widget type can be
 * created and served. Those checks are worth having and they are **not
 * evidence that the feature works.** A grep can see that a name exists. It
 * cannot see whether the redirect writes a row, whether the parser extracts a
 * token, or whether the join lands on the right contact.
 *
 * That is D-32's shape and the cap gate's shape both: a right assertion pointed
 * at an artifact where the property does not live. So the second half mints a
 * real click over HTTP, delivers a real inbound message carrying its token, and
 * looks at what came out of the database.
 *
 * ## The exclusions are load-bearing
 *
 * Every "is this written somewhere" check excludes `schema.prisma` and the enum
 * declaration itself. Without that, each check finds the very declaration it is
 * supposed to be proving is *reachable* — which is exactly how the recipient-cap
 * gate stayed green at 40/40 while the cap was bypassed.
 *
 * ## What this still cannot see
 *
 * The round-trip proves one path end to end. It does not prove the redirect is
 * rate-limited (verify-auth-exemptions asserts that), and it does not prove
 * attribution survives a customer editing the marker out of their message —
 * nothing can, because that is the feature working as designed.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const PORT = 4187;

// ── source, with the declarations deliberately out of scope ──────────────────
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', 'coverage']);

/*
  Skipping happens during the descent, not after it. Filtering the result
  afterwards would still read every path under node_modules and .next first,
  which is wasted work on every run.

  Worth recording honestly: this was changed while chasing a run that appeared
  to hang, and it was **not** the cause. The script had already completed in
  about six seconds; what never happened was process *exit*, because the Redis
  connection keeps the event loop alive. Node also block-buffers stdout when it
  is piped, so nothing had been flushed to the log — which is what made a
  finished run look like a stuck one. The change is kept because it is right,
  not because it fixed anything.
*/
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const schemaPath = path.join(ROOT, 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');

/*
  Everything under src, minus nothing — but read as a map so the enum's own
  declaration file can be excluded per-check. The schema is never in here at
  all: it is the declaration, and a check that reads it is checking that a name
  was defined, not that it is used.
*/
const backendFiles = walk(SRC).map((f) => ({ rel: path.relative(SRC, f), text: fs.readFileSync(f, 'utf8') }));
const frontendRoot = path.join(ROOT, '..', 'frontend');
const frontendFiles = fs.existsSync(frontendRoot)
  ? walk(frontendRoot).map((f) => ({ rel: path.relative(frontendRoot, f), text: fs.readFileSync(f, 'utf8') }))
  : [];

check('scope: source was found on both sides',
  backendFiles.length > 50 && frontendFiles.length > 20,
  backendFiles.length + ' backend, ' + frontendFiles.length + ' frontend — the walker found too little to trust');

// ── 1 · every AcquisitionSource member has a producer ────────────────────────
const enumBlock = schema.match(/enum AcquisitionSource \{([\s\S]*?)\}/);
const members = enumBlock
  ? enumBlock[1].split('\n').map((l) => l.replace(/\/\/.*/, '').trim()).filter((l) => /^[A-Z_]+$/.test(l))
  : [];

check('parse: the AcquisitionSource enum was read from the schema',
  members.length >= 3,
  'parsed ' + members.length + ' members — fix the parse before trusting the next check');

/*
  A producer is an assignment, not a mention. `acquisitionSource: 'IMPORT'` in a
  create call counts; the word IMPORT in a comment does not, and neither does
  the enum's own declaration, which is why the schema is not in this corpus.
*/
const withoutProducer = members.filter((member) => {
  if (member === 'UNKNOWN') {
    // Its producer is the migration's DEFAULT, not application code — so it is
    // proved against the migration rather than against src.
    const migrations = path.join(ROOT, 'prisma', 'migrations');
    return !walkSql(migrations).some((sql) => /DEFAULT\s+'UNKNOWN'/.test(sql));
  }
  const pattern = new RegExp("acquisitionSource:\\s*'" + member + "'");
  return !backendFiles.some((f) => pattern.test(f.text));
});

function walkSql(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSql(full));
    else if (entry.name.endsWith('.sql')) out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

check('1 · every AcquisitionSource member is produced by something',
  withoutProducer.length === 0,
  withoutProducer.join(', ') + ' — a member nothing writes is the declared-but-unreachable defect');

// ── 2 · every attribution column on Contact is written ───────────────────────
const COLUMNS = ['acquisitionSource', 'acquisitionWidgetId', 'acquisitionUtmCampaign', 'acquisitionAt'];
const unwrittenColumns = COLUMNS.filter((col) => {
  const pattern = new RegExp('\\b' + col + ':\\s');
  return !backendFiles.some((f) => pattern.test(f.text));
});

check('2 · every attribution column on Contact is written somewhere in src',
  unwrittenColumns.length === 0,
  unwrittenColumns.join(', '));

// ── 3 · the widget type is reachable from creation through to the redirect ───
const typeBlock = schema.match(/enum GrowthWidgetType \{([\s\S]*?)\}/);
const widgetTypes = typeBlock
  ? typeBlock[1].split('\n').map((l) => l.replace(/\/\/.*/, '').trim()).filter((l) => /^[A-Z_]+$/.test(l))
  : [];

const unreachableTypes = widgetTypes.filter((type) => {
  const created = backendFiles.some((f) => new RegExp("type:\\s*'" + type + "'").test(f.text));
  return !created;
});

check('parse: the GrowthWidgetType enum was read', widgetTypes.length >= 1, 'parsed ' + widgetTypes.length);
check('3a · every widget type can actually be created',
  unreachableTypes.length === 0,
  unreachableTypes.join(', '));

const redirectFile = backendFiles.find((f) => f.rel.replace(/\\/g, '/') === 'modules/growth-widgets/widget-redirect.routes.ts');
check('3b · the redirect exists and serves a widget by its public token',
  !!redirectFile && /publicToken/.test(redirectFile.text) && /res\.redirect\(/.test(redirectFile.text),
  'the created widget has no endpoint that resolves it');

const uiCreates = frontendFiles.some((f) => /createGrowthWidget/.test(f.text) && !/lib[\\/]data\.ts$/.test(f.rel));
check('3c · a widget can be created from the product, not only from the API',
  uiCreates,
  'nothing in the UI calls createGrowthWidget — a widget type nobody can make is unreachable in practice');

// ── 4 · the sources report is reachable from the product ─────────────────────
check('4 · the sources report has a screen that calls it',
  frontendFiles.some((f) => f.text.includes('/api/analytics/sources')),
  'no UI references /api/analytics/sources — this is the closures defect exactly');

// ── the round-trip ───────────────────────────────────────────────────────────
/**
 * Poll until the queued message has been processed, or give up loudly.
 *
 * Returns whatever the reader returns once it is non-null. A fixed sleep would
 * be either flaky or slow, and a null return here is reported by the check that
 * asked for it rather than swallowed.
 */
async function waitFor(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function waitForReady(child) {
  const deadline = Date.now() + Number(process.env.HARNESS_BACKEND_READY_MS || 60_000);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
  const { prisma } = require('../dist/prisma');
  /*
    The inbound message is processed **in this process**, deliberately, and not
    put on the queue.

    Queueing it looked more faithful and is actively wrong here: BullMQ is
    shared, and on this machine a containerised backend on port 3000 is
    subscribed to the same queue. It consumed the gate's job and created the
    contact itself, from an older build with no attribution — so the gate
    reported UNKNOWN and looked like a broken feature when the feature was fine
    and the job had been stolen. A gate whose result depends on which consumer
    wins a race is not a gate.

    Processing directly needs Socket.io, because the inbound path emits to it
    after writing the contact and `getIO()` throws when it was never
    initialised. So a throwaway HTTP server is stood up here purely to satisfy
    that. It is closed in cleanup.
  */
  const http = require('http');
  const { initSocket } = require('../dist/socket');
  const socketHost = http.createServer();
  socketHost.listen(0);
  initSocket(socketHost);

  const { processIncomingMessageJob } = require('../dist/workers/incoming-message.worker');
  const { newWidgetToken } = require('../dist/modules/growth-widgets/widget-token');

  const stamp = String(Date.now()).slice(-9);
  const phone = '99904' + stamp;
  let widgetId = null;
  let sessionId = null;
  let orgId = null;

  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      // The spawned server exists only to serve the redirect over HTTP. The
      // inbound message is processed in this process, so its workers would only
      // compete for a queue this gate does not use.
      DISABLE_MESSAGE_WORKER: '1',
      DISABLE_CAMPAIGN_WORKER: '1',
    },
    stdio: 'ignore',
  });

  const cleanup = async () => {
    child.kill('SIGKILL');
    socketHost.close();
    /*
      Reverse dependency order, and it has to be explicit.

      A real inbound message does more than create a contact: it opens a
      conversation, writes a message and raises a notification. Notification's
      FK to Conversation does not cascade, so deleting the contact first fails
      on it — which is what this cleanup did on its first run. The order below
      unwinds what the round-trip actually built rather than what it looks like
      it built.
    */
    await runAsPlatform('verify-growth-widgets:cleanup', async () => {
      const contacts = await prisma.contact.findMany({
        where: { phone: { in: [phone, '99905' + stamp] } }, select: { id: true },
      });
      const contactIds = contacts.map((c) => c.id);
      const conversations = contactIds.length
        ? await prisma.conversation.findMany({ where: { contactId: { in: contactIds } }, select: { id: true } })
        : [];
      const conversationIds = conversations.map((c) => c.id);

      if (conversationIds.length) {
        await prisma.notification.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
        await prisma.conversation.deleteMany({ where: { id: { in: conversationIds } } });
      }
      await prisma.widgetClick.deleteMany({ where: { widgetId: widgetId || '-' } });
      if (contactIds.length) await prisma.contact.deleteMany({ where: { id: { in: contactIds } } });
      if (widgetId) await prisma.growthWidget.deleteMany({ where: { id: widgetId } });
      if (sessionId) await prisma.whatsappSession.deleteMany({ where: { id: sessionId } });
    });
    await prisma.$disconnect();
  };

  try {
    const setup = await runAsPlatform('verify-growth-widgets:setup', async () => {
      const org = await prisma.organization.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
      if (!org) throw new Error('no organization exists to test against');
      // The organization's gateway. A session's channel is not optional, and a
      // fixture that leaves it null would be caught by check:session-channel.
      const gateChannel = await prisma.organizationChannel.findFirst({
        where: { organizationId: org.id, kind: 'OPENWA' },
        select: { id: true },
      });
      if (!gateChannel) throw new Error('no OPENWA channel on the organization under test');
      const session = await prisma.whatsappSession.create({
        data: {
          // Named explicitly: this runs under platform scope, where the
          // extension injects nothing on purpose.
          organizationId: org.id,
          workspaceId: 'ws_' + org.id,
          channelId: gateChannel.id,
          sessionName: 'widget-gate-' + stamp,
          label: 'gate',
          isActive: false,
          phoneNumber: '99100' + stamp,
        },
        select: { id: true, sessionName: true },
      });
      const widget = await prisma.growthWidget.create({
        data: {
          organizationId: org.id,
          name: 'gate widget ' + stamp,
          type: 'CHAT_LINK',
          publicToken: newWidgetToken(),
          sessionId: session.id,
          prefillText: 'مرحبا',
        },
        select: { id: true, publicToken: true },
      });
      return { org, session, widget };
    });
    orgId = setup.org.id;
    sessionId = setup.session.id;
    widgetId = setup.widget.id;

    if (!(await waitForReady(child))) {
      console.log('');
      console.log('[ENV] The backend did not become ready on port ' + PORT + '.');
      console.log('[ENV] The round-trip was not run. No summary line follows, deliberately.');
      await cleanup();
      process.exitCode = 1;
      return;
    }

    // ── mint a click, through the real endpoint ──────────────────────────────
    const redirect = await fetch(
      `http://127.0.0.1:${PORT}/api/widgets/go/${setup.widget.publicToken}?utm_campaign=gate-camp&utm_source=gate-src`,
      { redirect: 'manual', headers: { referer: 'https://example.test/landing' } },
    );

    check('5 · the public redirect answers without a session and does not 401',
      redirect.status === 302,
      'status was ' + redirect.status);

    const location = redirect.headers.get('location') || '';
    const marker = decodeURIComponent(location).match(/#gw_([0-9abcdefghjkmnpqrstvwxyz]{10})/);

    check('6 · it hands off to wa.me carrying a click marker',
      location.startsWith('https://wa.me/') && !!marker,
      'location was ' + location.slice(0, 120));

    if (!marker) throw new Error('no marker to continue the round-trip with');
    const clickToken = marker[1];

    const click = await runAsPlatform('verify-growth-widgets:read-click', () =>
      prisma.widgetClick.findFirst({ where: { clickToken }, select: { id: true, utmCampaign: true, sourceUrl: true, claimedByContactId: true } }));

    check('7 · the click was recorded, with what only the browser knew',
      !!click && click.utmCampaign === 'gate-camp' && !!click.sourceUrl,
      click ? `utmCampaign=${click.utmCampaign} sourceUrl=${click.sourceUrl}` : 'no row was written');
    check('   …and it starts unclaimed', !!click && click.claimedByContactId === null);

    // ── deliver an inbound message carrying that marker ──────────────────────
    await processIncomingMessageJob({
      organizationId: orgId,
      session: setup.session.sessionName,
      phone,
      contactName: 'Gate Visitor',
      body: `مرحبا #gw_${clickToken}`,
      waMessageId: 'gate-widget-' + stamp,
    });

    const contact = await waitFor(() => runAsPlatform('verify-growth-widgets:read-contact', () =>
      prisma.contact.findFirst({
        where: { phone },
        select: {
          id: true, acquisitionSource: true, acquisitionWidgetId: true,
          acquisitionUtmCampaign: true, acquisitionAt: true,
        },
      })));

    check('8 · the inbound message produced a contact stamped GROWTH_WIDGET',
      !!contact && contact.acquisitionSource === 'GROWTH_WIDGET',
      contact ? 'source was ' + contact.acquisitionSource : 'no contact was created');

    check('9 · first-touch points at the widget, and carries the campaign',
      !!contact && contact.acquisitionWidgetId === widgetId
        && contact.acquisitionUtmCampaign === 'gate-camp' && !!contact.acquisitionAt,
      contact ? `widget=${contact.acquisitionWidgetId} campaign=${contact.acquisitionUtmCampaign}` : 'no contact');

    // Waits for the claim specifically, not merely for the row: the click row
    // has existed since check 7, so reading it back would succeed instantly and
    // say nothing about whether the join happened.
    const claimed = await waitFor(() => runAsPlatform('verify-growth-widgets:read-claim', async () => {
      const row = await prisma.widgetClick.findFirst({
        where: { clickToken }, select: { claimedByContactId: true, claimedAt: true },
      });
      return row && row.claimedByContactId ? row : null;
    }));

    check('10 · the click was claimed by that contact',
      !!claimed && !!contact && claimed.claimedByContactId === contact.id && !!claimed.claimedAt,
      claimed ? 'claimedBy=' + claimed.claimedByContactId : 'no row');

    // ── the token is single use ──────────────────────────────────────────────
    const phoneTwo = '99905' + stamp;
    await processIncomingMessageJob({
      organizationId: orgId,
      session: setup.session.sessionName,
      phone: phoneTwo,
      body: `مرحبا #gw_${clickToken}`,
      waMessageId: 'gate-widget-2-' + stamp,
    });
    const second = await waitFor(() => runAsPlatform('verify-growth-widgets:read-second', () =>
      prisma.contact.findFirst({ where: { phone: phoneTwo }, select: { id: true, acquisitionSource: true } })));

    check('11 · a marker forwarded to somebody else attributes nothing',
      !!second && second.acquisitionSource === 'DIRECT',
      second ? 'source was ' + second.acquisitionSource : 'no second contact');

    // phoneTwo is removed by cleanup, which now unwinds both contacts.
  } finally {
    await cleanup();
  }

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

/*
  Exit explicitly. Requiring the worker module opens a BullMQ Redis connection
  that never closes on its own, so the event loop stays alive after the last
  check and the run looks hung when it has actually finished — which is exactly
  how the first version of this file was misread.
*/
main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => process.exit(process.exitCode || 0));
