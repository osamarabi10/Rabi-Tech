/**
 * Saved views: the two decisions that are worth a permanent gate.
 *
 * **Filter validation.** The filter is user input stored as JSON. A malformed
 * one that reaches the client breaks the inbox for everyone who can see the
 * view, and for a shared view that is the whole workspace. Unknown keys are
 * rejected rather than ignored — silently dropping a key someone typed leaves
 * them with a view that does not filter the way they believe it does.
 *
 * Broadcast routing is deliberately NOT covered here. It is enforced instead by
 * the tenancy gate, which statically audits every emit site in the codebase for
 * an organization-prefixed room — a stronger guarantee than a unit test over one
 * module, and the reason that room is built inline at the emit site rather than
 * behind a helper this file could import.
 *
 * A pure function, so this needs no server, no database and no token. It runs
 * against the compiled output the server actually runs, for the same reason the
 * finance check does.
 */
// No `./load-env` here, deliberately. This gate reaches only
// `lib/inbox-view-filter`, which reads no environment variable at all, so it is
// hermetic — it cannot fail for a reason that has nothing to do with the code.
// Loading an environment a check does not use is how that property gets lost
// quietly. See the note in `load-env.js`, and D-12.
const assert = require('assert');

const { validateInboxViewFilter, InboxViewFilterError } = require('../dist/lib/inbox-view-filter');

let pass = 0;
let fail = 0;

function check(label, fn) {
  try {
    fn();
    pass++;
    console.log('[PASS] ' + label);
  } catch (err) {
    fail++;
    console.log('[FAIL] ' + label + ' — ' + (err && err.message ? err.message : err));
  }
}

/**
 * Assert a filter is refused, that the reported key is right, and that the
 * message names something the author can act on.
 *
 * `mentions` defaults to the key, but a few messages usefully name the offending
 * *value* instead — «CLOSED» tells someone more than «status» does.
 */
function rejects(filter, key, mentions) {
  let thrown = null;
  try {
    validateInboxViewFilter(filter);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected a rejection, got none');
  assert.ok(thrown instanceof InboxViewFilterError, 'wrong error type: ' + thrown.name);
  if (key !== undefined) {
    assert.strictEqual(thrown.key, key, 'wrong key reported: ' + thrown.key);
    const needle = mentions === undefined ? key.split('.').pop() : mentions;
    assert.ok(
      thrown.message.includes(needle),
      'the message does not name ' + needle + ': ' + thrown.message,
    );
  }
}

console.log('--- filter validation ---');

check('an unknown top-level key is rejected and named', () => {
  rejects({ status: ['OPEN'], slaStatus: 'breached' }, 'slaStatus');
});

check('an unknown key nested in assignee is rejected and named', () => {
  rejects({ assignee: { userIds: ['u1'], somethingElse: true } }, 'assignee');
});

check('a status outside this product\'s enum is rejected', () => {
  // CLOSED is the status the original brief assumed. It does not exist here.
  // The message names the value, not the key: «CLOSED» tells the author more
  // than «status» does when the key itself was fine.
  rejects({ status: ['CLOSED'] }, 'status', 'CLOSED');
});

check('every status this product does have is accepted', () => {
  const all = ['OPEN', 'PENDING', 'RESOLVED', 'AWAITING_CLIENT'];
  assert.deepStrictEqual(validateInboxViewFilter({ status: all }).status, all);
});

check('a scalar where a list belongs is rejected', () => {
  rejects({ teamIds: 'not-an-array' }, 'teamIds');
});

check('a list of non-strings is rejected', () => {
  rejects({ labels: [1, 2] }, 'labels');
});

check('a filter that is not an object at all is rejected', () => {
  rejects([]);
  rejects(null);
  rejects('OPEN');
});

check('an over-long list is rejected rather than stored', () => {
  rejects({ labels: Array.from({ length: 51 }, (_, i) => 'label-' + i) }, 'labels');
});

check('an over-long value is rejected rather than stored', () => {
  rejects({ labels: ['x'.repeat(201)] }, 'labels');
});

check('assignee accepts the two per-viewer forms and a list', () => {
  assert.strictEqual(validateInboxViewFilter({ assignee: 'me' }).assignee, 'me');
  assert.strictEqual(validateInboxViewFilter({ assignee: 'unassigned' }).assignee, 'unassigned');
  assert.deepStrictEqual(
    validateInboxViewFilter({ assignee: { userIds: ['u1', 'u2'] } }).assignee,
    { userIds: ['u1', 'u2'] },
  );
});

check('an assignee that is neither is rejected', () => {
  rejects({ assignee: 'everyone' }, 'assignee');
  rejects({ assignee: 42 }, 'assignee');
});

check('empty lists and false flags are dropped, not stored', () => {
  // Both already mean "no constraint". Storing them would preserve a
  // distinction with no meaning that the evaluator would have to keep
  // pretending to honour.
  const out = validateInboxViewFilter({
    status: [],
    labels: [],
    unansweredOnly: false,
    includeSnoozed: false,
  });
  assert.deepStrictEqual(out, {});
});

check('true flags are kept', () => {
  assert.deepStrictEqual(
    validateInboxViewFilter({ unansweredOnly: true, includeSnoozed: true }),
    { unansweredOnly: true, includeSnoozed: true },
  );
});

check('a non-boolean flag is rejected rather than coerced', () => {
  // 'false' and 0 are both truthy-or-falsy in ways that would silently produce
  // the opposite filter.
  rejects({ unansweredOnly: 'false' }, 'unansweredOnly');
  rejects({ includeSnoozed: 1 }, 'includeSnoozed');
});

check('values are trimmed and deduplicated', () => {
  assert.deepStrictEqual(
    validateInboxViewFilter({ labels: ['a', 'a', ' b ', '', '  '] }).labels,
    ['a', 'b'],
  );
});

check('the returned filter is a fresh object, not the caller\'s', () => {
  const input = { status: ['OPEN'] };
  const out = validateInboxViewFilter(input);
  assert.notStrictEqual(out, input);
  assert.notStrictEqual(out.status, input.status);
});

console.log('\n' + pass + '/' + (pass + fail) + ' checks passed.');
process.exit(fail === 0 ? 0 : 1);
