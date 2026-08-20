import { Router } from 'express';
import { getCurrentUsage } from './usage.service';
import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import { PLAN_ENTITLEMENTS, normalizePlanCode } from '../billing/plans';

const router = Router();

router.get('/current', async (_req, res) => {
  try {
    res.json(await getCurrentUsage());
  } catch {
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

/**
 * GET /api/usage/seats — seat consumption for the current plan.
 *
 * Surfaced so an admin sees the ceiling while adding people, rather than
 * discovering it only when a creation is refused.
 */
router.get('/seats', async (_req, res) => {
  try {
    const organizationId = getTenantId();
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      select: { tier: true },
    });
    const plan = PLAN_ENTITLEMENTS[normalizePlanCode(organization?.tier || 'FREE')];
    const used = await prisma.user.count({ where: { isActive: true } });
    res.json({
      plan: plan.code,
      planName: plan.name,
      used,
      limit: plan.usersLimit,
      remaining: plan.usersLimit === null ? null : Math.max(0, plan.usersLimit - used),
      atLimit: plan.usersLimit !== null && used >= plan.usersLimit,
    });
  } catch {
    res.status(500).json({ error: 'Failed to load seats' });
  }
});

export default router;
