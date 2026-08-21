import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import { requirePermission } from '../../middleware/rbac.middleware';
import {
  contactWhereFromFilterDsl,
  parseContactFilterDsl,
  validateContactFilter,
  type ContactFilterDsl,
} from '../../lib/contact-filter-dsl';
import { missingCampaignIds } from '../campaigns/campaign-refs';

/**
 * Saved segments — a named, stored contact filter.
 *
 * Deletion is soft. The tenancy extension injects `organizationId` into every
 * query but knows nothing about `deletedAt`, so **every** read and write here
 * spreads `ACTIVE`. That constant is the only thing standing between this
 * feature and a deleted segment reappearing in a list.
 */

const router = Router();
router.use(verifyToken);

/** Live segments only. Every query MUST spread this. */
const ACTIVE = { deletedAt: null } as const;

const SEGMENT_SELECT = {
  id: true,
  name: true,
  filter: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MAX_NAME_LENGTH = 80;

class SegmentError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'SegmentError';
  }
}

/**
 * Validate a name and confirm nothing else in the organization is using it.
 *
 * The uniqueness check is advisory: two saves in the same instant both pass it.
 * The partial unique index is the real guarantee — this exists so the common
 * case gets a readable message instead of a database error.
 */
async function assertNameAvailable(raw: unknown, excludeId?: string): Promise<string> {
  const name = String(raw ?? '').trim();
  if (!name) throw new SegmentError(400, 'اسم الشريحة مطلوب');
  if (name.length > MAX_NAME_LENGTH) {
    throw new SegmentError(400, `اسم الشريحة طويل جدًا (الحد ${MAX_NAME_LENGTH} حرفًا)`);
  }
  const clash = await prisma.segment.findFirst({
    where: {
      ...ACTIVE,
      name: { equals: name, mode: 'insensitive' },
      // Without this, renaming "VIP" to "VIP" reports a duplicate against itself.
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new SegmentError(400, 'يوجد شريحة بهذا الاسم');
  return name;
}

function validatedFilter(raw: unknown, organizationId: string): Prisma.InputJsonValue {
  const result = validateContactFilter(raw, organizationId);
  if (!result.valid) {
    throw new SegmentError(400, 'الفلتر غير صالح', result.errors);
  }
  return raw as Prisma.InputJsonValue;
}

function fail(res: import('express').Response, err: unknown, context: string) {
  if (err instanceof SegmentError) {
    return res.status(err.status).json({
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }
  // The partial unique index firing means the advisory check lost a race.
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(400).json({ error: 'يوجد شريحة بهذا الاسم' });
  }
  logger.error(context, { error: String(err) });
  return res.status(500).json({ error: 'Server error' });
}

// GET /api/segments — every live segment in the organization.
router.get('/', requirePermission('segment:view'), async (_req, res) => {
  try {
    const segments = await prisma.segment.findMany({
      where: ACTIVE,
      select: SEGMENT_SELECT,
      orderBy: { name: 'asc' },
    });
    res.json(segments);
  } catch (err) {
    fail(res, err, 'Segment list failed');
  }
});

// POST /api/segments
router.post('/', requirePermission('segment:create'), async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const name = await assertNameAvailable(req.body?.name);
    const filter = validatedFilter(req.body?.filter, organizationId);
    const segment = await prisma.segment.create({
      // organizationId is passed explicitly as well as injected by the tenancy
      // extension — the extension is a convenience layer, not the boundary.
      data: { organizationId, name, filter, createdById: req.user!.id },
      select: SEGMENT_SELECT,
    });
    res.status(201).json(segment);
  } catch (err) {
    fail(res, err, 'Segment create failed');
  }
});

// PATCH /api/segments/:id — rename only.
router.patch('/:id', requirePermission('segment:rename'), async (req, res) => {
  try {
    // Read with ACTIVE first: a soft-deleted segment must 404 rather than be
    // silently resurrected by an update.
    const existing = await prisma.segment.findFirst({
      where: { ...ACTIVE, id: req.params.id },
      select: { id: true },
    });
    // 404 rather than 403 for an id in another tenant: existence is information.
    if (!existing) return res.status(404).json({ error: 'الشريحة غير موجودة' });

    const name = await assertNameAvailable(req.body?.name, req.params.id);
    const segment = await prisma.segment.update({
      where: { id: req.params.id },
      data: { name },
      select: SEGMENT_SELECT,
    });
    res.json(segment);
  } catch (err) {
    fail(res, err, 'Segment rename failed');
  }
});

// DELETE /api/segments/:id — soft delete.
router.delete('/:id', requirePermission('segment:delete'), async (req, res) => {
  try {
    const existing = await prisma.segment.findFirst({
      where: { ...ACTIVE, id: req.params.id },
      select: { id: true },
    });
    // Deleting twice is a caller bug worth surfacing rather than absorbing.
    if (!existing) return res.status(404).json({ error: 'الشريحة غير موجودة' });

    await prisma.segment.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    fail(res, err, 'Segment delete failed');
  }
});

/**
 * GET /api/segments/:id/count — contacts matching the segment.
 *
 * **Contacts-page semantics**: archived contacts excluded, opted-out contacts
 * included. The campaign composer deliberately uses its own audience endpoint,
 * which additionally excludes `OPTED_OUT` unconditionally — so the same segment
 * legitimately yields a smaller number there. Reconciling the two by hiding
 * opted-out people from the CRM would be wrong; an agent needs to see them.
 */
router.get('/:id/count', requirePermission('segment:view'), async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    const segment = await prisma.segment.findFirst({
      where: { ...ACTIVE, id: req.params.id },
      select: { filter: true },
    });
    if (!segment) return res.status(404).json({ error: 'الشريحة غير موجودة' });

    const filter = parseContactFilterDsl(segment.filter) as ContactFilterDsl | null;

    // A stored filter can outlive the campaign it references. Returning 0 would
    // make the segment look empty when it is actually broken, and those call for
    // opposite actions from the user.
    const missing = await missingCampaignIds(filter);
    if (missing.length) {
      return res.status(400).json({
        error: 'Campaign referenced in filter was deleted',
        field: 'campaignId',
        details: missing,
      });
    }

    const count = await prisma.contact.count({
      where: { ...contactWhereFromFilterDsl(filter, organizationId), isArchived: false },
    });
    res.json({ count });
  } catch (err) {
    fail(res, err, 'Segment count failed');
  }
});

export default router;
