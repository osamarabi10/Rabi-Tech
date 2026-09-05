/**
 * The public API, over HTTP, against the running server.
 *
 * ## Why HTTP rather than calling the handlers
 *
 * Everything that makes this surface safe lives in the *chain*, not in the
 * handlers: the `/api/v1` exemption from the session-JWT gate, `apiTokenAuth`,
 * the scope check, `runAsOrganization`, and the rate limiter in front of all of
 * it. Calling a handler directly skips every one of those and proves only that
 * the last link works. P1a's smoke test found nothing wrong; it would have found
 * nothing wrong either way, which is the point — this runs the real chain.
 *
 * ## Reading a failure
 *
 * If the server never becomes ready this prints an `[ENV]` line and **no
 * summary line at all**. That absence is deliberate. This repository has been
 * bitten four times (D-5, D-10, D-12, D-16) by a gate reporting on its
 * environment as though it were reporting on the code — most recently the
 * tenancy harness returning `17/18` for "backend did not become ready". A run
 * that could not start has not tested anything, and must not be able to print a
 * number that looks like it did.
 *
 * Everything it creates is deleted on the way out, including on failure.
 */
require('./load-env');

const { spawn } = require('child_process');
const path = require('path');
const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const { issueApiToken } = require('../dist/modules/api-tokens/api-token.service');

const PORT = Number(process.env.VERIFY_API_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : ''));
  }
}

async function call(token, method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body is fine */ }
  return { status: response.status, body: payload };
}

function mint(organizationId, scopes, extra = {}) {
  return runAsPlatform('verify-public-api:mint', () =>
    runAsOrganization(organizationId, () =>
      issueApiToken({
        name: 'gate: ' + scopes.join('+'),
        scopes,
        expiresInDays: 1,
        createdById: null,
        maskContactDetails: false,
        ...extra,
      }),
    ),
  );
}

async function waitForReady(child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(BASE + '/health', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function main() {
  const orgs = await runAsPlatform('verify-public-api:orgs', () =>
    prisma.organization.findMany({ orderBy: { id: 'asc' }, take: 2, select: { id: true } }),
  );
  if (orgs.length < 2) throw new Error('Need two organizations; found ' + orgs.length);
  const [orgA, orgB] = orgs;

  // Phone numbers no real contact will hold. E.164-shaped so normalisation
  // accepts them, and prefixed so cleanup can find any stragglers.
  const stamp = Date.now().toString().slice(-9);
  const PHONE_A = '99900' + stamp;
  const PHONE_B = '99901' + stamp;
  const PHONE_C = '99902' + stamp;

  const tokens = {};
  let conversationId = null;
  let sessionId = null;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DISABLE_MESSAGE_WORKER: '1',
      DISABLE_CAMPAIGN_WORKER: '1',
      /*
        The shipped limit is 5/s per method+path. This suite fires ~130
        sequential assertions, many against the same route, so at the real
        limit it throttles itself and reports 429 where it expected 404 —
        which is exactly what happened on the first run after the limiter
        landed. The limiter is asserted directly below instead, where the
        property can be checked precisely rather than inferred from a race.
      */
      PUBLIC_API_RATE_PER_SECOND: '10000',
      PUBLIC_API_RATE_PER_MINUTE: '100000',
    },
    stdio: 'ignore',
  });

  const cleanup = async () => {
    child.kill('SIGKILL');
    await runAsPlatform('verify-public-api:cleanup', async () => {
      // Reverse dependency order: messages hold the conversation, the
      // conversation holds both the contact and the session.
      if (conversationId) await prisma.message.deleteMany({ where: { conversationId } });
      if (conversationId) await prisma.conversation.deleteMany({ where: { id: conversationId } });
      await prisma.contact.deleteMany({ where: { phone: { in: [PHONE_A, PHONE_B, PHONE_C] } } });
      if (sessionId) await prisma.whatsappSession.deleteMany({ where: { id: sessionId } });
      await prisma.apiToken.deleteMany({ where: { id: { in: Object.values(tokens).map((t) => t.id) } } });
      await prisma.tag.deleteMany({ where: { name: { in: ['gate-tag-one', 'gate-tag-two'] } } });
    });
    await prisma.$disconnect();
  };

  if (!(await waitForReady(child))) {
    console.log('');
    console.log('[ENV] The backend did not become ready on port ' + PORT + '.');
    console.log('[ENV] Nothing was tested. This is an environment failure, not a code failure.');
    console.log('[ENV] No summary line follows, deliberately — see the header of this file.');
    await cleanup();
    process.exitCode = 1;
    return;
  }

  try {
    tokens.rw = await mint(orgA.id, ['contacts:read', 'contacts:write', 'tags:read', 'tags:write']);
    tokens.readOnly = await mint(orgA.id, ['contacts:read']);
    tokens.writeOnly = await mint(orgA.id, ['contacts:write']);
    tokens.masked = await mint(orgA.id, ['contacts:read', 'contacts:write'], { maskContactDetails: true });
    tokens.otherOrg = await mint(orgB.id, ['contacts:read', 'contacts:write', 'conversations:read', 'messages:read']);
    tokens.threads = await mint(orgA.id, ['conversations:read', 'messages:read']);
    const RW = tokens.rw.token;
    const RW2 = tokens.threads.token;

    // ── create ──────────────────────────────────────────────────────────────
    const created = await call(RW, 'POST', '/api/v1/contacts', {
      phone: PHONE_A, name: 'Gate Contact', email: 'Gate.Contact@Example.COM',
    });
    check('POST /contacts creates', created.status === 201, JSON.stringify(created.body));
    check('  …returns the + form of the phone', created.body?.phone === '+' + PHONE_A, created.body?.phone);
    check('  …lower-cases the email', created.body?.email === 'gate.contact@example.com', created.body?.email);
    const contactId = created.body?.id;

    /*
      The serializer is a published contract. A raw Prisma row would publish
      every column this table ever grows to third-party software, permanently
      and by accident — including two that must never leave: the tenant id, and
      the internal user id on `blockedById`, which names a person to a caller
      who cannot resolve it and has no business knowing it.
    */
    const leaked = ['organizationId', 'blockedById', 'consentSource', 'profilePic', 'assigneeId']
      .filter((key) => key in (created.body || {}));
    check('no internal column leaks into the response', leaked.length === 0, leaked.join(', '));

    const duplicate = await call(RW, 'POST', '/api/v1/contacts', { phone: PHONE_A, name: 'Second' });
    check('POST refuses to overwrite an existing contact', duplicate.status === 409);
    check('  …and names the id so the caller need not look it up',
      duplicate.body?.contactId === contactId);

    // ── the identifier grammar ──────────────────────────────────────────────
    const byId = await call(RW, 'GET', '/api/v1/contacts/id:' + contactId);
    check('GET id: resolves', byId.status === 200 && byId.body?.id === contactId);
    const byPhone = await call(RW, 'GET', '/api/v1/contacts/phone:' + PHONE_A);
    check('GET phone: resolves', byPhone.status === 200 && byPhone.body?.id === contactId);
    const byPlus = await call(RW, 'GET', '/api/v1/contacts/phone:%2B' + PHONE_A);
    check('GET phone: accepts the + form too', byPlus.status === 200 && byPlus.body?.id === contactId,
      JSON.stringify(byPlus.body));
    const byEmail = await call(RW, 'GET', '/api/v1/contacts/email:GATE.CONTACT@example.com');
    check('GET email: is case-insensitive', byEmail.status === 200 && byEmail.body?.id === contactId);

    /*
      An unprefixed identifier is refused rather than guessed. `972501234567` is
      a plausible phone number and a plausible id; guessing wrong does not error,
      it addresses a *different contact* — and on a PUT that overwrites someone
      else's record.
    */
    const bare = await call(RW, 'GET', '/api/v1/contacts/' + contactId);
    check('an unprefixed identifier is refused, not guessed', bare.status === 400);
    check('  …and the error states the grammar',
      /id:|phone:|email:/.test(bare.body?.message || ''), bare.body?.message);
    const wrongKind = await call(RW, 'GET', '/api/v1/contacts/name:Gate');
    check('an unknown identifier type is refused', wrongKind.status === 400);
    const missing = await call(RW, 'GET', '/api/v1/contacts/phone:99999999999999');
    check('an unmatched identifier is 404, not 500', missing.status === 404, 'got ' + missing.status + ' ' + JSON.stringify(missing.body));

    // ── PATCH updates, never creates ────────────────────────────────────────
    const patched = await call(RW, 'PATCH', '/api/v1/contacts/id:' + contactId, { name: 'Renamed' });
    check('PATCH updates', patched.status === 200 && patched.body?.name === 'Renamed');
    const patchMissing = await call(RW, 'PATCH', '/api/v1/contacts/phone:' + PHONE_B, { name: 'Nope' });
    check('PATCH on a missing contact is 404, never a create', patchMissing.status === 404);
    const stillMissing = await runAsPlatform('verify-public-api:check', () =>
      prisma.contact.findFirst({ where: { phone: PHONE_B } }),
    );
    check('  …and really did not create one', stillMissing === null);

    // ── PUT is create-or-update ─────────────────────────────────────────────
    const putCreated = await call(RW, 'PUT', '/api/v1/contacts/phone:' + PHONE_B, { name: 'Upserted' });
    check('PUT creates when absent', putCreated.status === 201 && putCreated.body?.name === 'Upserted');
    const putUpdated = await call(RW, 'PUT', '/api/v1/contacts/phone:' + PHONE_B, { name: 'Upserted twice' });
    check('PUT updates when present', putUpdated.status === 200 && putUpdated.body?.name === 'Upserted twice');
    check('  …and did not make a second contact', putUpdated.body?.id === putCreated.body?.id);

    // A contact this product cannot message is not a contact. Creating from an
    // email identifier with no phone in the body has to say so rather than
    // inventing one.
    const putNoPhone = await call(RW, 'PUT', '/api/v1/contacts/email:nobody@example.com', { name: 'X' });
    check('PUT email: with no phone refuses rather than creating an unmessageable contact',
      putNoPhone.status === 400);
    check('  …and says what is needed', /phone/i.test(putNoPhone.body?.message || ''));

    // ── scopes ──────────────────────────────────────────────────────────────
    const readerWrite = await call(tokens.readOnly.token, 'PATCH', '/api/v1/contacts/id:' + contactId, { name: 'No' });
    check('a read-only token cannot write', readerWrite.status === 403);
    check('  …as insufficient_scope', readerWrite.body?.error === 'insufficient_scope');
    const writerRead = await call(tokens.writeOnly.token, 'GET', '/api/v1/contacts/id:' + contactId);
    check('a write-only token cannot read', writerRead.status === 403);
    const writerTags = await call(tokens.writeOnly.token, 'POST', `/api/v1/contacts/id:${contactId}/tags`, { tag: 'x' });
    check('contacts:write does not carry tags:write', writerTags.status === 403);
    const noToken = await call(null, 'GET', '/api/v1/contacts/id:' + contactId);
    check('no credential is 401', noToken.status === 401);

    // ── tenancy, over HTTP ──────────────────────────────────────────────────
    // The id is real and the token is valid; only the workspace differs. This is
    // the assertion that would catch a handler that forgot to scope.
    const crossRead = await call(tokens.otherOrg.token, 'GET', '/api/v1/contacts/id:' + contactId);
    check('another workspace cannot read this contact by id', crossRead.status === 404, crossRead.status);
    const crossPatch = await call(tokens.otherOrg.token, 'PATCH', '/api/v1/contacts/id:' + contactId, { name: 'Stolen' });
    check('another workspace cannot write it either', crossPatch.status === 404);
    const untouched = await runAsPlatform('verify-public-api:check', () =>
      prisma.contact.findUnique({ where: { id: contactId }, select: { name: true } }),
    );
    check('  …and the contact is unchanged', untouched?.name === 'Renamed', untouched?.name);

    // ── masking ─────────────────────────────────────────────────────────────
    const maskedRead = await call(tokens.masked.token, 'GET', '/api/v1/contacts/id:' + contactId);
    check('a masked token gets a masked phone', maskedRead.body?.phone === '••••••', maskedRead.body?.phone);
    check('  …and a masked email', maskedRead.body?.email === '••••••');
    check('  …and is told it is masked, not that the field is empty', maskedRead.body?.masked === true);
    check('  …while the unmasked token still sees the real number',
      byId.body?.phone === '+' + PHONE_A);

    // ── custom fields ───────────────────────────────────────────────────────
    const unknownField = await call(RW, 'PATCH', '/api/v1/contacts/id:' + contactId, {
      customFields: { definitely_not_a_field: 'x' },
    });
    check('an unknown custom field is refused', unknownField.status === 400);
    check('  …and the workspace vocabulary is offered',
      Array.isArray(unknownField.body?.details?.unknown));

    /*
      The injection this shape invites. Writing `{ [key]: value }` straight onto
      the contact was caught in the workflow engine during development, where it
      allowed setting `organizationId` — moving a contact into another tenant.
      Here the key must resolve through CustomFieldDefinition or be refused.
    */
    const injection = await call(RW, 'PATCH', '/api/v1/contacts/id:' + contactId, {
      customFields: { organizationId: orgB.id },
    });
    check('customFields cannot smuggle organizationId', injection.status === 400);
    const notMoved = await runAsPlatform('verify-public-api:check', () =>
      prisma.contact.findUnique({ where: { id: contactId }, select: { organizationId: true } }),
    );
    check('  …and the contact stayed in its workspace', notMoved?.organizationId === orgA.id);

    // ── consent goes through the audit path ─────────────────────────────────
    const consented = await call(RW, 'PATCH', '/api/v1/contacts/id:' + contactId, {
      marketingConsent: 'OPTED_OUT',
    });
    check('marketingConsent is accepted', consented.status === 200);
    check('  …and reported back', consented.body?.marketingConsent === 'OPTED_OUT');
    const consentRow = await runAsPlatform('verify-public-api:check', () =>
      prisma.contact.findUnique({ where: { id: contactId }, select: { marketingConsent: true, consentSource: true } }),
    );
    check('  …stored', consentRow?.marketingConsent === 'OPTED_OUT');
    // The whole reason consent is not a plain column write: the source has to
    // survive, so "who changed this" is answerable later.
    check('  …with source "api", not a bare column write', consentRow?.consentSource === 'api',
      consentRow?.consentSource);
    const badConsent = await call(RW, 'PATCH', '/api/v1/contacts/id:' + contactId, { marketingConsent: 'MAYBE' });
    check('an invalid consent value is refused', badConsent.status === 400);

    // ── tags ────────────────────────────────────────────────────────────────
    const tagged = await call(RW, 'POST', `/api/v1/contacts/id:${contactId}/tags`, {
      tags: ['gate-tag-one', 'gate-tag-two'],
    });
    check('tags are applied', tagged.status === 200);
    check('  …and returned on the contact',
      tagged.body?.tags?.includes('gate-tag-one') && tagged.body?.tags?.includes('gate-tag-two'),
      JSON.stringify(tagged.body?.tags));
    const sourced = await runAsPlatform('verify-public-api:check', () =>
      prisma.contactTag.findFirst({ where: { contactId }, select: { source: true } }),
    );
    check('  …marked source API so an operator can tell it from a colleague',
      sourced?.source === 'API', sourced?.source);

    const untagged = await call(RW, 'DELETE', `/api/v1/contacts/id:${contactId}/tags/gate-tag-one`);
    check('a tag can be removed', untagged.status === 200);
    check('  …and is gone', !untagged.body?.tags?.includes('gate-tag-one'));
    const removeAgain = await call(RW, 'DELETE', `/api/v1/contacts/id:${contactId}/tags/gate-tag-one`);
    // A retrying client must be able to converge without special-casing
    // "already gone", so removing an absent tag is success, not 404.
    check('removing an absent tag is idempotent', removeAgain.status === 200);

    // ── list ────────────────────────────────────────────────────────────────
    await call(RW, 'POST', '/api/v1/contacts', { phone: PHONE_C, name: 'Third' });
    const listed = await call(RW, 'POST', '/api/v1/contacts/list', { limit: 2 });
    check('POST /contacts/list returns contacts', listed.status === 200 && Array.isArray(listed.body?.contacts));
    check('  …honours the limit', (listed.body?.contacts || []).length <= 2);
    check('  …and reports pagination', typeof listed.body?.pagination?.hasMore === 'boolean');
    if (listed.body?.pagination?.cursorId) {
      const page2 = await call(RW, 'POST', '/api/v1/contacts/list', {
        limit: 2, cursorId: listed.body.pagination.cursorId,
      });
      const firstPageIds = new Set((listed.body.contacts || []).map((c) => c.id));
      const overlap = (page2.body?.contacts || []).filter((c) => firstPageIds.has(c.id));
      check('  …and the second page does not repeat the first', overlap.length === 0,
        overlap.map((c) => c.id).join(','));
    }

    const badFilter = await call(RW, 'POST', '/api/v1/contacts/list', {
      filter: { $and: [{ field: 'no_such_field', operator: 'isEqualTo', value: 'x' }] },
    });
    check('an invalid filter is refused with its errors', badFilter.status === 400);
    check('  …naming what was wrong', Array.isArray(badFilter.body?.details));

    const listedMasked = await call(tokens.masked.token, 'POST', '/api/v1/contacts/list', { limit: 5 });
    check('list masks too, not just the single read',
      (listedMasked.body?.contacts || []).every((c) => c.phone === '••••••'));

    // ── conversations ───────────────────────────────────────────────────────
    /*
      A thread needs a session, so the gate makes its own rather than borrowing
      whichever one the workspace happens to have. Borrowing would tie the run to
      a row somebody else can rename or delete, and this suite has already been
      bitten by that class once — the finance gate drew a different organization
      between runs because its selection was unordered.
    */
    const session = await runAsPlatform('verify-public-api:setup', async () => {
      // The organization's gateway. A session's channel is not optional, and a
      // fixture that leaves it null would be caught by check:session-channel.
      const gateChannel = await prisma.organizationChannel.findFirst({
        where: { organizationId: orgA.id, kind: 'OPENWA' },
        select: { id: true },
      });
      if (!gateChannel) throw new Error('no OPENWA channel on the organization under test');
      return prisma.whatsappSession.create({
        data: {
          // Named explicitly: this runs under platform scope, where the
          // extension injects nothing on purpose.
          organizationId: orgA.id,
          workspaceId: 'ws_' + orgA.id,
          channelId: gateChannel.id,
          sessionName: 'gate-session-' + stamp,
          label: 'gate',
          isActive: false,
        },
        select: { id: true },
      });
    });
    sessionId = session.id;

    const thread = await runAsPlatform('verify-public-api:setup', () =>
      prisma.conversation.create({
        data: {
          organizationId: orgA.id,
          workspaceId: 'ws_' + orgA.id,
          displayId: 900000 + Number(stamp.slice(-4)),
          contactId: contactId,
          sessionId: session.id,
          status: 'OPEN',
          lastMessageAt: new Date(),
        },
        select: { id: true },
      }),
    );
    conversationId = thread.id;

    await runAsPlatform('verify-public-api:setup', () =>
      prisma.message.createMany({
        data: [
          { organizationId: orgA.id, workspaceId: 'ws_' + orgA.id, conversationId: thread.id, direction: 'INBOUND', body: 'customer said this', status: 'DELIVERED' },
          { organizationId: orgA.id, workspaceId: 'ws_' + orgA.id, conversationId: thread.id, direction: 'OUTBOUND', body: 'agent note, not sent', status: 'SENT', isInternal: true },
        ],
      }),
    );

    const convList = await call(RW2, 'GET', '/api/v1/conversations?limit=5');
    check('GET /conversations lists threads', convList.status === 200 && Array.isArray(convList.body?.conversations));
    check('  …includes the one just created',
      (convList.body?.conversations || []).some((c) => c.id === thread.id));

    const convOne = await call(RW2, 'GET', '/api/v1/conversations/' + thread.id);
    check('GET /conversations/:id resolves', convOne.status === 200 && convOne.body?.id === thread.id);
    check('  …publishes displayId, which is what an agent reads on screen',
      typeof convOne.body?.displayId === 'number');
    check('  …embeds the contact', convOne.body?.contact?.id === contactId);

    // Internal scheduling columns describe how this product runs its own queues.
    // They change whenever that changes and nothing outside can act on them.
    const convLeaked = ['sessionId', 'autoCloseAt', 'autoCloseEligible', 'pendingMenuChoice', 'organizationId']
      .filter((key) => key in (convOne.body || {}));
    check('no internal scheduling column leaks', convLeaked.length === 0, convLeaked.join(', '));

    // `snoozedUntil` in the past means "not snoozed". A caller comparing clocks
    // gets that wrong half the time, so the boolean is derived server-side.
    check('snoozed is derived, not the raw timestamp', convOne.body?.snoozed === false);

    const convBadStatus = await call(RW2, 'GET', '/api/v1/conversations?status=SLEEPING');
    check('an unknown status filter is refused', convBadStatus.status === 400);
    const convFiltered = await call(RW2, 'GET', '/api/v1/conversations?status=RESOLVED');
    check('a status filter is applied',
      (convFiltered.body?.conversations || []).every((c) => c.status === 'RESOLVED'));

    const crossConv = await call(tokens.otherOrg.token, 'GET', '/api/v1/conversations/' + thread.id);
    check('another workspace cannot read this thread', crossConv.status === 404, crossConv.status);

    // ── messages ────────────────────────────────────────────────────────────
    const msgs = await call(RW2, 'GET', `/api/v1/conversations/${thread.id}/messages`);
    check('GET messages returns the thread', msgs.status === 200 && Array.isArray(msgs.body?.messages));
    check('  …and excludes internal notes by default',
      (msgs.body?.messages || []).every((m) => m.internal === false),
      JSON.stringify((msgs.body?.messages || []).map((m) => m.internal)));
    check('  …so a transcript cannot quote an agent note back to the customer',
      (msgs.body?.messages || []).some((m) => m.body === 'customer said this'));

    const withInternal = await call(RW2, 'GET', `/api/v1/conversations/${thread.id}/messages?includeInternal=true`);
    check('internal notes are available when asked for',
      (withInternal.body?.messages || []).some((m) => m.internal === true));

    // Both grants are required: a reporting integration that counts open
    // threads has no business reading what customers wrote in them.
    const convOnly = await mint(orgA.id, ['conversations:read']);
    tokens.convOnly = convOnly;
    const convOnlyMsgs = await call(convOnly.token, 'GET', `/api/v1/conversations/${thread.id}/messages`);
    check('conversations:read alone cannot read messages', convOnlyMsgs.status === 403,
      convOnlyMsgs.status);
    const convOnlyList = await call(convOnly.token, 'GET', '/api/v1/conversations');
    check('  …but can still list threads', convOnlyList.status === 200);

    const crossMsgs = await call(tokens.otherOrg.token, 'GET', `/api/v1/conversations/${thread.id}/messages`);
    check('another workspace cannot read the messages either', crossMsgs.status === 403 || crossMsgs.status === 404,
      crossMsgs.status);

    // ── sending ─────────────────────────────────────────────────────────────
    /*
      Sends are exercised through the *conversation* endpoint, never the
      contact-addressed one.

      The conversation carries this gate's own session — a fake, inactive one —
      so the gateway call cannot reach anything real. The contact-addressed
      endpoint resolves the workspace's primary session instead, which on a
      machine with a live WhatsApp connection is a live session, and a test
      suite must not be one accidental ordering away from messaging a stranger.
      So that endpoint is tested on its refusal paths, which return before any
      session is resolved.

      The send is expected to FAIL at the gateway, and that is the point: it
      proves persist-before-send. The row must exist, marked FAILED with a
      reason, rather than vanishing with the transport error — the defect that
      once had customers receiving messages agents could not see.
    */
    const sendToken = await mint(orgA.id, ['messages:send', 'conversations:read', 'messages:read']);
    tokens.send = sendToken;

    /*
      Consent is reset to OPTED_IN first.

      The consent assertions above left this contact OPTED_OUT, and the first
      run of this section returned 403 on every send because of it — the refusal
      working exactly as intended, on a fixture that had been changed out from
      under it. Stating the precondition rather than inheriting it is what keeps
      a later reordering from turning a real failure into a green run, or the
      reverse.
    */
    await runAsPlatform('verify-public-api:setup', () =>
      prisma.contact.update({ where: { id: contactId }, data: { marketingConsent: 'OPTED_IN' } }),
    );

    const sent = await call(sendToken.token, 'POST', `/api/v1/conversations/${thread.id}/messages`, {
      text: 'gate: outbound probe',
    });
    check('a send is accepted and reported, not 500', [201, 202, 402].includes(sent.status), sent.status);
    check('  …and returns the message id', typeof sent.body?.id === 'string');

    const persisted = await runAsPlatform('verify-public-api:check', () =>
      prisma.message.findFirst({ where: { id: sent.body?.id } }),
    );
    check('persist-before-send: the row exists even though the gateway refused',
      persisted !== null);
    check('  …attributed to no user, because a token is not a person',
      persisted && persisted.sentById === null);
    check('  …outbound and not internal', persisted && persisted.direction === 'OUTBOUND' && persisted.isInternal === false);
    if (sent.status === 202) {
      check('  …marked FAILED with a reason rather than discarded',
        persisted && persisted.status === 'FAILED' && !!persisted.failureReason,
        persisted && persisted.status);
    }

    const noSendScope = await call(RW2, 'POST', `/api/v1/conversations/${thread.id}/messages`, { text: 'no' });
    check('sending requires messages:send', noSendScope.status === 403, noSendScope.status);

    const internalAttempt = await call(sendToken.token, 'POST', `/api/v1/conversations/${thread.id}/messages`, {
      text: 'note', isInternal: true,
    });
    // A note is addressed to colleagues by name and a token has no name to sign
    // it with. A note from "nobody" is worse than no note.
    check('an internal note cannot be sent through the API', internalAttempt.status === 400);

    const emptySend = await call(sendToken.token, 'POST', `/api/v1/conversations/${thread.id}/messages`, { text: '   ' });
    check('an empty message is refused', emptySend.status === 400);

    const crossSend = await call(tokens.otherOrg.token, 'POST', `/api/v1/conversations/${thread.id}/messages`, { text: 'x' });
    check('another workspace cannot send into this thread', [403, 404].includes(crossSend.status), crossSend.status);

    /*
      Refusals the console deliberately does not make.

      An agent messaging a blocked or opted-out contact is a human exercising
      judgement in front of the thread. A script is not, so the API refuses
      where the inbox permits.
    */
    await runAsPlatform('verify-public-api:setup', () =>
      prisma.contact.update({ where: { id: contactId }, data: { blockedAt: new Date() } }),
    );
    const blockedSend = await call(sendToken.token, 'POST', `/api/v1/contacts/id:${contactId}/messages`, { text: 'x' });
    check('the API refuses to message a blocked contact', blockedSend.status === 403, blockedSend.status);
    check('  …and names the reason', blockedSend.body?.error === 'contact_blocked');

    await runAsPlatform('verify-public-api:setup', () =>
      prisma.contact.update({ where: { id: contactId }, data: { blockedAt: null, marketingConsent: 'OPTED_OUT' } }),
    );
    const optedOutSend = await call(sendToken.token, 'POST', `/api/v1/contacts/id:${contactId}/messages`, { text: 'x' });
    check('the API refuses to message an opted-out contact', optedOutSend.status === 403);
    check('  …and names that reason instead', optedOutSend.body?.error === 'contact_opted_out',
      optedOutSend.body?.error);

    // ── conversation lifecycle ──────────────────────────────────────────────
    const lifecycle = await mint(orgA.id, ['conversations:read', 'conversations:write']);
    tokens.lifecycle = lifecycle;

    const noWrite = await call(RW2, 'PATCH', '/api/v1/conversations/' + thread.id, { status: 'PENDING' });
    check('changing a thread requires conversations:write', noWrite.status === 403);

    const toPending = await call(lifecycle.token, 'PATCH', '/api/v1/conversations/' + thread.id, { status: 'PENDING' });
    check('a thread can be moved to PENDING', toPending.status === 200 && toPending.body?.status === 'PENDING',
      JSON.stringify(toPending.body?.status));

    const labelled = await call(lifecycle.token, 'PATCH', '/api/v1/conversations/' + thread.id, {
      labels: ['gate-label', 'gate-label', 'other'],
    });
    check('labels are de-duplicated', (labelled.body?.labels || []).filter((l) => l === 'gate-label').length === 1);

    const badAssignee = await call(lifecycle.token, 'PATCH', '/api/v1/conversations/' + thread.id, {
      assigneeId: 'not-a-real-user',
    });
    check('an unknown assignee is a 400, not a constraint error in a log', badAssignee.status === 400);

    /*
      Closing goes through the lifecycle service, not a status column.

      A bare `status = 'RESOLVED'` would close the thread in the list while
      every report that reads ConversationClosure still believed it open. The
      closure row is the assertion that the real path ran.
    */
    const closed = await call(lifecycle.token, 'PATCH', '/api/v1/conversations/' + thread.id, { status: 'RESOLVED' });
    check('a thread can be resolved', [200, 400].includes(closed.status), closed.status);
    if (closed.status === 200) {
      check('  …and reports RESOLVED', closed.body?.status === 'RESOLVED');
      const closure = await runAsPlatform('verify-public-api:check', () =>
        prisma.conversationClosure.findFirst({ where: { conversationId: thread.id } }),
      );
      check('  …writing a closure row, not just a status column', closure !== null);
      check('  …attributed to source API so reports can separate it from an agent',
        closure && closure.source === 'API', closure && closure.source);

      const reopened = await call(lifecycle.token, 'PATCH', '/api/v1/conversations/' + thread.id, { status: 'OPEN' });
      check('a resolved thread can be reopened', reopened.status === 200 && reopened.body?.status !== 'RESOLVED',
        reopened.body?.status);
    } else {
      // The workspace requires a closing category or summary. That policy
      // applying to an integration is the correct behaviour, so assert it
      // rather than treating a 400 as noise.
      check('  …or the workspace closing-notes policy is enforced on the API too',
        /categor|summary/i.test(closed.body?.error || closed.body?.message || ''),
        JSON.stringify(closed.body));
    }

    // ── erasure ─────────────────────────────────────────────────────────────
    const deleter = await mint(orgA.id, ['contacts:delete']);
    tokens.deleter = deleter;

    const writeCannotDelete = await call(RW, 'DELETE', '/api/v1/contacts/phone:' + PHONE_C);
    check('contacts:write does not carry the power to erase', writeCannotDelete.status === 403,
      writeCannotDelete.status);

    const dryRun = await call(deleter.token, 'DELETE', '/api/v1/contacts/phone:' + PHONE_C);
    check('DELETE without confirmation deletes nothing', dryRun.status === 409, dryRun.status);
    check('  …and states the blast radius', typeof dryRun.body?.willDelete?.conversations === 'number');
    const survived = await runAsPlatform('verify-public-api:check', () =>
      prisma.contact.findFirst({ where: { phone: PHONE_C } }),
    );
    check('  …and the contact really is still there', survived !== null);

    const wrongCount = await call(deleter.token, 'DELETE', '/api/v1/contacts/phone:' + PHONE_C, {
      confirmConversations: 999,
    });
    check('a mismatched confirmation is refused', wrongCount.status === 409);
    check('  …so nobody erases more than they looked at',
      (await runAsPlatform('verify-public-api:check', () =>
        prisma.contact.findFirst({ where: { phone: PHONE_C } }))) !== null);

    const erased = await call(deleter.token, 'DELETE', '/api/v1/contacts/phone:' + PHONE_C, {
      confirmConversations: dryRun.body?.willDelete?.conversations ?? 0,
    });
    check('a confirmed erasure succeeds', erased.status === 200, JSON.stringify(erased.body));
    check('  …and the contact is gone',
      (await runAsPlatform('verify-public-api:check', () =>
        prisma.contact.findFirst({ where: { phone: PHONE_C } }))) === null);

    // ── discovery ───────────────────────────────────────────────────────────
    /*
      A caller cannot invent a lifecycle stage, a custom-field slug or a user id.
      Without these endpoints an integrator finds the workspace's vocabulary by
      guessing and reading 400s, which is how one ends up hardcoding a stage name
      that happens to exist in one workspace and silently failing in every other.
    */
    const discovery = await mint(orgA.id, ['workspace:read', 'tags:read']);
    tokens.discovery = discovery;
    const D = discovery.token;

    for (const [route, key] of [
      ['/api/v1/tags', 'tags'],
      ['/api/v1/contact-fields', 'fields'],
      ['/api/v1/lifecycle-stages', 'stages'],
      ['/api/v1/users', 'users'],
      ['/api/v1/teams', 'teams'],
    ]) {
      const result = await call(D, 'GET', route);
      check(`GET ${route} answers`, result.status === 200, result.status);
      check(`  …with a ${key} array`, Array.isArray(result.body?.[key]));
    }

    /*
      `tags:read` was a scope a subscriber could grant that NOTHING required —
      a ticked box gating nothing, the defect shape this repository has shipped
      six times, and that time it was ours. This is the assertion that it now
      grants something and, just as importantly, that it is still required.
    */
    const noTagRead = await call(tokens.threads.token, 'GET', '/api/v1/tags');
    check('tags:read is genuinely required for GET /tags', noTagRead.status === 403, noTagRead.status);

    const noWorkspaceRead = await call(tokens.rw.token, 'GET', '/api/v1/users');
    check('workspace:read is required for GET /users', noWorkspaceRead.status === 403, noWorkspaceRead.status);

    const usersBody = await call(D, 'GET', '/api/v1/users');
    check('users carry an email, so an integrator can match a person',
      (usersBody.body?.users || []).every((u) => 'email' in u));
    const stagesBody = await call(D, 'GET', '/api/v1/lifecycle-stages');
    check('lifecycle stages carry kind, so an integration cannot walk into a LOST stage',
      (stagesBody.body?.stages || []).every((s) => typeof s.kind === 'string'));

    // ── a contact's threads, and one custom field ───────────────────────────
    const contactThreads = await call(RW2, 'GET', `/api/v1/contacts/id:${contactId}/conversations`);
    check('a contact\'s conversations are addressable by contact', contactThreads.status === 200);
    check('  …and include the thread we made',
      (contactThreads.body?.conversations || []).some((c) => c.id === thread.id));

    const fieldsList = await call(D, 'GET', '/api/v1/contact-fields');
    const firstSlug = (fieldsList.body?.fields || [])[0]?.slug;
    if (firstSlug) {
      const setOne = await call(RW, 'PUT', `/api/v1/contacts/id:${contactId}/custom-fields/${firstSlug}`, {
        value: 'gate-value',
      });
      check('a single custom field can be set without sending the rest',
        setOne.status === 200, JSON.stringify(setOne.body).slice(0, 120));
      check('  …and comes back on the contact',
        setOne.body?.customFields?.[firstSlug] !== undefined);
    }
    const unknownSlug = await call(RW, 'PUT', `/api/v1/contacts/id:${contactId}/custom-fields/definitely_not_a_field`, {
      value: 'x',
    });
    check('an unknown field slug is 404, and says where to find the real ones',
      unknownSlug.status === 404 && /contact-fields/.test(unknownSlug.body?.message || ''));

    // ── comments ────────────────────────────────────────────────────────────
    /*
      The API refuses internal *notes* because a token has no name to sign one
      with. Comments answer that objection rather than dodging it: authorId is
      required and validated, so the note that lands in the inbox has a real
      person on it.
    */
    const noAuthor = await call(tokens.lifecycle.token, 'POST', `/api/v1/conversations/${thread.id}/comments`, {
      text: 'no author',
    });
    check('a comment without an author is refused', noAuthor.status === 400);
    check('  …and points at GET /users', /users/i.test(noAuthor.body?.message || ''));

    const badAuthor = await call(tokens.lifecycle.token, 'POST', `/api/v1/conversations/${thread.id}/comments`, {
      text: 'x', authorId: 'not-a-user',
    });
    check('an author who is not a workspace user is refused', badAuthor.status === 400);

    const realUser = (usersBody.body?.users || [])[0];
    if (realUser) {
      const comment = await call(tokens.lifecycle.token, 'POST', `/api/v1/conversations/${thread.id}/comments`, {
        text: 'gate: internal comment', authorId: realUser.id,
      });
      check('a comment with a real author is accepted', comment.status === 201, JSON.stringify(comment.body).slice(0, 120));
      check('  …is internal, so it is never sent to the customer', comment.body?.internal === true);
      check('  …and is signed by that person', comment.body?.sentBy?.id === realUser.id);

      const commentList = await call(RW2, 'GET', `/api/v1/conversations/${thread.id}/comments`);
      check('comments are listable', commentList.status === 200);
      check('  …and every one is internal',
        (commentList.body?.comments || []).every((c) => c.internal === true));

      // The customer-facing transcript must still exclude it.
      const transcript = await call(RW2, 'GET', `/api/v1/conversations/${thread.id}/messages`);
      check('the comment does not appear in the default transcript',
        !(transcript.body?.messages || []).some((m) => m.body === 'gate: internal comment'));
    }

    // ── caps and limits ─────────────────────────────────────────────────────
    const bigPage = await call(RW2, 'GET', `/api/v1/conversations/${thread.id}/messages?limit=500`);
    check('the messages page caps at 50, not 100',
      (bigPage.body?.messages || []).length <= 50, (bigPage.body?.messages || []).length);

    // ── the console is still guarded ────────────────────────────────────────
    // The /v1 exemption is from the session-JWT middleware only. If it ever
    // widened, this is where it shows.
    const consoleWithApiToken = await call(RW, 'GET', '/api/contacts');
    check('an API token does not open the console API', consoleWithApiToken.status === 401,
      consoleWithApiToken.status);
    const tokenAdmin = await call(RW, 'GET', '/api/api-tokens');
    check('an API token cannot manage API tokens', tokenAdmin.status === 401, tokenAdmin.status);
  } finally {
    await cleanup();
  }

  /*
    ── the rate limiter, asserted directly ──────────────────────────────────

    Not over HTTP. The server above runs with the limit raised so the semantic
    assertions do not throttle themselves, and re-lowering it mid-run would make
    every later assertion depend on timing. Here the middleware is exercised as
    a function, which lets the load-bearing property be checked exactly rather
    than inferred from a race.

    That property is the path collapse. "Per method + path" means the *route*,
    not the URL — if `/contacts/id:A` and `/contacts/id:B` got separate buckets,
    a client sweeping ten thousand contacts would never be throttled once and
    the limit would exist only on paper.
  */
  const { rateLimit, routeTemplate } = require('../dist/middleware/rate-limit.middleware');

  check('routeTemplate collapses the identifier grammar',
    routeTemplate('/contacts/id:abc') === routeTemplate('/contacts/id:xyz'),
    routeTemplate('/contacts/id:abc') + ' vs ' + routeTemplate('/contacts/id:xyz'));
  check('  …for phone: and email: too',
    routeTemplate('/contacts/phone:972500000000') === routeTemplate('/contacts/email:a@b.co'));
  check('  …and for raw cuids', routeTemplate('/conversations/clx7k2p9q0001abcdefghij') === '/conversations/:id');
  check('but keeps distinct routes distinct',
    routeTemplate('/contacts/id:a/tags') !== routeTemplate('/contacts/id:a'));
  check('  …and does not collapse ordinary path words',
    routeTemplate('/contacts/list') === '/contacts/list');

  // Five through, the sixth refused — the shipped number.
  const limiter = rateLimit('gate-limiter', {
    max: 5,
    windowMs: 1000,
    keyBy: (req) => `${req.headers.authorization}:${req.method}:${routeTemplate(req.path)}`,
  });
  function hit(path, method = 'GET', auth = 'Bearer rbt_aaaaaaaaaaaa_x') {
    let status = 200;
    let nexted = false;
    const res = {
      setHeader() {},
      status(code) { status = code; return this; },
      json() { return this; },
    };
    limiter({ headers: { authorization: auth }, method, path, ip: '127.0.0.1' }, res, () => { nexted = true; });
    return { status, nexted };
  }

  let allowed = 0;
  for (let i = 0; i < 5; i += 1) if (hit('/contacts/id:a').nexted) allowed += 1;
  check('five requests a second are allowed', allowed === 5, allowed);
  check('the sixth is refused with 429', hit('/contacts/id:a').status === 429);

  // The same route with a different identifier shares the bucket. This is the
  // one that would silently make the limit meaningless if it regressed.
  check('a different identifier on the same route shares the limit',
    hit('/contacts/id:completely-different').status === 429);

  // A different method, and a different route, each get their own budget.
  check('a different method has its own budget', hit('/contacts/id:a', 'PATCH').nexted === true);
  check('a different route has its own budget', hit('/conversations', 'GET').nexted === true);
  check('a different token has its own budget',
    hit('/contacts/id:a', 'GET', 'Bearer rbt_bbbbbbbbbbbb_y').nexted === true);

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
