/**
 * Collaborators, and the mention toggle that must actually change behaviour.
 *
 * ## Why this gate exists
 *
 * `mentionAddsCollaborator` shipped as a column that nothing read — instance
 * nine of declared-but-unreachable in this repository, and it was written while
 * auditing for exactly that pattern. A setting a subscriber can flip that does
 * nothing is worse than an absent one: they flip it, believe it took effect,
 * and build a working habit on a behaviour that is not there.
 *
 * So this asserts the toggle is **read on the mention path**, that the path
 * enforces the same rules as the explicit route, and that the ceiling is shared
 * rather than duplicated — because a second door onto the same table that skips
 * the cap turns a limit into a suggestion.
 *
 * ## Structural checks are not enough here, and the first version proved it
 *
 * This file initially asserted only that the source contained `if (shouldAdd)`.
 * Mutating the compiled output to `if (true)` — the toggle stored and
 * ignored, precisely the defect — left it green, because a source assertion
 * cannot see a behaviour change. So the second half **runs the function** with
 * the toggle on and off and looks at the table.
 *
 * That half needs the database. The structural half stays because it catches a
 * different thing: a second door that skips the cap, which no single call can
 * demonstrate.
 */
require('./load-env');

const fs = require('fs');
const path = require('path');

const { MAX_COLLABORATORS_PER_CONVERSATION } = require('../dist/modules/conversations/collaborator-limits');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('[PASS] ' + label); }
  else { failed += 1; console.log('[FAIL] ' + label + (detail !== undefined ? ' — ' + detail : '')); }
}

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

async function main() {
  check('the ceiling is nine, matching theirs', MAX_COLLABORATORS_PER_CONVERSATION === 9,
    MAX_COLLABORATORS_PER_CONVERSATION);

  // ── the toggle is READ, not merely stored ────────────────────────────────
  const notifications = read('dist', 'utils', 'notification-service.js');
  check('the mention path reads mentionAddsCollaborator',
    notifications.includes('mentionAddsCollaborator'),
    'the column is stored and never consulted — the defect this gate exists for');

  /*
    Read BEFORE the loop that adds people, not inside it. One row, and the
    answer cannot change between two names in the same comment — but the
    ordering is what proves it gates the add rather than being fetched and
    ignored.
  */
  const readAt = notifications.indexOf('mentionAddsCollaborator');
  const addAt = notifications.indexOf('addMentionedCollaborator');
  check('  …and the add is gated on it', readAt !== -1 && addAt !== -1 && readAt < addAt);

  const source = read('src', 'utils', 'notification-service.ts');
  check('the add is conditional, not unconditional',
    /if \(shouldAdd\)/.test(source), 'every mention would add a collaborator');

  // ── the second door obeys the same rules ─────────────────────────────────
  /*
    The mention path is a second door onto ConversationCollaborator. A door that
    skips the rules is how a nine-collaborator cap becomes a suggestion and how
    an assignee ends up listed as their own collaborator.
  */
  check('the mention path enforces the ceiling',
    source.includes('MAX_COLLABORATORS_PER_CONVERSATION'), 'the cap is not checked on this path');
  check('  …excluding the assignee, who already has the thread',
    /assignedToId === userId/.test(source));
  check('  …and upserts, so mentioning twice is not an error',
    /conversationCollaborator\.upsert/.test(source));

  // ── the cap is shared, not copied ────────────────────────────────────────
  const routes = read('src', 'modules', 'conversations', 'conversations.routes.ts');
  check('the explicit route imports the shared ceiling',
    routes.includes("from './collaborator-limits'"), 'the two doors can drift apart');
  check('  …rather than defining its own number',
    !/const MAX_COLLABORATORS = 9;/.test(routes));

  // ── failure must not break the note ──────────────────────────────────────
  /*
    This runs inside a fire-and-forget path attached to an agent writing a
    comment. A note that fails to save because the thread already had nine
    collaborators would be a worse outcome than a mention that notified without
    adding.
  */
  // `\r?\n`, for the same reason as the Meta filename assertion in the tenancy
  // harness: a bare `\n` makes this pass on an LF working tree and fail on a
  // CRLF checkout of identical content. Found by auditing the class after one
  // instance surfaced, rather than waiting for this one to surface too.
  check('a failed add cannot fail the comment',
    /catch \{[\s\S]*?\}\r?\n\}/.test(source.slice(source.indexOf('addMentionedCollaborator'))),
    'the add is not wrapped');

  // ── removal keeps their rule ─────────────────────────────────────────────
  /*
    "Any collaborator or the assignee can remove a collaborator — there's no
     restriction on who can remove whom." Copied whole, so the delete route
     must NOT gain a who-is-removing check later.
  */
  const deleteBlock = routes.slice(routes.indexOf("router.delete('/:id/collaborators/:userId'"));
  check('removal checks nothing about who is removing',
    !/req\.user!\.id ===|isCollaborator|canRemove/.test(deleteBlock.slice(0, 900)));

  // ── behaviour: the toggle decides, and is observed deciding ──────────────
  await behaviourChecks();

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

/**
 * Call notifyMentioned with the toggle off, then on, and read the table.
 *
 * The only assertion that would have caught `if (true)`. Everything it creates
 * is removed on the way out, including on failure.
 */
async function behaviourChecks() {
  const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
  const { prisma } = require('../dist/prisma');
  const { notifyMentioned } = require('../dist/utils/notification-service');

  const setup = await runAsPlatform('verify-collaborators', async () => {
    /*
      A workspace with at least two active users, not simply the first one.

      One person cannot demonstrate this: notifyMentioned excludes the author
      from their own mention, so a single-user workspace can never produce a
      collaborator and the test would pass for the wrong reason. Chosen by
      capability rather than by id, and ordered so the choice is stable between
      runs — an unordered pick is what made the finance gate fail intermittently.
    */
    const candidates = await prisma.user.groupBy({
      by: ['organizationId'],
      where: { isActive: true },
      _count: { _all: true },
      orderBy: { organizationId: 'asc' },
    });
    const chosen = candidates.find((row) => row._count._all >= 2);
    if (!chosen) throw new Error('no workspace has two active users; cannot demonstrate the toggle');
    const org = { id: chosen.organizationId };

    const users = await prisma.user.findMany({
      where: { organizationId: org.id, isActive: true },
      orderBy: { id: 'asc' }, take: 2, select: { id: true },
    });

    const session = await prisma.whatsappSession.create({
      // Explicit workspace: platform scope injects nothing.
      data: { organizationId: org.id, workspaceId: 'ws_' + org.id, sessionName: 'collab-gate-' + Date.now(), label: 'gate', isActive: false },
      select: { id: true },
    });
    const contact = await prisma.contact.create({
      data: { organizationId: org.id, workspaceId: 'ws_' + org.id, phone: '99903' + String(Date.now()).slice(-9) },
      select: { id: true },
    });
    const conversation = await prisma.conversation.create({
      data: {
        organizationId: org.id,
        workspaceId: 'ws_' + org.id,
        displayId: 950000 + (Date.now() % 1000),
        contactId: contact.id,
        sessionId: session.id,
        status: 'OPEN',
        // Deliberately NOT assigned to the mentioned user — the assignee is
        // excluded from collaborators, which would mask the result.
        assignedToId: null,
      },
      select: { id: true },
    });
    const before = await prisma.organizationConfig.findUnique({
      where: { organizationId: org.id }, select: { mentionAddsCollaborator: true },
    });
    return { org, users, session, contact, conversation, before };
  });

  const { org, users, conversation } = setup;
  const author = users[0].id;
  const mentioned = users[1].id;

  const setToggle = (value) => runAsPlatform('verify-collaborators:toggle', () =>
    prisma.organizationConfig.update({
      where: { organizationId: org.id },
      data: { mentionAddsCollaborator: value },
    }));

  const collaboratorCount = () => runAsPlatform('verify-collaborators:count', () =>
    prisma.conversationCollaborator.count({ where: { conversationId: conversation.id } }));

  try {
    // OFF: a mention notifies and adds nobody.
    await setToggle(false);
    await runAsOrganization(org.id, () =>
      notifyMentioned(conversation.id, [mentioned], author, 'Gate'));
    check('with the toggle OFF a mention adds no collaborator',
      (await collaboratorCount()) === 0, 'count was ' + (await collaboratorCount()));

    // ON: the same call adds them.
    await setToggle(true);
    await runAsOrganization(org.id, () =>
      notifyMentioned(conversation.id, [mentioned], author, 'Gate'));
    const after = await collaboratorCount();
    check('with the toggle ON the same mention adds one', after === 1, 'count was ' + after);

    // And mentioning again does not add a second row.
    await runAsOrganization(org.id, () =>
      notifyMentioned(conversation.id, [mentioned], author, 'Gate'));
    check('  …and mentioning twice is not an error or a duplicate',
      (await collaboratorCount()) === 1);
  } finally {
    await runAsPlatform('verify-collaborators:cleanup', async () => {
      await prisma.conversationCollaborator.deleteMany({ where: { conversationId: conversation.id } });
      await prisma.notification.deleteMany({ where: { conversationId: conversation.id } });
      await prisma.conversation.deleteMany({ where: { id: conversation.id } });
      await prisma.contact.deleteMany({ where: { id: setup.contact.id } });
      await prisma.whatsappSession.deleteMany({ where: { id: setup.session.id } });
      // Restore whatever the workspace had, so the gate leaves no setting behind.
      await prisma.organizationConfig.update({
        where: { organizationId: org.id },
        data: { mentionAddsCollaborator: setup.before?.mentionAddsCollaborator ?? false },
      });
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
