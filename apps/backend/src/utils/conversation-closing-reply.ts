import { prisma } from '../prisma';
import { ChannelService } from '../modules/channels/channel.service';
import { getTenantId } from '../lib/tenant-context';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { resolveAutoReply } from './auto-reply';

/** Send the workspace's optional closing message after the close is durable. */
export async function sendConversationClosingReply(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, session: true },
  });
  if (!conversation) return;

  const reply = await resolveAutoReply('CONVERSATION_CLOSED');
  if (!reply) return;

  try {
    await ChannelService.sendText(
      conversation.session.sessionName,
      conversation.contact.phone,
      reply,
    );
  } catch {
    // Closing is a database state transition, not a provider transaction. A
    // failed courtesy message must not reopen an already closed conversation.
    return;
  }

  await prisma.message.create({
    data: {
      organizationId: getTenantId(),
      conversationId: conversation.id,
      direction: 'OUTBOUND',
      body: reply,
      isAuto: true,
      autoType: 'resolved',
      status: 'SENT',
    },
  });
}
