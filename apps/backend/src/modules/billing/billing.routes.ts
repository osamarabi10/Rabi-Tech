import { Router } from 'express';
import {
  cancelCurrentSubscription,
  createSignup,
  getCheckoutStatus,
  getCurrentBilling,
  listPlans,
  requestGatewayForCurrentOrganization,
  verifyEmail,
} from './billing.service';

const router = Router();

function clientIp(req: any): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0]?.trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function handleRouteError(res: any, error: unknown) {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : 500;
  res.status(status).json({ error: status >= 500 ? 'Billing request failed' : (error as Error).message });
}

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

