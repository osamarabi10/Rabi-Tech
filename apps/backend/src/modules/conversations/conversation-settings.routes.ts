import { ClosingNoteMode, Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { requirePermission, requireSupervisor } from '../../middleware/rbac.middleware';
import { auditLog } from '../../lib/audit';
import logger from '../../lib/logger';
import {
  MAX_AUTO_CLOSE_MINUTES,
  MIN_AUTO_CLOSE_MINUTES,
  rescheduleConversationAutoClose,
} from './conversation-lifecycle.service';

const router = Router();
router.use(verifyToken);

const CLOSING_NOTE_MODES = new Set<ClosingNoteMode>([
  'OPTIONAL',
  'CATEGORY_REQUIRED',
  'CATEGORY_AND_SUMMARY_REQUIRED',
]);

async function settingsPayload(organizationId: string) {
  const [config, categories] = await Promise.all([
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: {
        autoCloseEnabled: true,
        autoCloseDurationMinutes: true,
        autoCloseEnabledAt: true,
        manualClosingNotesEnabled: true,
        manualClosingNoteMode: true,
      },
    }),
    prisma.conversationCategory.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
  ]);
  return {
    autoCloseEnabled: config?.autoCloseEnabled ?? false,
    autoCloseDurationMinutes: config?.autoCloseDurationMinutes ?? 1_440,
    autoCloseEnabledAt: config?.autoCloseEnabledAt ?? null,
    manualClosingNotesEnabled: config?.manualClosingNotesEnabled ?? false,
    manualClosingNoteMode: config?.manualClosingNoteMode ?? 'OPTIONAL',
    categories,
    limits: {
      minAutoCloseMinutes: MIN_AUTO_CLOSE_MINUTES,
      maxAutoCloseMinutes: MAX_AUTO_CLOSE_MINUTES,
      maxCategories: 50,
    },
  };
}

router.get('/', async (req, res) => {
  res.json(await settingsPayload(req.user!.organizationId));
});

router.patch('/', requireSupervisor, async (req, res) => {
  const organizationId = req.user!.organizationId;
  const body = req.body ?? {};
  const current = await prisma.organizationConfig.findUnique({ where: { organizationId } });
  const autoCloseEnabled = body.autoCloseEnabled;
  const duration = body.autoCloseDurationMinutes;
  const notesEnabled = body.manualClosingNotesEnabled;
  const noteMode = body.manualClosingNoteMode;

  if (autoCloseEnabled !== undefined && typeof autoCloseEnabled !== 'boolean') {
    return res.status(400).json({ error: 'autoCloseEnabled must be a boolean' });
  }
  if (
    duration !== undefined
    && (!Number.isInteger(duration)
      || duration < MIN_AUTO_CLOSE_MINUTES
      || duration > MAX_AUTO_CLOSE_MINUTES)
  ) {
    return res.status(400).json({
      error: `autoCloseDurationMinutes must be between ${MIN_AUTO_CLOSE_MINUTES} and ${MAX_AUTO_CLOSE_MINUTES}`,
    });
  }
  if (notesEnabled !== undefined && typeof notesEnabled !== 'boolean') {
    return res.status(400).json({ error: 'manualClosingNotesEnabled must be a boolean' });
  }
  if (noteMode !== undefined && !CLOSING_NOTE_MODES.has(noteMode)) {
    return res.status(400).json({ error: 'Invalid manualClosingNoteMode' });
  }

  const wasEnabled = current?.autoCloseEnabled ?? false;
  await prisma.organizationConfig.upsert({
    where: { organizationId },
    create: {
      organizationId,
      ...(autoCloseEnabled !== undefined ? { autoCloseEnabled } : {}),
      ...(duration !== undefined ? { autoCloseDurationMinutes: duration } : {}),
      ...(notesEnabled !== undefined ? { manualClosingNotesEnabled: notesEnabled } : {}),
      ...(noteMode !== undefined ? { manualClosingNoteMode: noteMode } : {}),
      ...(!wasEnabled && autoCloseEnabled === true ? { autoCloseEnabledAt: new Date() } : {}),
    },
    update: {
      ...(autoCloseEnabled !== undefined ? { autoCloseEnabled } : {}),
      ...(duration !== undefined ? { autoCloseDurationMinutes: duration } : {}),
      ...(notesEnabled !== undefined ? { manualClosingNotesEnabled: notesEnabled } : {}),
      ...(noteMode !== undefined ? { manualClosingNoteMode: noteMode } : {}),
      ...(!wasEnabled && autoCloseEnabled === true ? { autoCloseEnabledAt: new Date() } : {}),
    },
  });

  if (wasEnabled && autoCloseEnabled === false) {
    // Re-enabling later applies only to newly opened episodes, matching the
    // product contract. Existing threads cannot inherit a timer silently.
    await prisma.conversation.updateMany({
      where: { status: { not: 'RESOLVED' } },
      data: { autoCloseEligible: false, autoCloseAt: null },
    });
  } else if (duration !== undefined && (autoCloseEnabled ?? wasEnabled)) {
    const scheduled = await prisma.conversation.findMany({
      where: {
        status: { not: 'RESOLVED' },
        autoCloseEligible: true,
        lastHumanOutboundAt: { not: null },
      },
      select: { id: true, snoozedUntil: true },
    });
    for (const conversation of scheduled) {
      await rescheduleConversationAutoClose(conversation.id, conversation.snoozedUntil);
    }
  }

  await auditLog({
    userId: req.user!.id,
    action: 'conversation.settings.updated',
    resource: 'organization-config',
    resourceId: organizationId,
    changes: {
      before: current,
      after: {
        autoCloseEnabled,
        autoCloseDurationMinutes: duration,
        manualClosingNotesEnabled: notesEnabled,
        manualClosingNoteMode: noteMode,
      },
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.json(await settingsPayload(organizationId));
});

router.post('/categories', requireSupervisor, async (req, res) => {
  const organizationId = req.user!.organizationId;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'Category name is required and must be 80 characters or fewer' });
  }
  if (description.length > 500) {
    return res.status(400).json({ error: 'Category description must be 500 characters or fewer' });
  }
  if (await prisma.conversationCategory.count() >= 50) {
    return res.status(409).json({ error: 'A workspace can have up to 50 closing categories' });
  }
  try {
    const category = await prisma.conversationCategory.create({
      data: { organizationId, name, description: description || null },
    });
    await auditLog({
      userId: req.user!.id,
      action: 'conversation.category.created',
      resource: 'conversation-category',
      resourceId: category.id,
      description: category.name,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.status(201).json(category);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({ error: 'A category with this name already exists' });
    }
    logger.error('Failed to create closing category', { error: String(error) });
    return res.status(500).json({ error: 'Could not create closing category' });
  }
});

router.patch('/categories/:id', requireSupervisor, async (req, res) => {
  if (req.body?.name !== undefined) {
    return res.status(400).json({ error: 'Category names are immutable; create a new category instead' });
  }
  const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
  if (description.length > 500) {
    return res.status(400).json({ error: 'Category description must be 500 characters or fewer' });
  }
  const existing = await prisma.conversationCategory.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Closing category not found' });
  const category = await prisma.conversationCategory.update({
    where: { id: existing.id },
    data: { description: description || null },
  });
  await auditLog({
    userId: req.user!.id,
    action: 'conversation.category.updated',
    resource: 'conversation-category',
    resourceId: category.id,
    changes: { before: existing, after: category },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.json(category);
});

router.delete('/categories/:id', requireSupervisor, async (req, res) => {
  const category = await prisma.conversationCategory.findUnique({ where: { id: req.params.id } });
  if (!category) return res.status(404).json({ error: 'Closing category not found' });
  await prisma.conversationCategory.delete({ where: { id: category.id } });
  await auditLog({
    userId: req.user!.id,
    action: 'conversation.category.deleted',
    resource: 'conversation-category',
    resourceId: category.id,
    description: category.name,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.status(204).send();
});

router.get('/closures', requirePermission('analytics:read'), async (req, res) => {
  const take = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  const rows = await prisma.conversationClosure.findMany({
    where: source && ['MANUAL', 'AUTO_CLOSE', 'WORKFLOW', 'API', 'MERGE'].includes(source)
      ? { source: source as any }
      : undefined,
    orderBy: { closedAt: 'desc' },
    take,
  });
  res.json({ closures: rows });
});

export default router;
