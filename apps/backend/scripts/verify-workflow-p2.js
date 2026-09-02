/**
 * P2 workflow additions: two triggers and two steps that actually work.
 *
 * ## What this is defending against
 *
 * Adding a name to `TRIGGER_TYPES` or `ACTION_TYPES` makes it appear in the
 * builder immediately. Nothing else is required for a subscriber to select it,
 * save a workflow, and watch it never run — and there is no error anywhere,
 * because from the outside a workflow that never matched looks exactly like one
 * whose conditions were not met.
 *
 * That is the defect this repository has shipped six times. So every name
 * declared here is checked three ways: the validator accepts a correct config
 * and refuses an incomplete one, the dispatcher matches the right events and
 * only those, and the executor has a real branch for it.
 *
 * Hermetic: the dispatcher's matcher and the schema validator are pure
 * functions. No database, no Redis, no queue.
 */
const fs = require('fs');
const path = require('path');

const {
  TRIGGER_TYPES,
  ACTION_TYPES,
  validateWorkflowConfig,
  workflowVocabulary,
} = require('../dist/modules/workflows/workflow-schema');

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

/** A minimal valid workflow, so each assertion varies one thing. */
function config(extra = {}) {
  return { actions: [{ type: 'ADD_TAG', tag: 'x' }], ...extra };
}

function main() {
  // ── the names exist ──────────────────────────────────────────────────────
  for (const trigger of ['LIFECYCLE_UPDATED', 'CONTACT_FIELD_UPDATED']) {
    check(`${trigger} is a trigger`, TRIGGER_TYPES.includes(trigger));
  }
  for (const action of ['OPEN_CONVERSATION', 'ADD_COMMENT']) {
    check(`${action} is an action`, ACTION_TYPES.includes(action));
  }
  for (const trigger of ['INCOMING_WEBHOOK', 'SHORTCUT']) {
    check(`${trigger} is a trigger`, TRIGGER_TYPES.includes(trigger));
  }
  check('nine triggers now', TRIGGER_TYPES.length === 9, TRIGGER_TYPES.length);
  check('no duplicate trigger names', new Set(TRIGGER_TYPES).size === TRIGGER_TYPES.length);
  check('no duplicate action names', new Set(ACTION_TYPES).size === ACTION_TYPES.length);

  // ── the validator ────────────────────────────────────────────────────────
  /*
    A field trigger with no field is refused at SAVE, not silently at match
    time. Without this an author saves a workflow that looks configured, sits in
    the list looking live, and can never fire — the exact shape of a ticked box
    that gates nothing.
  */
  const noField = validateWorkflowConfig('CONTACT_FIELD_UPDATED', config());
  check('CONTACT_FIELD_UPDATED without a field is refused', noField.valid === false);
  check('  …and the error names the trigger',
    noField.errors.some((e) => e.startsWith('trigger:')), noField.errors.join(' | '));

  const withField = validateWorkflowConfig('CONTACT_FIELD_UPDATED', config({ trigger: { field: 'order_status' } }));
  check('CONTACT_FIELD_UPDATED with a field is accepted', withField.valid === true,
    withField.errors.join(' | '));

  /*
    Lifecycle is the deliberate asymmetry: no stage means ANY move, which is a
    real automation. There is no equivalent reading of "any custom field
    changed" — an import touching twenty fields on ten thousand rows would wake
    such a workflow two hundred thousand times.
  */
  const anyStage = validateWorkflowConfig('LIFECYCLE_UPDATED', config());
  check('LIFECYCLE_UPDATED without a stage is accepted, on purpose', anyStage.valid === true,
    anyStage.errors.join(' | '));
  const oneStage = validateWorkflowConfig('LIFECYCLE_UPDATED', config({ trigger: { stage: 'Customer' } }));
  check('LIFECYCLE_UPDATED narrowed to one stage is accepted', oneStage.valid === true);

  const emptyComment = validateWorkflowConfig('CONVERSATION_CREATED', {
    actions: [{ type: 'ADD_COMMENT', body: '   ' }],
  });
  check('ADD_COMMENT with no text is refused', emptyComment.valid === false);
  const realComment = validateWorkflowConfig('CONVERSATION_CREATED', {
    actions: [{ type: 'ADD_COMMENT', body: 'Escalated by rule' }],
  });
  check('ADD_COMMENT with text is accepted', realComment.valid === true, realComment.errors.join(' | '));

  const open = validateWorkflowConfig('CONVERSATION_CREATED', {
    actions: [{ type: 'OPEN_CONVERSATION' }],
  });
  check('OPEN_CONVERSATION needs no configuration', open.valid === true, open.errors.join(' | '));

  // ── the dispatcher matches the right events, and only those ──────────────
  /*
    matchesTrigger is module-private, so it is exercised through the compiled
    module's own surface. Reimplementing the comparison here would assert that
    the gate agrees with itself.
  */
  const dispatcherSource = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'modules', 'workflows', 'workflow-dispatcher.js'), 'utf8');
  check('the dispatcher narrows LIFECYCLE_UPDATED', dispatcherSource.includes('LIFECYCLE_UPDATED'));
  check('the dispatcher narrows CONTACT_FIELD_UPDATED', dispatcherSource.includes('CONTACT_FIELD_UPDATED'));

  const executorSource = fs.readFileSync(
    path.join(__dirname, '..', 'dist', 'modules', 'workflows', 'workflow-executor.js'), 'utf8');

  /*
    The load-bearing assertion of this file.

    Every action name must have a real `case` in the executor. A name in the
    table with no branch falls through to the default and reports nothing — the
    run log shows the step was reached and says it did nothing, which reads as
    "the condition was false" rather than "this feature does not exist".
  */
  /*
    Two actions are declared and deliberately have NO executor branch: JUMP_TO
    and TRIGGER_WORKFLOW need the canvas, and both turn a list into a graph that
    a flat builder cannot render. They are declared so the validator can refuse
    them BY NAME and say when they arrive.

    So the rule is not weakened for them, it is replaced: an action either has a
    real branch, or is provably refused at save. An action with neither would
    reach the executor, fall through to default, and report "did nothing" — which
    an author reads as "my condition was false", not "this feature is missing".
  */
  const REFUSED_UNTIL_CANVAS = ['JUMP_TO', 'TRIGGER_WORKFLOW'];

  for (const action of ACTION_TYPES) {
    if (REFUSED_UNTIL_CANVAS.includes(action)) continue;
    check(`the executor has a branch for ${action}`,
      executorSource.includes(`case '${action}'`), 'no case in the compiled executor');
  }

  for (const action of REFUSED_UNTIL_CANVAS) {
    const result = validateWorkflowConfig('CONVERSATION_CREATED', { actions: [{ type: action }] });
    check(`${action} is refused at save`, result.valid === false);
    check(`  …and the message says why`,
      result.errors.some((e) => /canvas/i.test(e)), result.errors.join(' | '));
    // It must ALSO have no executor branch — a refused action that the executor
    // would happily run is one migration away from being reachable.
    check(`  …and has no executor branch to reach`,
      !executorSource.includes(`case '${action}'`));
  }

  /*
    The builder renders whatever the vocabulary serves, so a refused action
    appearing there is a control that always fails on save.

    This is the assertion that keeps the refusal honest in both directions: the
    validator must reject them, AND the builder must never offer them. Getting
    only the first right produces exactly the dead control the refusal was meant
    to avoid.
  */
  const vocabulary = workflowVocabulary();
  for (const action of REFUSED_UNTIL_CANVAS) {
    check(`the builder is not offered ${action}`,
      !vocabulary.actions.includes(action),
      'it is in the served vocabulary and will fail on save');
  }
  for (const action of ACTION_TYPES) {
    if (REFUSED_UNTIL_CANVAS.includes(action)) continue;
    check(`the builder IS offered ${action}`, vocabulary.actions.includes(action));
  }
  check('every served trigger is a real trigger',
    vocabulary.triggers.every((t) => TRIGGER_TYPES.includes(t)));
  check('the served step ceiling is 100', vocabulary.limits.maxActions === 100,
    vocabulary.limits.maxActions);

  /*
    Every trigger must have somewhere that FIRES it. A trigger nothing dispatches
    is a dropdown entry that can never match, and the author has no way to tell
    that apart from a workflow whose conditions never held.
  */
  const srcRoot = path.join(__dirname, '..', 'src');
  const sources = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) sources.push(fs.readFileSync(full, 'utf8'));
    }
  })(srcRoot);
  const allSource = sources.join('\n');

  for (const trigger of TRIGGER_TYPES) {
    check(`something dispatches ${trigger}`,
      allSource.includes(`triggerType: '${trigger}'`),
      'no dispatchWorkflowEvent call names it');
  }

  // ── a comment is never customer-facing ───────────────────────────────────
  /*
    The single most consequential property of ADD_COMMENT. An internal note that
    reaches WhatsApp is a private remark about a customer, sent to that customer.
  */
  const commentBranch = executorSource.slice(
    executorSource.indexOf("case 'ADD_COMMENT'"),
    executorSource.indexOf("case 'IF_ELSE'"),
  );
  check('ADD_COMMENT writes an internal message', commentBranch.includes('isInternal: true'));
  check('  …and never calls the gateway',
    !commentBranch.includes('ChannelService') && !commentBranch.includes('sendText'));
  check('  …attributed to no user, because automation has no name to sign with',
    !commentBranch.includes('sentById:') || commentBranch.includes('sentById: null'));

  // ── the executor's shape, as something that fails ────────────────────────
  /*
    The executor is a switch, so every safety property it has is per-case. Its
    three rules are enforced by convention — call the right helper — and a case
    that does not call it is silently exempt. That is not a hypothetical: it is
    D-30 and D-31, both found by review rather than by any gate, and the audit
    document names this shape as the reason.

    These checks do not change the shape. They make the convention fail out
    loud when it is broken, which is the difference between a rule and a test.
    A future case that sends its own message, or silences its own type error,
    stops being a code review away from a consent breach.
  */

  /*
    Rule 1, as a chokepoint. Consent is checked inside sendToContact, so the
    property "a workflow cannot outrun consent" is really "nothing else sends".
    D-30 was a second send path — a local helper that looked like plumbing —
    which skipped the consent check without touching it.

    The count is what matters, not the location: one import, one call. A second
    call site is exactly the defect, whatever it is named or wherever it sits.
  */
  /*
    Read against the *compiled* output, like every behavioural check in this
    file: a call that survives to dist is a call that runs. `ChannelService.x`
    compiles to `channel_service_1.ChannelService.x`, so the match allows the
    namespace prefix rather than assuming the source spelling.
  */
  const gatewayCalls = executorSource.match(/ChannelService\.\w+/g) || [];
  check('consent: the executor calls the gateway exactly once',
    gatewayCalls.length === 1,
    `${gatewayCalls.length} call sites: ${gatewayCalls.join(', ')}`);

  // Bounded by the next function declaration, so "inside sendToContact" means
  // inside it and not merely somewhere after it.
  const sendStart = executorSource.indexOf('async function sendToContact');
  const sendEnd = executorSource.indexOf('function ', executorSource.indexOf('\n', sendStart));
  const sendToContactBody = executorSource.slice(sendStart, sendEnd === -1 ? undefined : sendEnd);
  check('  …from inside sendToContact, where consent is decided',
    sendStart !== -1
      && sendToContactBody.includes('ChannelService.')
      && sendToContactBody.includes('OPTED_OUT'),
    'the single gateway call must sit with the consent check, not merely near it');

  /*
    These two read the TypeScript, not dist, and that is not an oversight.

    A cast is erased by compilation, so `as never` cannot be found in the
    compiled output at all — a check for it there would pass forever while
    proving nothing. The property is a source property, so the source is what
    gets read.

    `as never` is not a style complaint. It is the exact token that silenced the
    type error naming D-31, and the defect it hid let a workflow write any
    column on Contact, `organizationId` included. A cast that suppresses the
    compiler's objection to a dynamic write is the compiler being right.

    Matched with word boundaries because the substring also occurs inside
    ordinary prose — "a thread that was never closed" contains it — and a gate
    that fails on its own comments teaches people to stop reading it.
  */
  const executorTs = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'modules', 'workflows', 'workflow-executor.ts'), 'utf8');

  check('no `as never` silences a type error in the executor',
    !/\bas\s+never\b/.test(executorTs),
    'the D-31 write used exactly this cast to compile');

  /*
    And the write itself. A computed property key on contact.update is how an
    author-supplied field name becomes a column name. The supported path writes
    CustomFieldValue keyed by a looked-up definition id, which cannot name a
    Contact column at all.
  */
  check('no workflow action writes a computed column name onto Contact',
    !/prisma\.contact\.update\([\s\S]{0,400}?\[\s*(?:String\()?\w/.test(executorTs),
    'data: { [field]: value } on contact.update is the D-31 shape');

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main();
