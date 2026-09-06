/**
 * Workspaces: divisions inside one organization.
 *
 * Organization is still the tenancy boundary. A workspace is a division within
 * it — its own channel, its own contacts, its own threads — and the composite
 * foreign keys added in commit 2a are what make that separation structural
 * rather than a convention this file has to remember to honour.
 *
 * ## The active workspace is a claim, never a parameter
 *
 * There is no header and no query string that selects a workspace, for exactly
 * the reason `organizationId` has never been one: anything the client sends,
 * the client can change. The active workspace lives in the signed session
 * token. It is put there by `/activate` below, after membership is checked, and
 * `verifyToken` re-validates it on every request rather than trusting that the
 * check happened once at mint time.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { requireAdmin } from '../../middleware/rbac.middleware';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { limitOf, withinLimit } from '../billing/capabilities';
import {
  assertWithinLimit,
  isEntitlementError,
  entitlementErrorResponse,
} from '../billing/entitlement-facade';
import logger from '../../lib/logger';
import memberRoutes from './members.routes';

const router = Router();
router.use(verifyToken);

// Membership lives in its own file, mounted here so it inherits verifyToken
// and the /api/workspaces prefix rather than declaring either again.
router.use('/', memberRoutes);

/**
 * The workspaces this user may work in.
 *
 * Membership, not organization contents. An admin who is not a member of a
 * workspace does not see it here, because this list is what the switcher
 * renders and offering somewhere you cannot go is worse than not offering it.
 */
router.get('/', async (req, res) => {
  try {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.user!.id },
      select: { workspaceId: true },
    });
    const ids = memberships.map((row) => row.workspaceId);

    const workspaces = await prisma.workspace.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });

    const entitlements = await resolveEntitlements(req.user!.organizationId);
    const total = await prisma.workspace.count();

    return res.json({
      workspaces,
      activeWorkspaceId: (req as any).activeWorkspaceId ?? null,
      // The switcher needs to know whether another can be created, and the
      // badge needs to know whether the answer is a plan limit rather than a
      // permission. Both come from the same resolved entitlement — and now
      // through the same two functions the create endpoint uses, so this is
      // not merely the same *number* but the same *comparison*. A screen that
      // recomputes "is there room" agrees until it does not, and the day it
      // stops is the day a customer clicks an enabled button and gets a 402.
      maxWorkspaces: limitOf(entitlements, 'workspaces'),
      workspaceCount: total,
      canCreate: withinLimit(entitlements, 'workspaces', total),
      planName: entitlements.planName,
    });
  } catch (err) {
    logger.error('workspaces list failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Create a workspace.
 *
 * Gated on the resolved entitlement rather than on a plan-code comparison, so a
 * platform-owner override grants it without this file learning what an override
 * is. The refusal lives here, at the endpoint, and not in the UI: a hidden
 * control teaches nobody what an upgrade would buy, and a client calling the
 * API directly is not stopped by a button that was never rendered.
 */
router.post('/', requireAdmin, async (req, res) => {
  try {
    const name = String(req.body?.name ?? '').trim();
    if (!name) {
      return res.status(400).json({ error: 'invalid_request', message: 'لازم اسم لمساحة العمل' });
    }
    if (name.length > 60) {
      return res.status(400).json({ error: 'invalid_request', message: 'الاسم أطول من اللازم' });
    }

    /*
      402, not 403, and the façade rather than a comparison written here.

      The caller is permitted; the plan is what refuses. That distinction is the
      whole reason the UI can offer an upgrade here instead of reporting a
      permissions fault, and an agent told "you do not have permission" for
      something their admin could buy in a minute goes and asks the wrong person.

      The count stays here because only this route knows what a workspace is.
      Everything after it — resolving the plan, honouring an override, comparing,
      naming the upgrade — belongs to one implementation shared with seats,
      custom fields and workflows.
    */
    const existing = await prisma.workspace.count();
    await assertWithinLimit(req.user!.organizationId, 'workspaces', existing);

    const duplicate = await prisma.workspace.findFirst({ where: { name }, select: { id: true } });
    if (duplicate) {
      return res.status(409).json({ error: 'duplicate', message: 'في مساحة عمل بنفس الاسم' });
    }

    const created = await prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { organizationId: req.user!.organizationId, name, isDefault: false },
        select: { id: true, name: true, isDefault: true },
      });
      // The creator becomes a member immediately. Otherwise they have made
      // somewhere they cannot go, and the switcher — which lists memberships —
      // would not show the thing they just created.
      await tx.workspaceMember.create({
        data: {
          organizationId: req.user!.organizationId,
          workspaceId: workspace.id,
          userId: req.user!.id,
          role: req.user!.role ?? 'ADMIN',
        },
      });
      return workspace;
    });

    return res.status(201).json(created);
  } catch (err) {
    if (isEntitlementError(err)) return res.status(err.status).json(entitlementErrorResponse(err));
    logger.error('workspace create failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Switch the active workspace: mint a new token carrying the new claim.
 *
 * This is where the claim is minted, and it is the only place.
 *
 * Membership is checked here, but that check is not what makes the claim safe:
 * a token outlives the moment it was signed, and a membership can be revoked
 * afterwards. `verifyToken` re-reads it on every request. This check exists so
 * that switching somewhere you were never a member of fails at the switch, with
 * a message, rather than at the next page load with an empty screen.
 */
router.post('/:id/activate', async (req, res) => {
  try {
    const target = String(req.params.id);

    /*
      Organization-scoped by the extension, so a workspace id belonging to
      another organization resolves to nothing and cannot be activated. It comes
      back indistinguishable from an id that does not exist anywhere, which is
      the correct amount to say: confirming that somebody else's workspace is
      real is itself a disclosure.
    */
    const workspace = await prisma.workspace.findFirst({
      where: { id: target },
      select: { id: true, name: true },
    });
    if (!workspace) {
      return res.status(404).json({ error: 'not_found', message: 'ما في مساحة عمل بهذا المعرّف' });
    }

    const membership = await prisma.workspaceMember.findFirst({
      where: { workspaceId: target, userId: req.user!.id },
      select: { id: true },
    });
    if (!membership) {
      return res.status(403).json({ error: 'not_a_member', message: 'إنت مش عضو بهذي المساحة' });
    }

    const header = String(req.headers.authorization || '');
    const current = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!current) return res.status(401).json({ error: 'unauthorized' });

    const decoded = jwt.verify(current, process.env.JWT_SECRET!) as Record<string, unknown>;
    /*
      Re-sign the SAME payload with the new workspace, dropping only the
      registered claims jwt.sign owns.

      Copying the payload rather than rebuilding it is deliberate: a claim added
      to the login path later — a new restriction flag, a new team list — would
      otherwise be silently dropped by switching workspace, and the user would
      lose it without any event that looks like a cause.
    */
    const rest = { ...decoded };
    delete rest.iat;
    delete rest.exp;
    delete rest.nbf;

    const token = jwt.sign(
      { ...rest, workspaceId: workspace.id },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
    );

    return res.json({ token, workspace });
  } catch (err) {
    logger.error('workspace activate failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
