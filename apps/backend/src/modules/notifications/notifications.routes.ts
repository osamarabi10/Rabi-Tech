import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';

const router = Router();
router.use(verifyToken);

// GET /api/notifications — list for current user
router.get('/', async (req, res) => {
  const userId = req.user!.id;
  const unreadOnly = req.query.unread === 'true';

  const notifications = await prisma.notification.findMany({
    where: { userId, ...(unreadOnly ? { isRead: false } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      conversation: { select: { displayId: true, teamId: true, team: { select: { id: true, name: true, slug: true, color: true } } } },
    },
  });

  const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });

  res.json({ notifications, unreadCount });
});

/**
 * GET /api/notifications/mentions — conversations where this user was named.
 *
 * The inbox needs a set of ids to filter by, not a list of notifications to
 * render, so this returns exactly that. `MENTION` rows have carried a
 * conversation id since mentions were built; nothing was ever reading them
 * back, which is why being @mentioned produced a bell notification and no
 * way to find the thread again once it scrolled past.
 *
 * Read state is reported rather than filtered on. An agent who has read a
 * mention has not necessarily dealt with it, and a list that empties itself
 * the moment you glance at it is a list you cannot use as a queue.
 */
router.get('/mentions', async (req, res) => {
  const userId = req.user!.id;

  const mentions = await prisma.notification.findMany({
    where: { userId, type: 'MENTION', conversationId: { not: null } },
    orderBy: { createdAt: 'desc' },
    // Generous but bounded. The inbox list it filters is itself unpaginated;
    // when that changes this becomes a server-side join instead.
    take: 200,
    select: { conversationId: true, isRead: true, createdAt: true },
  });

  // Collapsed per conversation: being named three times in one thread is one
  // entry in a queue, not three.
  const byConversation = new Map<string, { unread: boolean; at: Date }>();
  for (const mention of mentions) {
    const id = mention.conversationId!;
    const existing = byConversation.get(id);
    if (existing) {
      existing.unread = existing.unread || !mention.isRead;
      continue;
    }
    byConversation.set(id, { unread: !mention.isRead, at: mention.createdAt });
  }

  res.json({
    conversationIds: [...byConversation.keys()],
    unreadConversationIds: [...byConversation.entries()]
      .filter(([, value]) => value.unread)
      .map(([id]) => id),
  });
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch('/:id/read', async (req, res) => {
  const userId = req.user!.id;
  await prisma.notification.updateMany({
    where: { id: req.params.id, userId },
    data: { isRead: true },
  });
  const unreadCount = await prisma.notification.count({ where: { userId, isRead: false } });
  res.json({ unreadCount });
});

// PATCH /api/notifications/read-all — mark all as read
router.patch('/read-all', async (req, res) => {
  const userId = req.user!.id;
  await prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true },
  });
  res.json({ unreadCount: 0 });
});

export default router;
