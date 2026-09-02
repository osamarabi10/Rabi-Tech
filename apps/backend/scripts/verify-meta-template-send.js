/**
 * Meta template sending — the only way a Meta-only workspace can start a
 * conversation.
 *
 * ## What was broken
 *
 * Meta permits free-form messages only inside the 24-hour window that opens
 * when the *customer* writes. Outside it — which includes every contact who has
 * never written — an approved template is the sole permitted message.
 *
 * There was no template send path. `meta.client.ts` exported `sendTextMessage`
 * and `sendMediaMessage` and nothing else, and `MetaMessageTemplate` carried the
 * note *"Only the exact string APPROVED is sendable in a later phase."*
 *
 * GROWTH, BUSINESS and ENTERPRISE are `['WHATSAPP_CLOUD']` only. So this was not
 * a gap on a side channel — the three paying tiers could reply and could never
 * initiate.
 *
 * ## Why the guards are the subject here
 *
 * A rejected send is not free: it depresses the number's quality rating, which
 * governs its messaging tier. So everything checkable is checked locally, and
 * this gate is mostly about proving those refusals happen *before* the provider
 * call rather than after it.
 *
 * Hermetic: pure functions plus the refusal ordering. No Postgres, no network,
 * and no send is ever attempted.
 */
const fs = require('fs');
const path = require('path');

const {
  buildComponents,
  bodyPlaceholderCount,
} = require('../dist/modules/meta-templates/meta-template-send.service');
const { isMetaTemplateSendable } = require('../dist/modules/meta-templates/meta-templates.service');

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

function main() {
  // ── the send call exists at all ──────────────────────────────────────────
  const client = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'modules', 'channels', 'meta.client.js'), 'utf8');
  check('meta.client exports a template send', client.includes('sendTemplateMessage'));
  check('  …posting type: template', /type:\s*['"]template['"]/.test(client));
  check('  …with a language code', client.includes('language'));

  /*
    Components are omitted entirely when empty.

    Meta rejects `components: []` on a template that declares no variables,
    which is most of them — so the common case is the one that would have
    failed.
  */
  check('components are omitted when there are none', buildComponents([]).length === 0);

  const one = buildComponents(['Sara']);
  check('one variable becomes one body component', one.length === 1 && one[0].type === 'body');
  check('  …carrying a text parameter',
    one[0].parameters[0].type === 'text' && one[0].parameters[0].text === 'Sara');
  const three = buildComponents(['a', 'b', 'c']);
  check('order is preserved, because {{1}} is positional',
    three[0].parameters.map((p) => p.text).join('') === 'abc');
  check('a very long value is truncated rather than rejected by Meta',
    buildComponents(['x'.repeat(5000)])[0].parameters[0].text.length === 1024);

  // ── placeholder counting ─────────────────────────────────────────────────
  /*
    A count mismatch is the most common way a template send fails, and Meta's
    error arrives only after the number has been charged a rejection.
  */
  const body = (text) => [{ type: 'BODY', text }];
  check('no placeholders counts zero', bodyPlaceholderCount(body('Hello there')) === 0);
  check('one placeholder counts one', bodyPlaceholderCount(body('Hi {{1}}')) === 1);
  check('two count two', bodyPlaceholderCount(body('Hi {{1}}, order {{2}}')) === 2);
  check('a repeated placeholder counts once, not twice',
    bodyPlaceholderCount(body('Hi {{1}}, bye {{1}}')) === 1,
    bodyPlaceholderCount(body('Hi {{1}}, bye {{1}}')));
  check('whitespace inside braces still counts', bodyPlaceholderCount(body('Hi {{ 1 }}')) === 1);
  check('a header placeholder is not counted as a body one',
    bodyPlaceholderCount([{ type: 'HEADER', text: '{{1}}' }, { type: 'BODY', text: 'plain' }]) === 0);
  check('malformed components count zero rather than throwing',
    bodyPlaceholderCount(null) === 0 && bodyPlaceholderCount('nonsense') === 0);

  // ── only APPROVED is sendable ────────────────────────────────────────────
  check('APPROVED is sendable', isMetaTemplateSendable('APPROVED', null) === true);
  for (const status of ['PENDING', 'REJECTED', 'DRAFT', 'PAUSED', 'DISABLED', 'approved']) {
    check(`${status} is not sendable`, isMetaTemplateSendable(status, null) === false);
  }
  check('an archived APPROVED template is not sendable',
    isMetaTemplateSendable('APPROVED', new Date()) === false);

  // ── the refusals happen before the provider call ─────────────────────────
  /*
    The ordering is the point. Every one of these is checkable locally, and
    letting Meta refuse instead costs the customer's own number its quality
    rating — which governs how many messages they may send at all.
  */
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'modules', 'meta-templates', 'meta-template-send.service.js'), 'utf8');
  const sendIndex = service.indexOf('sendTemplateMessage');

  for (const [label, marker] of [
    ['approved status', 'TEMPLATE_NOT_SENDABLE'],
    ['blocked contacts', 'CONTACT_BLOCKED'],
    ['opted-out contacts', 'CONTACT_OPTED_OUT'],
    ['variable count', 'VARIABLE_COUNT_MISMATCH'],
    ['a missing channel', 'NO_META_CHANNEL'],
  ]) {
    const at = service.indexOf(marker);
    check(`${label} is refused before the provider is called`,
      at !== -1 && at < sendIndex, at === -1 ? 'check missing' : 'happens after the send');
  }

  /*
    Consent, on the send that most needs it.

    A template send is business-initiated by definition — the customer has not
    written — so it is exactly the message an opted-out contact must not
    receive. This is the one refusal that protects somebody outside the company.
  */
  check('the opt-out refusal exists at all', service.includes('CONTACT_OPTED_OUT'));

  /*
    Reserved before sending, resolved after — the same persist-before-send rule
    the message path follows. A transport error after Meta accepted must not
    leave no record of a message the customer received.
  */
  const reserveAt = service.indexOf("'RESERVED'");
  check('the send is reserved before the provider call',
    reserveAt !== -1 && reserveAt < sendIndex);
  check('  …and marked SENT afterwards', service.indexOf("'SENT'") > sendIndex);
  check('  …or FAILED with a reason', service.includes("'FAILED'") && service.includes('failureReason'));

  // ── the per-24h recipient cap ────────────────────────────────────────────
  /*
    D-24's gap, closed. `maxUniqueRecipientsPer24h` was modelled, surfaced and
    enforced by nothing, and that was acceptable *only because* no
    business-initiated conversation could start. Template sending is what makes
    one start, so the reasoning expired the moment the send path landed.

    Read against dist rather than the TypeScript, like every ordering assertion
    above it: the property being checked is that a call happens, in a particular
    order, at run time. A call survives compilation, so dist is where it can be
    seen to survive. The two checks in verify-workflow-p2 that read TypeScript
    do so because a *cast* is erased and cannot be seen there at all — different
    kind of property, different artifact.
  */
  /*
    The CALL, never the declaration.

    The first draft of these checks looked for 'RECIPIENT_CAP_REACHED' and
    passed with the call site deleted — the guard was still declared, still
    contained the string, and reached by nothing. That is the ninth instance of
    this repository's own recurring defect, written into the gate meant to
    catch it, and only the mutation found it.

    So the declaration is located first and everything after it is what counts.
  */
  const capDecl = service.indexOf('async function assertWithinRecipientCap');
  const capCall = service.indexOf('assertWithinRecipientCap(', service.indexOf('\n', capDecl));
  check('the per-24h recipient cap is enforced',
    capDecl !== -1 && capCall !== -1,
    'D-24: maxUniqueRecipientsPer24h is declared but nothing calls it');
  check('  …before the provider is called',
    capCall !== -1 && capCall < sendIndex,
    'a cap checked after the send has already spent the slot');
  check('  …and before the reservation, which would otherwise count itself',
    capCall !== -1 && capCall < reserveAt);
  check('  …refusing with a named code rather than a bare throw',
    service.includes('RECIPIENT_CAP_REACHED'));

  /*
    Unique recipients, not sends. Meta caps distinct customers a business opens
    a conversation with, so a second template to somebody already inside the
    window must cost nothing — refusing the follow-up while allowing the first
    contact is backwards.
  */
  check('  …counting distinct recipients rather than sends',
    service.includes("distinct:") && service.includes('recipientPhone'));

  /*
    Released reservations do not count. A send Meta refused opened no
    conversation and must return its slot; the model already carried releasedAt
    for this, so the cap reads it rather than storing anything new.
  */
  check('  …excluding released reservations, so a refused send returns its slot',
    service.includes('releasedAt: null'));

  /*
    The ceiling comes from the published capability, not from re-deriving it out
    of messagingTier here. That mapping lives in meta.adapter.ts, and a second
    copy would be free to disagree with the number the console shows.
  */
  check('  …reading the ceiling from the published capability',
    service.includes('channelCapabilities'),
    're-deriving it from messagingTier would be a second source of truth');

  // ── it is reachable ──────────────────────────────────────────────────────
  /*
    The defect shape this repository has shipped eight times: something that
    works and nothing that can reach it.
  */
  const routes = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'meta-templates', 'meta-templates.routes.ts'), 'utf8');
  check('a route exposes it', routes.includes("'/:id/send'"));
  check('  …guarded by conversation:create, the permission that governs messaging',
    /\/:id\/send['"],\s*requirePermission\(['"]conversation:create['"]\)/.test(routes));

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main();
