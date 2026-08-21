import { Router } from 'express';
import { getCurrentUsage } from './usage.service';
import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import { resolveEntitlements } from '../billing/entitlements.resolver';

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
    // Resolver, not raw tier: this endpoint must agree with assertSeatAvailable,
    // which is what actually refuses the next invite. Two sources for one answer
    // is how a UI ends up saying "3 of 5" while the server returns 402.
    const entitlements = await resolveEntitlements(organizationId);
    const limit = entitlements.seatLimit;
    const used = await prisma.user.count({ where: { isActive: true } });
    res.json({
      plan: entitlements.plan,
      planName: entitlements.planName,
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      atLimit: limit !== null && used >= limit,
      isOverridden: entitlements.isOverridden,
    });
  } catch {
    res.status(500).json({ error: 'Failed to load seats' });
  }
});

export default router;
