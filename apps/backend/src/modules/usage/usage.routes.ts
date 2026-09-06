import { Router } from 'express';
import { getCurrentUsage } from './usage.service';
import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { limitOf, withinLimit } from '../billing/capabilities';
import logger from '../../lib/logger';

const router = Router();

router.get('/current', async (req, res) => {
  try {
    res.json(await getCurrentUsage());
  } catch (error) {
    logger.error('Current usage load failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to load usage' });
  }
});

/**
 * GET /api/usage/seats — seat consumption for the current plan.
 *
 * Surfaced so an admin sees the ceiling while adding people, rather than
 * discovering it only when a creation is refused.
 */
router.get('/seats', async (req, res) => {
  try {
    const organizationId = getTenantId();
    // Resolver, not raw tier: this endpoint must agree with assertSeatAvailable,
    // which is what actually refuses the next invite. Two sources for one answer
    // is how a UI ends up saying "3 of 5" while the server returns 402 — and
    // since C4 it is not merely the same source but the same two functions.
    const entitlements = await resolveEntitlements(organizationId);
    const limit = limitOf(entitlements, 'seats');
    const used = await prisma.user.count({ where: { isActive: true } });
    res.json({
      plan: entitlements.plan,
      planName: entitlements.planName,
      used,
      limit,
      remaining: limit === null ? null : Math.max(0, limit - used),
      atLimit: !withinLimit(entitlements, 'seats', used),
      isOverridden: entitlements.isOverridden,
    });
  } catch (error) {
    logger.error('Seat usage load failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to load seats' });
  }
});

export default router;
