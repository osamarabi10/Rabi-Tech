import { NotificationType } from '@prisma/client';
import { prisma } from '../prisma';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import { getTenantId } from '../lib/tenant-context';

export async function createNotification(opts: {
  userId: string;
  type: NotificationType;
  conversationId?: string;
  title: string;
  body: string;
}) {
  const organizationId = getTenantId();
  const notif = await prisma.notification.create({
    data: {
      organizationId,
      userId: opts.userId,
      type: opts.type,
      conversationId: opts.conversationId ?? null,
      title: opts.title,
      body: opts.body,
    },
  });

  // Real-time push to the agent's socket room
  const unread = await prisma.notification.count({
    where: { userId: opts.userId, isRead: false },
  });

  getIO().to(socketRoom.user(organizationId, opts.userId)).emit(
    SocketEvents.NOTIFICATION,
    { notification: notif, unreadCount: unread },
  );

  return notif;
}

/** Notify the assigned agent (and all supervisors/admins) of a new inbound message. */
export async function notifyNewMessage(conversationId: string, contactName: string | null | undefined) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { displayId: true, assignedToId: true },
  });
  if (!conv) return;

  const title = `رسالة جديدة #${conv.displayId}`;
  const body = contactName ? `من ${contactName}` : 'رسالة واردة';

  const recipientIds = new Set<string>();

  if (conv.assignedToId) recipientIds.add(conv.assignedToId);

  // Also notify supervisors/admins so unassigned convs don't go unnoticed
  const supervisors = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPERVISOR'] }, isActive: true },
    select: { id: true },
  });
  for (const s of supervisors) recipientIds.add(s.id);

  for (const userId of recipientIds) {
    await createNotification({ userId, type: 'NEW_MESSAGE', conversationId, title, body });
  }
}

/** Notify the newly assigned agent. */
export async function notifyAssigned(conversationId: string, assignedToId: string, assignerName: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { displayId: true },
  });
  if (!conv) return;

  await createNotification({
    userId: assignedToId,
    type: 'CONVERSATION_ASSIGNED',
    conversationId,
    title: `تم تعيينك على محادثة #${conv.displayId}`,
    body: `بواسطة ${assignerName}`,
  });
}

/** Notify the agent who handled the conversation that it was resolved. */
export async function notifyResolved(conversationId: string, resolvedByName: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { displayId: true, assignedToId: true },
  });
  if (!conv?.assignedToId) return;

  await createNotification({
    userId: conv.assignedToId,
    type: 'CONVERSATION_RESOLVED',
    conversationId,
    title: `تم إغلاق المحادثة #${conv.displayId}`,
    body: `بواسطة ${resolvedByName}`,
  });
}

/**
 * Everyone named in an internal note.
 *
 * Mentions are resolved from **ids the composer sends**, not by parsing the
 * note text for names. Two agents can share a display name, names contain
 * spaces, and someone typing "@ahmad" in prose is not addressing anyone —
 * matching on text would notify the wrong person some of the time and
 * silently nobody the rest.
 *
 * The author is dropped: being notified of your own note is noise.
 */
export async function notifyMentioned(
  conversationId: string,
  mentionedUserIds: string[],
  authorId: string,
  authorName: string,
): Promise<void> {
  const targets = [...new Set(mentionedUserIds)].filter((id) => id && id !== authorId);
  if (targets.length === 0) return;

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { displayId: true },
  });
  if (!conv) return;

  // Scoped read: an id from another organization simply is not found here, so
  // a forged mention cannot address someone outside the tenant.
  const users = await prisma.user.findMany({
    where: { id: { in: targets }, isActive: true },
    select: { id: true },
  });

  for (const user of users) {
    await createNotification({
      userId: user.id,
      type: 'MENTION',
      conversationId,
      title: `ذكرك ${authorName} في محادثة #${conv.displayId}`,
      body: 'ملاحظة داخلية',
    });
  }
}
