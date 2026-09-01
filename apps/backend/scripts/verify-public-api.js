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
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DISABLE_MESSAGE_WORKER: '1',
      DISABLE_CAMPAIGN_WORKER: '1',
    },
    stdio: 'ignore',
  });

  const cleanup = async () => {
    child.kill('SIGKILL');
    await runAsPlatform('verify-public-api:cleanup', async () => {
      await prisma.contact.deleteMany({ where: { phone: { in: [PHONE_A, PHONE_B, PHONE_C] } } });
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
    tokens.otherOrg = await mint(orgB.id, ['contacts:read', 'contacts:write']);
    const RW = tokens.rw.token;

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
    check('an unmatched identifier is 404, not 500', missing.status === 404);

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

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
