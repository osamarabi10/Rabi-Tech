import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { apiTokenAuth, requireScope } from '../api-tokens/api-token.middleware';
import { API_SCOPES } from '../api-tokens/api-token.service';
import contactRoutes from './contacts.routes';

/**
 * `/api/v1` — the public API.
 *
 * ## Versioned from the first endpoint
 *
 * The version is in the path before there is anything to version, because it
 * cannot be added afterwards without breaking every integration that was
 * written against the unversioned path. This is the cheapest decision in the
 * whole surface today and one of the most expensive to retrofit.
 *
 * ## What lives here
 *
 * Only endpoints intended for third parties. The console's own routes stay
 * where they are: they change shape whenever the UI does, and a public contract
 * that moves with an internal screen is not a contract. Sharing handlers
 * between the two would tie every future console refactor to somebody else's
 * running integration.
 */

const router = Router();
router.use(apiTokenAuth);

// Sub-resources mount after the auth middleware, so no router below can be
// reached without a resolved token and an established tenant scope.
router.use('/contacts', contactRoutes);

/**
 * Who am I — the first call any integrator makes.
 *
 * Exists for two reasons beyond politeness. It is how a developer confirms a
 * token works without mutating anything, and it is how they discover what the
 * token may actually do: `scopes` here is the resolved list, so a token created
 * with a scope somebody later removed from the product reports what it really
 * carries rather than what the console recorded at issue time.
 */
router.get('/me', requireScope('workspace:read'), async (req, res) => {
  try {
    const token = req.apiToken!;
    const workspace = await prisma.organization.findUnique({
      where: { id: token.organizationId },
      select: { id: true, name: true, slug: true },
    });

    if (!workspace) {
      // The access gate already passed, so the organization existed a moment
      // ago. Reaching here means it was deleted between the two reads.
      logger.error('API token resolved to a missing workspace', {
        organizationId: token.organizationId,
      });
      return res.status(404).json({ error: 'workspace_not_found' });
    }

    res.json({
      workspace,
      token: {
        id: token.id,
        scopes: token.scopes,
        // Reported so an integrator can see at a glance which of their granted
        // scopes the product still recognises.
        known: API_SCOPES.filter((s) => token.scopes.includes(s)),
      },
    });
  } catch (err: any) {
    logger.error('GET /api/v1/me failed', { error: err?.message, requestId: (req as any).id });
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
