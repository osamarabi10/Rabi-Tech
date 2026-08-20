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
