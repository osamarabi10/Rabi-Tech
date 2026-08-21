import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import { requirePermission } from '../../middleware/rbac.middleware';
import { PLAN_ENTITLEMENTS } from '../billing/plans';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { validateWorkflowConfig, workflowVocabulary } from './workflow-schema';

/**
 * Workflow CRUD.
 *
 * A workflow is validated on every write against the same vocabulary the
 * builder renders, so a stored graph can never name an action the executor does
 * not implement — the failure mode would be an automation that silently does
 * nothing, which is worse than one that refuses to save.
 */

const router = Router();
router.use(verifyToken);

const WORKFLOW_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  triggerType: true,
  configJson: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

function fail(res: import('express').Response, err: unknown, context: string) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res.status(400).json({ error: 'يوجد أتمتة بهذا الاسم' });
  }
  logger.error(context, { error: String(err) });
  return res.status(500).json({ error: 'Server error' });
}

/** Vocabulary for the builder. Served, never hardcoded in the client. */
router.get('/schema', requirePermission('workflow:view'), async (_req, res) => {
  res.json(workflowVocabulary());
});

router.get('/', requirePermission('workflow:view'), async (_req, res) => {
  try {
    const workflows = await prisma.workflow.findMany({
      select: {
        ...WORKFLOW_SELECT,
        _count: { select: { executions: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(workflows);
  } catch (err) {
    fail(res, err, 'Workflow list failed');
  }
});

/** Recent runs plus a success/failure tally, for the list page. */
router.get('/:id/executions', requirePermission('workflow:view'), async (req, res) => {
  try {
    const workflow = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!workflow) return res.status(404).json({ error: 'الأتمتة غير موجودة' });

    const [runs, tally] = await Promise.all([
      prisma.workflowExecution.findMany({
        where: { workflowId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
      prisma.workflowExecution.groupBy({
        by: ['status'],
        where: { workflowId: req.params.id },
        _count: { _all: true },
      }),
    ]);

    res.json({
      runs,
      tally: tally.reduce<Record<string, number>>((acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      }, {}),
    });
  } catch (err) {
    fail(res, err, 'Workflow executions read failed');
  }
});

router.post('/', requirePermission('workflow:manage'), async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'اسم الأتمتة مطلوب' });

    const validation = validateWorkflowConfig(req.body?.triggerType, req.body?.configJson);
    if (!validation.valid) {
      return res.status(400).json({ error: 'إعداد الأتمتة غير صالح', details: validation.errors });
    }

    // The effective plan, not the plan of record: honouring an override for
    // quotas but not for features is half an upgrade, which is worse than none.
    const effective = await resolveEntitlements(req.user!.organizationId);
    const limit = PLAN_ENTITLEMENTS[effective.plan].workflowsLimit;
    if (limit !== null) {
      const existing = await prisma.workflow.count();
      if (existing >= limit) {
        // 429, matching how the custom-field ceiling answers: this is a quota
        // refusal, not a malformed request and not a permission problem.
        return res.status(429).json({
          error: `الباقة الحالية تسمح بـ ${limit} أتمتة`,
          limit,
          current: existing,
        });
      }
    }

    const workflow = await prisma.workflow.create({
      data: {
        organizationId: req.user!.organizationId,
        name,
        description: req.body?.description ? String(req.body.description) : null,
        // New workflows start switched off. An automation that begins messaging
        // customers the instant it is saved is not a feature.
        isActive: false,
        triggerType: String(req.body.triggerType),
        configJson: req.body.configJson as Prisma.InputJsonValue,
        createdById: req.user!.id,
      },
      select: WORKFLOW_SELECT,
    });
    res.status(201).json(workflow);
  } catch (err) {
    fail(res, err, 'Workflow create failed');
  }
});

router.patch('/:id', requirePermission('workflow:manage'), async (req, res) => {
  try {
    const existing = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      select: { id: true, triggerType: true, configJson: true },
    });
    // 404 rather than 403 for another tenant's id: existence is information.
    if (!existing) return res.status(404).json({ error: 'الأتمتة غير موجودة' });

    const data: Prisma.WorkflowUpdateInput = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'اسم الأتمتة مطلوب' });
      data.name = name;
    }
    if (req.body?.description !== undefined) {
      data.description = req.body.description ? String(req.body.description) : null;
    }
    if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);

    // Re-validate whenever either half of the graph changes: a new trigger can
    // invalidate a config that was fine under the old one (a keyword trigger
    // needs a keyword; CONVERSATION_CREATED does not).
    const nextTrigger = req.body?.triggerType ?? existing.triggerType;
    const nextConfig = req.body?.configJson ?? existing.configJson;
    if (req.body?.triggerType !== undefined || req.body?.configJson !== undefined) {
      const validation = validateWorkflowConfig(nextTrigger, nextConfig);
      if (!validation.valid) {
        return res.status(400).json({ error: 'إعداد الأتمتة غير صالح', details: validation.errors });
      }
      data.triggerType = String(nextTrigger);
      data.configJson = nextConfig as Prisma.InputJsonValue;
    }

    const workflow = await prisma.workflow.update({
      where: { id: req.params.id },
      data,
      select: WORKFLOW_SELECT,
    });
    res.json(workflow);
  } catch (err) {
    fail(res, err, 'Workflow update failed');
  }
});

router.delete('/:id', requirePermission('workflow:manage'), async (req, res) => {
  try {
    const existing = await prisma.workflow.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'الأتمتة غير موجودة' });
    // Hard delete, cascading its executions: unlike a segment, an inactive
    // workflow is already harmless, so there is no half-state worth keeping.
    await prisma.workflow.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch (err) {
    fail(res, err, 'Workflow delete failed');
  }
});

export default router;
