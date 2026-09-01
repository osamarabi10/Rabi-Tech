import { Router } from 'express';
import logger from '../../lib/logger';
import {
  cancelCurrentSubscription,
  createSignup,
  getCheckoutStatus,
  getBillingSummary,
  getCurrentBilling,
  listPlans,
  requestGatewayForCurrentOrganization,
  verifyEmail,
} from './billing.service';
import { resolveTrial } from './trial.service';
import { getServiceState } from './service-state.service';

const router = Router();

function clientIp(req: any): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function handleRouteError(res: any, error: unknown) {
  logger.error('Billing request failed', {
    error: error instanceof Error ? error.stack : String(error),
  });
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
  /*
    A machine code travels with the message when the thrower set one.

    This endpoint is public and its copy is rendered in three languages, so a
    server-composed Arabic sentence would be wrong in two of them - the same
    reasoning the trial-status endpoint below states for returning a deadline
    rather than a banner. The `error` string stays as an English fallback for
    logs and for any caller that does not know the code.
  */
  const code = typeof (error as any)?.code === 'string' ? (error as any).code : undefined;
  res.status(status).json({
    error: status >= 500 ? 'Billing request failed' : (error as Error).message,
    ...(code && status < 500 ? { code } : {}),
  });
}

/**
 * Why this workspace is in trouble, if it is.
 *
 * On the gate's allow-list beside the trial endpoint, and for the same
 * reason: a workspace that has just been refused everything else still has to
 * be able to render an explanation.
 *
 * Returns the deadline rather than a rendered sentence, because the banner is
 * translated into three languages and a server-composed string would be in
 * one of them.
 */
router.get('/service-state', async (req, res) => {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) return res.status(401).json({ error: 'Unauthorized' });
    const state = await getServiceState(organizationId);
    res.json(state);
  } catch (error) {
    handleRouteError(res, error);
  }
});

/**
 * The countdown, and whether the paywall is up.
 *
 * On the gate's allow-list, because a client that has just been refused
 * everything else still has to be able to ask why. Returns the deadline
 * rather than a number of minutes: a duration computed here would be stale by
 * the time it rendered, and would drift against a clock the client is already
 * watching. The client counts down from the timestamp.
 */
router.get('/trial', async (req, res) => {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) return res.status(401).json({ error: 'Unauthorized' });
    const trial = await resolveTrial(organizationId);
    res.json({
      state: trial.kind,
      endsAt: trial.kind === 'none' ? null : trial.endsAt.toISOString(),
      // The server's own clock, so a client whose device is set wrong counts
      // down against ours rather than against its own.
      serverNow: new Date().toISOString(),
    });
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get('/plans', async (_req, res) => {
  try {
    res.json(await listPlans());
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post('/signup', async (req, res) => {
  try {
    const result = await createSignup({
      organizationName: String(req.body.organizationName || req.body.name || ''),
      adminName: String(req.body.adminName || ''),
      adminEmail: String(req.body.adminEmail || req.body.email || ''),
      adminPassword: String(req.body.adminPassword || req.body.password || ''),
      planCode: req.body.planCode,
      ipAddress: clientIp(req),
    });
    res.status(201).json(result);
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get('/verify-email', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).json({ error: 'Verification token is required' });
    res.json(await verifyEmail(token));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get('/checkout-status/:externalRef', async (req, res) => {
  try {
    res.json(await getCheckoutStatus(req.params.externalRef));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.get('/current', async (req, res) => {
  try {
    res.json(await getCurrentBilling(req.user!.organizationId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

/**
 * GET /api/billing/summary — plan, entitlements, seats, usage meters and
 * invoices for the signed-in organization, in one call.
 */
router.get('/summary', async (req, res) => {
  try {
    res.json(await getBillingSummary(req.user!.organizationId));
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post('/request-gateway', async (req, res) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
    const queued = await requestGatewayForCurrentOrganization(req.user!.organizationId);
    res.status(202).json({ queued });
  } catch (error) {
    handleRouteError(res, error);
  }
});

router.post('/cancel', async (req, res) => {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access required' });
    await cancelCurrentSubscription(req.user!.organizationId);
    res.status(202).json({ canceled: true });
  } catch (error) {
    handleRouteError(res, error);
  }
});

export default router;
