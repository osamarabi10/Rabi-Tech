import { prisma } from '../prisma';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { resolveAutoReply } from './auto-reply';
import { getTenantId } from '../lib/tenant-context';

/**
 * The organization's configured welcome message, or null when they have not
 * configured one (or deactivated it). Null means: send nothing.
 */
export async function getStartWelcomeMessage(): Promise<string | null> {
  return resolveAutoReply('WELCOME');
}

/**
 * Sends the welcome message if the organization has one configured.
 * Returns the sent body, or null when nothing was sent.
 */
export async function sendStartWelcome(opts: {
  sessionName: string;
  phone: string;
  conversationId: string;
  sentById?: string;
}): Promise<string | null> {
  const body = await getStartWelcomeMessage();
  if (!body) return null;

  await OpenWAService.sendText(opts.sessionName, opts.phone, body);
  await prisma.message.create({
    data: {
      organizationId: getTenantId(),
      conversationId: opts.conversationId,
      direction: 'OUTBOUND',
      body,
      isAuto: true,
      autoType: 'welcome',
      ...(opts.sentById ? { sentById: opts.sentById } : {}),
    },
  });
  await prisma.conversation.update({
    where: { id: opts.conversationId },
    data: { lastMessageAt: new Date() },
  });
  return body;
}
