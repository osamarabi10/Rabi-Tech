import { NotificationType } from '@prisma/client';
import { prisma } from '../prisma';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import { getTenantId } from '../lib/tenant-context';
import { MAX_COLLABORATORS_PER_CONVERSATION } from '../modules/conversations/collaborator-limits';

export async function createNotification(opts: {
  userId: string;
  type: NotificationType;
  conversationId?: string;
  title: string;
  body: string;
  category?: 'ESCALATION';
}) {
  const organizationId = getTenantId();
  const preferences = await prisma.user.findUnique({
    where: { id: opts.userId },
    select: {
      notificationNewMessage: true,
      notificationAssignment: true,
      notificationMention: true,
      notificationResolution: true,
      notificationEscalation: true,
    },
  });
  if (!preferences) return null;
  const delivery = opts.category === 'ESCALATION'
    ? preferences.notificationEscalation
    : opts.type === 'CONVERSATION_ASSIGNED'
      ? preferences.notificationAssignment
      : opts.type === 'CONVERSATION_RESOLVED'
        ? preferences.notificationResolution
        : opts.type === 'MENTION'
          ? preferences.notificationMention
          : preferences.notificationNewMessage;
  if (delivery === 'OFF') return null;

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
    where: { userId: opts.userId, isRead: false, archivedAt: null },
  });

  /*
    Delivered live where there is a socket, and persisted either way.

    `getIO()` throws when no socket server has been initialised, which is the
    normal state in a worker, a migration script or a gate — and every one of
    those creates notifications. Letting it throw meant the row was already
    written and the caller still saw a failure, so a caller that retried would
    write a second notification for the same event.

    The row is the notification; the emit is a convenience for whoever happens
    to be looking. Nobody listening is not a failure.
  */
  try {
    getIO().to(socketRoom.user(organizationId, opts.userId)).emit(
      SocketEvents.NOTIFICATION,
      { notification: notif, unreadCount: unread },
    );
  } catch {
    // No socket server in this process.
  }

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

  /*
    A mention may also add the person to the thread.

    Off by default, and a workspace setting rather than a rule, because the two
    readings are both legitimate: on a small team "@sara" means *come help*, and
    on a large one it means *for your information*. Adding somebody to a
    conversation grants them everything the assignee has — a mention that did
    that silently would surprise the person who wrote it.

    Read once for the batch rather than per user: it is one row and the answer
    cannot change between two names in the same comment.
  */
  const config = await prisma.organizationConfig.findUnique({
    where: { organizationId: getTenantId() },
    select: { mentionAddsCollaborator: true },
  });
  const shouldAdd = config?.mentionAddsCollaborator === true;

  for (const user of users) {
    await createNotification({
      userId: user.id,
      type: 'MENTION',
      conversationId,
      title: `ذكرك ${authorName} في محادثة #${conv.displayId}`,
      body: 'ملاحظة داخلية',
    });

    if (shouldAdd) {
      await addMentionedCollaborator(conversationId, user.id, authorId);
    }
  }
}

/**
 * Add a mentioned user as a collaborator, respecting the same rules the
 * explicit route does.
 *
 * Silent on every refusal, and that is deliberate: this runs inside a
 * fire-and-forget notification path attached to an agent writing a note. The
 * note must not fail because the thread already had nine collaborators, and the
 * author must not get an error about a side effect they did not ask for.
 *
 * The cap and the assignee exclusion are enforced here rather than trusted,
 * because this is a second door onto the same table — and a second door that
 * skips the rules is how a nine-collaborator limit becomes a suggestion.
 */
async function addMentionedCollaborator(
  conversationId: string,
  userId: string,
  addedById: string,
): Promise<void> {
  try {
    const organizationId = getTenantId();

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId },
      select: { assignedToId: true },
    });
    // The assignee already has the thread. Adding them would put one person in
    // two roles and spend one of the nine.
    if (!conversation || conversation.assignedToId === userId) return;

    const count = await prisma.conversationCollaborator.count({ where: { conversationId } });
    if (count >= MAX_COLLABORATORS_PER_CONVERSATION) return;

    await prisma.conversationCollaborator.upsert({
      where: { organizationId_conversationId_userId: { organizationId, conversationId, userId } },
      create: { organizationId, conversationId, userId, addedById },
      update: {},
    });
  } catch {
    // A mention that notified but failed to add is a smaller failure than a
    // note that did not save.
  }
}
