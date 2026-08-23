/**
 * A broadcast's reply count and the list behind it are the same set.
 *
 * The campaign table shows "3 replied (60%)" and that number is now a link to
 * the threads. If the two are computed separately they drift, and a count that
 * does not match the rows it opens is worse than no count at all — so both go
 * through `campaignRepliedContactWhere`, and this proves it on real rows.
 *
 * Fabricates a campaign, two recipients and one reply; asserts; deletes
 * everything it made, including on failure.
 */
const { runAsPlatform, runAsOrganization } = require('../dist/lib/tenant-context');
const { prisma } = require('../dist/prisma');
const { campaignRepliedContactWhere } = require('../dist/modules/analytics/reporting.service');

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
  // Which organization to borrow is a question no tenant can answer.
  const seed = await runAsPlatform('verify-campaign-replies', async () => {
    const conversation = await prisma.conversation.findFirst({
      where: { isArchived: false },
      select: { id: true, organizationId: true, contactId: true, sessionId: true },
    });
    if (!conversation) return null;

    const other = await prisma.contact.findFirst({
      where: { organizationId: conversation.organizationId, id: { not: conversation.contactId } },
      select: { id: true },
    });
    const session = await prisma.whatsappSession.findFirst({
      where: { organizationId: conversation.organizationId },
      select: { id: true },
    });
    return { conversation, otherContactId: other?.id ?? null, sessionId: session?.id ?? null };
  });

  if (!seed) throw new Error('No conversation to test against');
  const { conversation, otherContactId } = seed;
  const organizationId = conversation.organizationId;

  const made = { campaignId: null, messageId: null, recipientIds: [] };

  await runAsOrganization(organizationId, async () => {
    try {
      const sentAt = new Date(Date.now() - 3600_000);

      const campaign = await prisma.campaign.create({
        data: {
          organizationId,
          title: 'verify-campaign-replies',
          message: 'probe',
          sessionId: conversation.sessionId,
          status: 'SENT',
          sentAt,
        },
      });
      made.campaignId = campaign.id;

      // Two recipients: one will reply, one will not. A predicate that ignored
      // the reply condition would return both and still look plausible.
      const recipients = [conversation.contactId, otherContactId].filter(Boolean);
      for (const contactId of recipients) {
        const row = await prisma.campaignRecipient.create({
          data: { organizationId, campaignId: campaign.id, contactId, status: 'sent', sentAt },
        });
        made.recipientIds.push(row.id);
      }
      check('two recipients were created', made.recipientIds.length === 2,
        String(made.recipientIds.length));

      // One inbound message after the send: that is what "replied" means.
      const message = await prisma.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: 'INBOUND',
          body: 'probe reply — the requirement',
          status: 'DELIVERED',
          timestamp: new Date(sentAt.getTime() + 60_000),
        },
      });
      made.messageId = message.id;

      const where = campaignRepliedContactWhere(campaign.id, organizationId, sentAt);

      const count = await prisma.contact.count({ where });
      check('exactly the one contact who answered is counted', count === 1, String(count));

      const listed = await prisma.contact.findMany({ where, select: { id: true } });
      check('the list is the same set as the count',
        listed.length === count, listed.length + ' vs ' + count);
      check('and it is the contact that actually replied',
        listed[0]?.id === conversation.contactId, String(listed[0]?.id));

      // A message sent *before* the broadcast is not a reply to it.
      const earlier = campaignRepliedContactWhere(
        campaign.id,
        organizationId,
        new Date(Date.now() + 3600_000),
      );
      check('a message predating the send does not count as a reply',
        (await prisma.contact.count({ where: earlier })) === 0);
    } finally {
      if (made.messageId) {
        await prisma.message.delete({ where: { id: made.messageId } }).catch(() => {});
      }
      for (const id of made.recipientIds) {
        await prisma.campaignRecipient.delete({ where: { id } }).catch(() => {});
      }
      if (made.campaignId) {
        await prisma.campaign.delete({ where: { id: made.campaignId } }).catch(() => {});
      }
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
