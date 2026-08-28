import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { auditLog } from '../../lib/audit';
import logger from '../../lib/logger';
import { getTenantId } from '../../lib/tenant-context';
import { requirePermission } from '../../middleware/rbac.middleware';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';

const router = Router();
router.use(verifyToken);

const MAX_STAGES = 20;
const MAX_NAME_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 160;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

type StageKind = 'ACTIVE' | 'LOST';

const STAGE_SELECT = {
  id: true,
  name: true,
  description: true,
  color: true,
  emoji: true,
  kind: true,
  isDefault: true,
  isWon: true,
  orderIndex: true,
} as const;

function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_NAME_LENGTH ? name : null;
}

function parseDescription(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const description = value.trim();
  if (!description) return null;
  return description.length <= MAX_DESCRIPTION_LENGTH ? description : undefined;
}

function parseEmoji(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const emoji = value.trim();
  if (!emoji) return null;
  return Array.from(emoji).length <= 8 ? emoji : undefined;
}

function parseColor(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  return HEX.test(color) ? color.toUpperCase() : undefined;
}

function parseKind(value: unknown): StageKind | null {
  return value === 'ACTIVE' || value === 'LOST' ? value : null;
}

function requestAudit(req: any) {
  return { userId: req.user!.id, ipAddress: req.ip, userAgent: req.get('user-agent') };
}

function mutationError(res: any, err: unknown, fallback: string) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(409).json({ error: 'A lifecycle stage with this name already exists', code: 'STAGE_NAME_EXISTS' });
  }
  logger.error(fallback, { error: String(err) });
  return res.status(500).json({ error: fallback });
}

/** Pipeline stages with live assignment counts, ordered within each column. */
router.get('/', async (_req, res) => {
  try {
    const [stages, counts] = await Promise.all([
      prisma.lifecycleStage.findMany({
        select: STAGE_SELECT,
        orderBy: [{ kind: 'asc' }, { orderIndex: 'asc' }, { name: 'asc' }],
      }),
      prisma.contact.groupBy({
        by: ['lifecycleStage'],
        where: { lifecycleStage: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const countByName = new Map(counts.map((row) => [row.lifecycleStage, row._count._all]));
    res.json(stages.map((stage) => ({ ...stage, contactCount: countByName.get(stage.name) || 0 })));
  } catch (err) {
    logger.error('lifecycle stages fetch failed', { error: String(err) });
    res.status(500).json({ error: 'Could not load lifecycle stages' });
  }
});

/** Add an ordinary primary or Lost stage. Default/Won changes are separate audited actions. */
router.post('/', requirePermission('system:config'), async (req, res) => {
  const organizationId = getTenantId();
  const name = parseName(req.body?.name);
  const kind = parseKind(req.body?.kind ?? 'ACTIVE');
  const description = req.body?.description === undefined ? null : parseDescription(req.body.description);
  const color = req.body?.color === undefined ? null : parseColor(req.body.color);
  const emoji = req.body?.emoji === undefined ? null : parseEmoji(req.body.emoji);
  if (!name) return res.status(400).json({ error: 'Stage name is required', code: 'INVALID_STAGE_NAME' });
  if (!kind) return res.status(400).json({ error: 'Stage kind is invalid', code: 'INVALID_STAGE_KIND' });
  if (description === undefined) return res.status(400).json({ error: 'Stage description is too long', code: 'INVALID_DESCRIPTION' });
  if (color === undefined) return res.status(400).json({ error: 'Stage color is invalid', code: 'INVALID_COLOR' });
  if (emoji === undefined) return res.status(400).json({ error: 'Stage emoji is too long', code: 'INVALID_EMOJI' });

  try {
    const total = await prisma.lifecycleStage.count();
    if (total >= MAX_STAGES) {
      return res.status(409).json({ error: 'A workspace can have at most 20 lifecycle stages', code: 'STAGE_LIMIT' });
    }

    const stage = await prisma.$transaction(async (tx) => {
      const rows = await tx.lifecycleStage.findMany({
        where: { organizationId, kind },
        select: { id: true, orderIndex: true, isWon: true },
        orderBy: { orderIndex: 'asc' },
      });
      let orderIndex = rows.length ? rows[rows.length - 1].orderIndex + 1 : 0;
      const won = kind === 'ACTIVE' ? rows.find((row) => row.isWon) : undefined;
      if (won) {
        orderIndex = won.orderIndex;
        await tx.lifecycleStage.updateMany({
          where: { id: won.id, organizationId },
          data: { orderIndex: won.orderIndex + 1 },
        });
      }
      return tx.lifecycleStage.create({
        data: {
          organizationId,
          name,
          kind,
          description,
          color,
          emoji: kind === 'LOST' ? emoji : null,
          orderIndex,
        },
        select: STAGE_SELECT,
      });
    });

    await auditLog({
      ...requestAudit(req),
      action: 'lifecycle-stage.created',
      resource: 'lifecycle-stage',
      resourceId: stage.id,
      changes: { after: stage },
    });
    res.status(201).json({ ...stage, contactCount: 0 });
  } catch (err) {
    return mutationError(res, err, 'Could not create lifecycle stage');
  }
});

/** Rename, describe, recolor, change column, or atomically select default/Won. */
router.patch('/:id', requirePermission('system:config'), async (req, res) => {
  const organizationId = getTenantId();
  const current = await prisma.lifecycleStage.findFirst({ where: { id: req.params.id }, select: STAGE_SELECT });
  if (!current) return res.status(404).json({ error: 'Lifecycle stage not found' });

  const data: Prisma.LifecycleStageUncheckedUpdateManyInput = {};
  if (req.body?.name !== undefined) {
    const name = parseName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Stage name is required', code: 'INVALID_STAGE_NAME' });
    data.name = name;
  }
  if (req.body?.description !== undefined) {
    const description = parseDescription(req.body.description);
    if (description === undefined) return res.status(400).json({ error: 'Stage description is too long', code: 'INVALID_DESCRIPTION' });
    data.description = description;
  }
  if (req.body?.color !== undefined) {
    const color = parseColor(req.body.color);
    if (color === undefined) return res.status(400).json({ error: 'Stage color is invalid', code: 'INVALID_COLOR' });
    data.color = color;
  }
  if (req.body?.emoji !== undefined) {
    const emoji = parseEmoji(req.body.emoji);
    if (emoji === undefined) return res.status(400).json({ error: 'Stage emoji is too long', code: 'INVALID_EMOJI' });
    data.emoji = emoji;
  }

  let nextKind = current.kind as StageKind;
  if (req.body?.kind !== undefined) {
    const kind = parseKind(req.body.kind);
    if (!kind) return res.status(400).json({ error: 'Stage kind is invalid', code: 'INVALID_STAGE_KIND' });
    if (kind !== current.kind && (current.isDefault || current.isWon)) {
      return res.status(409).json({ error: 'Move the default or Won marker before changing columns', code: 'PROTECTED_STAGE' });
    }
    nextKind = kind;
    data.kind = kind;
    if (kind === 'ACTIVE') data.emoji = null;
  }

  const setDefault = req.body?.isDefault === true && !current.isDefault;
  const setWon = req.body?.isWon === true && !current.isWon;
  if (req.body?.isDefault === false && current.isDefault) {
    return res.status(409).json({ error: 'Select another default stage instead', code: 'DEFAULT_REQUIRED' });
  }
  if (req.body?.isWon === false && current.isWon) {
    return res.status(409).json({ error: 'Select another Won stage instead', code: 'WON_REQUIRED' });
  }
  if (setDefault && (nextKind !== 'ACTIVE' || current.isWon || setWon)) {
    return res.status(409).json({ error: 'The default must be an ordinary primary stage', code: 'INVALID_DEFAULT' });
  }
  if (setWon && (nextKind !== 'ACTIVE' || current.isDefault || setDefault)) {
    return res.status(409).json({ error: 'The Won stage must be a non-default primary stage', code: 'INVALID_WON' });
  }
  if (!Object.keys(data).length && !setDefault && !setWon) {
    return res.status(400).json({ error: 'No lifecycle stage change was provided' });
  }

  try {
    const stage = await prisma.$transaction(async (tx) => {
      if (nextKind !== current.kind) {
        if (current.kind === 'ACTIVE') {
          const activeCount = await tx.lifecycleStage.count({ where: { organizationId, kind: 'ACTIVE' } });
          if (activeCount <= 1) throw new Error('LAST_ACTIVE_STAGE');
        }
        const targetRows = await tx.lifecycleStage.findMany({
          where: { organizationId, kind: nextKind },
          select: { id: true, orderIndex: true, isWon: true },
          orderBy: { orderIndex: 'asc' },
        });
        const won = nextKind === 'ACTIVE' ? targetRows.find((row) => row.isWon) : undefined;
        data.orderIndex = targetRows.length ? targetRows[targetRows.length - 1].orderIndex + 1 : 0;
        if (won) {
          data.orderIndex = won.orderIndex;
          await tx.lifecycleStage.updateMany({ where: { id: won.id, organizationId }, data: { orderIndex: won.orderIndex + 1 } });
        }
      }

      if (setDefault) {
        await tx.lifecycleStage.updateMany({ where: { organizationId, isDefault: true }, data: { isDefault: false } });
        data.isDefault = true;
      }
      if (setWon) {
        await tx.lifecycleStage.updateMany({ where: { organizationId, isWon: true }, data: { isWon: false } });
        data.isWon = true;
        const lastActive = await tx.lifecycleStage.findFirst({
          where: { organizationId, kind: 'ACTIVE', id: { not: current.id } },
          select: { orderIndex: true },
          orderBy: { orderIndex: 'desc' },
        });
        data.orderIndex = (lastActive?.orderIndex ?? -1) + 1;
      }

      const nextName = typeof data.name === 'string' ? data.name : current.name;
      if (nextName !== current.name) {
        await tx.contact.updateMany({
          where: { organizationId, lifecycleStage: current.name },
          data: { lifecycleStage: nextName },
        });
      }
      const updated = await tx.lifecycleStage.updateMany({
        where: { id: current.id, organizationId },
        data,
      });
      if (!updated.count) throw new Error('STAGE_NOT_FOUND');
      return tx.lifecycleStage.findFirstOrThrow({ where: { id: current.id, organizationId }, select: STAGE_SELECT });
    });

    await auditLog({
      ...requestAudit(req),
      action: setDefault ? 'lifecycle-stage.default-selected' : setWon ? 'lifecycle-stage.won-selected' : 'lifecycle-stage.updated',
      resource: 'lifecycle-stage',
      resourceId: current.id,
      changes: { before: current, after: stage },
    });
    const contactCount = await prisma.contact.count({ where: { lifecycleStage: stage.name } });
    res.json({ ...stage, contactCount });
  } catch (err) {
    if (String(err).includes('LAST_ACTIVE_STAGE')) {
      return res.status(409).json({ error: 'At least one primary lifecycle stage is required', code: 'LAST_ACTIVE_STAGE' });
    }
    return mutationError(res, err, 'Could not update lifecycle stage');
  }
});

/** Replace one complete column order atomically. The Won stage is always last. */
router.put('/reorder/all', requirePermission('system:config'), async (req, res) => {
  const kind = parseKind(req.body?.kind);
  const stageIds: string[] = Array.isArray(req.body?.stageIds) ? req.body.stageIds.map(String) : [];
  if (!kind || !stageIds.length || new Set(stageIds).size !== stageIds.length) {
    return res.status(400).json({ error: 'A complete unique stage order is required', code: 'INVALID_STAGE_ORDER' });
  }

  const current = await prisma.lifecycleStage.findMany({
    where: { kind },
    select: { id: true, isWon: true },
  });
  if (current.length !== stageIds.length || current.some((stage) => !stageIds.includes(stage.id))) {
    return res.status(409).json({ error: 'The stage list changed; reload before reordering', code: 'STALE_STAGE_ORDER' });
  }
  const won = current.find((stage) => stage.isWon);
  if (won && stageIds[stageIds.length - 1] !== won.id) {
    return res.status(409).json({ error: 'The Won stage must remain last', code: 'WON_MUST_BE_LAST' });
  }

  await prisma.$transaction(stageIds.map((id, orderIndex) => prisma.lifecycleStage.updateMany({
    where: { id, kind },
    data: { orderIndex },
  })));
  await auditLog({
    ...requestAudit(req),
    action: 'lifecycle-stage.reordered',
    resource: 'lifecycle-stage-order',
    resourceId: kind,
    changes: { after: stageIds },
  });
  res.json({ kind, stageIds });
});

/** Delete after explicitly clearing or reassigning contacts that still use the stage. */
router.delete('/:id', requirePermission('system:config'), async (req, res) => {
  const organizationId = getTenantId();
  const stage = await prisma.lifecycleStage.findFirst({ where: { id: req.params.id }, select: STAGE_SELECT });
  if (!stage) return res.status(404).json({ error: 'Lifecycle stage not found' });
  if (stage.isWon) return res.status(409).json({ error: 'The Won stage cannot be deleted', code: 'WON_STAGE_PROTECTED' });
  if (stage.isDefault) return res.status(409).json({ error: 'Select another default stage before deleting this one', code: 'DEFAULT_STAGE_PROTECTED' });
  if (stage.kind === 'ACTIVE') {
    const activeCount = await prisma.lifecycleStage.count({ where: { kind: 'ACTIVE' } });
    if (activeCount <= 1) return res.status(409).json({ error: 'At least one primary lifecycle stage is required', code: 'LAST_ACTIVE_STAGE' });
  }

  const affectedContacts = await prisma.contact.count({ where: { lifecycleStage: stage.name } });
  const hasReassignmentChoice = Object.prototype.hasOwnProperty.call(req.body || {}, 'reassignToStageId');
  if (affectedContacts > 0 && !hasReassignmentChoice) {
    return res.status(409).json({
      error: 'Choose where assigned contacts should move before deleting this stage',
      code: 'REASSIGNMENT_REQUIRED',
      affectedContacts,
    });
  }

  let replacement: { id: string; name: string } | null = null;
  if (req.body?.reassignToStageId) {
    replacement = await prisma.lifecycleStage.findFirst({
      where: { id: String(req.body.reassignToStageId) },
      select: { id: true, name: true },
    });
    if (!replacement || replacement.id === stage.id) {
      return res.status(400).json({ error: 'Replacement stage is invalid', code: 'INVALID_REPLACEMENT_STAGE' });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      if (affectedContacts > 0) {
        await tx.contact.updateMany({
          where: { organizationId, lifecycleStage: stage.name },
          data: { lifecycleStage: replacement?.name ?? null },
        });
      }
      const deleted = await tx.lifecycleStage.deleteMany({ where: { id: stage.id, organizationId } });
      if (!deleted.count) throw new Error('STAGE_NOT_FOUND');
    });
    await auditLog({
      ...requestAudit(req),
      action: 'lifecycle-stage.deleted',
      resource: 'lifecycle-stage',
      resourceId: stage.id,
      changes: { before: stage, after: { replacementStageId: replacement?.id ?? null, affectedContacts } },
    });
    res.json({ deleted: true, affectedContacts, replacementStageId: replacement?.id ?? null });
  } catch (err) {
    return mutationError(res, err, 'Could not delete lifecycle stage');
  }
});

export default router;
