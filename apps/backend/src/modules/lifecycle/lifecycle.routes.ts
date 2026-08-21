import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import { requirePermission } from '../../middleware/rbac.middleware';
import { getTenantId } from '../../lib/tenant-context';

/**
 * Lifecycle stages — the subscriber's own contact pipeline.
 *
 * Reading is open to anyone who can see a contact, because the selector in the
 * contact panel needs the list. Writing is a settings change and sits behind
 * `system:config`: reordering or renaming a stage changes what every agent
 * sees, and deleting one changes what a saved campaign filter matches.
 */

const router = Router();
router.use(verifyToken);

const MAX_NAME_LENGTH = 40;

const STAGE_SELECT = {
  id: true,
  name: true,
  color: true,
  orderIndex: true,
} as const;

/** `#RGB` or `#RRGGBB`. Anything else is rejected rather than stored and rendered. */
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

function parseColor(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  if (!color) return null;
  return HEX.test(color) ? color : undefined;
}

/** GET /api/lifecycle-stages — the pipeline, in order. */
router.get('/', async (req, res) => {
  try {
    const stages = await prisma.lifecycleStage.findMany({
      select: STAGE_SELECT,
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }],
    });
    res.json(stages);
  } catch (err) {
    logger.error('lifecycle stages fetch failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل جلب المراحل', requestId: (req as any).id });
  }
});

/** POST /api/lifecycle-stages */
router.post('/', requirePermission('system:config'), async (req, res) => {
  const name = parseName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'اسم المرحلة مطلوب' });

  const color = parseColor(req.body?.color);
  if (color === undefined && req.body?.color !== undefined) {
    return res.status(400).json({ error: 'لون غير صالح' });
  }

  try {
    // Appended to the end rather than inserted: a new stage has no defensible
    // position inside an existing pipeline, and the settings screen can reorder.
    const last = await prisma.lifecycleStage.findFirst({
      select: { orderIndex: true },
      orderBy: { orderIndex: 'desc' },
    });

    const stage = await prisma.lifecycleStage.create({
      data: {
        // Spelled out rather than cast past the generated type: the tenancy
        // extension injects it anyway, but the create input requires it.
        organizationId: getTenantId(),
        name,
        color: color ?? null,
        orderIndex: (last?.orderIndex ?? -1) + 1,
      },
      select: STAGE_SELECT,
    });
    res.status(201).json(stage);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'المرحلة موجودة مسبقاً' });
    }
    logger.error('lifecycle stage create failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل إنشاء المرحلة', requestId: (req as any).id });
  }
});

/** PATCH /api/lifecycle-stages/:id — rename, recolour, or reposition. */
router.patch('/:id', requirePermission('system:config'), async (req, res) => {
  const data: Prisma.LifecycleStageUpdateInput = {};

  if (req.body?.name !== undefined) {
    const name = parseName(req.body.name);
    if (!name) return res.status(400).json({ error: 'اسم المرحلة مطلوب' });
    data.name = name;
  }
  if (req.body?.color !== undefined) {
    const color = parseColor(req.body.color);
    if (color === undefined) return res.status(400).json({ error: 'لون غير صالح' });
    data.color = color;
  }
  if (req.body?.orderIndex !== undefined) {
    const orderIndex = Number(req.body.orderIndex);
    if (!Number.isInteger(orderIndex) || orderIndex < 0 || orderIndex > 999) {
      return res.status(400).json({ error: 'ترتيب غير صالح' });
    }
    data.orderIndex = orderIndex;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'لا يوجد تغيير' });
  }

  try {
    // updateMany, not update: `update` throws P2025 for a row in another
    // organization, which the extension has already scoped away — and a 500 on
    // a cross-tenant id tells the caller the id exists. A count of 0 is a 404.
    const result = await prisma.lifecycleStage.updateMany({
      where: { id: req.params.id },
      data,
    });
    if (result.count === 0) return res.status(404).json({ error: 'مرحلة غير موجودة' });

    const stage = await prisma.lifecycleStage.findFirst({
      where: { id: req.params.id },
      select: STAGE_SELECT,
    });
    res.json(stage);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'المرحلة موجودة مسبقاً' });
    }
    logger.error('lifecycle stage update failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل تحديث المرحلة', requestId: (req as any).id });
  }
});

/**
 * DELETE /api/lifecycle-stages/:id
 *
 * Hard delete, and contacts keep the string they were stamped with. That is the
 * consequence of `Contact.lifecycleStage` being text rather than a foreign key:
 * removing a stage removes it from the *selector*, and contacts already in it
 * keep showing where they are instead of silently emptying. The response says
 * how many those are, so the caller can tell the user what they just orphaned.
 */
router.delete('/:id', requirePermission('system:config'), async (req, res) => {
  try {
    const stage = await prisma.lifecycleStage.findFirst({
      where: { id: req.params.id },
      select: { name: true },
    });
    if (!stage) return res.status(404).json({ error: 'مرحلة غير موجودة' });

    const affectedContacts = await prisma.contact.count({
      where: { lifecycleStage: stage.name },
    });

    await prisma.lifecycleStage.deleteMany({ where: { id: req.params.id } });
    res.json({ deleted: true, affectedContacts });
  } catch (err) {
    logger.error('lifecycle stage delete failed', {
      error: String(err),
      requestId: (req as any).id,
    });
    res.status(500).json({ error: 'فشل حذف المرحلة', requestId: (req as any).id });
  }
});

export default router;
