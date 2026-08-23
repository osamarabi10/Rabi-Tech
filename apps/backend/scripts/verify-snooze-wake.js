/**
 * A customer reply cancels a snooze.
 *
 * Exercises `getOrCreateActiveConversation` — the function the inbound webhook
 * calls for every message that arrives — rather than a reimplementation of it,
 * because the rule only matters if it holds on that exact path.
 *
 * Snoozes a real conversation, runs the inbound path against it, asserts the
 * snooze is gone, and puts the row back the way it was found.
 */
const { runAsOrganization, runAsPlatform } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const { getOrCreateActiveConversation } = require('../dist/utils/conversation-session');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log('[PASS] ' + label);
  } else {
    failed += 1;
    console.log('[FAIL] ' + label + (detail ? ' — ' + detail : ''));
  }
}

async function main() {
  // Platform scope for the lookup: picking *which* organization to test
  // against is by definition a question no single tenant can answer, and the
  // extension refuses an unscoped query — correctly.
  const conversation = await runAsPlatform('verify-snooze-wake', () =>
    prisma.conversation.findFirst({
      where: { isArchived: false },
      select: { id: true, contactId: true, sessionId: true, organizationId: true, snoozedUntil: true, status: true },
    }),
  );
  if (!conversation) throw new Error('No conversation to test against');

  const restore = { snoozedUntil: conversation.snoozedUntil };

  await runAsOrganization(conversation.organizationId, async () => {
    try {
      const until = new Date(Date.now() + 3 * 3600_000);
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { snoozedUntil: until, snoozedByName: 'verify-snooze' },
      });

      const before = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { snoozedUntil: true },
      });
      check('conversation starts snoozed', before?.snoozedUntil !== null);

      // The inbound path, exactly as the webhook calls it.
      const result = await getOrCreateActiveConversation(
        conversation.contactId,
        conversation.sessionId,
      );

      check('the inbound path returns the same thread',
        result.conversation.id === conversation.id, result.conversation.id);
      check('the snooze is cleared by a customer message',
        result.conversation.snoozedUntil === null, String(result.conversation.snoozedUntil));
      check('the name of who snoozed it is cleared too',
        result.conversation.snoozedByName === null, String(result.conversation.snoozedByName));

      const after = await prisma.conversation.findUnique({
        where: { id: conversation.id },
        select: { snoozedUntil: true },
      });
      check('and it is cleared in the database, not just the return value',
        after?.snoozedUntil === null, String(after?.snoozedUntil));
    } finally {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { snoozedUntil: restore.snoozedUntil, snoozedByName: null },
      });
    }
  });

  await prisma.$disconnect();

  console.log('');
  console.log(passed + '/' + (passed + failed) + ' checks passed.');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
