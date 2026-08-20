import { NextFunction, Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../../prisma';
import { encryptCredential } from '../../lib/credential-crypto';
import logger from '../../lib/logger';
import { queueGatewayAction } from '../../workers/gateway-provisioning.queue';
import { getPlatformMonthlyRollupUsage } from '../usage/usage-rollup.service';
import { seedDefaultAutoReplies } from '../../utils/seed-auto-replies';
import {
  activateManualSubscription,
  cancelCurrentSubscription,
  markPaymentFailed,
} from '../billing/billing.service';
import { PLAN_ENTITLEMENTS, normalizePlanCode } from '../billing/plans';

const router = Router();

function requirePlatformOwner(req: Request, res: Response, next: NextFunction) {
  if (req.platformUser?.platformRole !== 'OWNER') {
    return res.status(403).json({ error: 'RabiTech owner access required' });
  }
  next();
}

router.get('/subscribers', async (_req, res) => {
  try {
    const subscribers = await prisma.organization.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        tier: true,
        paymentProvider: true,
        paymentCustomerRef: true,
        emailVerifiedAt: true,
        downgradeGraceEndsAt: true,
        downgradeGraceReason: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { users: true, whatsappSessions: true } },
        whatsappSessions: {
          select: { id: true, sessionName: true, label: true, phoneNumber: true, isActive: true },
          orderBy: { createdAt: 'asc' },
        },
        channels: {
          where: { kind: 'OPENWA' },
          select: {
            status: true,
            provisioningState: true,
            provisioningStep: true,
            failureReason: true,
            failureStep: true,
            managedByProvisioner: true,
            apiPort: true,
            dashboardPort: true,
            deploymentName: true,
            provisionedAt: true,
            connectedAt: true,
            suspendedAt: true,
            lastCheckedAt: true,
          },
          take: 1,
        },
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            planCode: true,
            provider: true,
            status: true,
            currentPeriodEnd: true,
            activatedAt: true,
            canceledAt: true,
          },
        },
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 3,
          select: {
            id: true,
            status: true,
            amountDueCents: true,
            amountPaidCents: true,
            currency: true,
            dueAt: true,
            paidAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(subscribers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list subscribers' });
  }
});

router.get('/billing/summary', async (_req, res) => {
  try {
    const activeSubscriptions = await prisma.subscription.findMany({
      where: { status: { in: ['ACTIVE', 'TRIALING'] } },
      select: { planCode: true },
    });
    const mrrCents = activeSubscriptions.reduce((sum, subscription) => {
      const code = normalizePlanCode(subscription.planCode);
      return sum + PLAN_ENTITLEMENTS[code].monthlyPriceCents;
    }, 0);
    res.json({
      mrrCents,
      activeSubscriptions: activeSubscriptions.length,
      byTier: activeSubscriptions.reduce<Record<string, number>>((acc, subscription) => {
        acc[subscription.planCode] = (acc[subscription.planCode] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch {
    res.status(500).json({ error: 'Failed to load billing summary' });
  }
});

router.get('/subscribers/:id/usage', async (req, res) => {
  try {
    const organization = await prisma.organization.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!organization) return res.status(404).json({ error: 'Subscriber not found' });

    const month = String(req.query.month || '');
    const reference = /^\d{4}-\d{2}$/.test(month)
      ? new Date(`${month}-01T00:00:00.000Z`)
      : new Date();
    if (Number.isNaN(reference.getTime())) {
      return res.status(400).json({ error: 'Invalid month' });
    }
    res.json(await getPlatformMonthlyRollupUsage(organization.id, reference));
  } catch {
    res.status(500).json({ error: 'Failed to load subscriber usage' });
  }
});

router.post('/subscribers', requirePlatformOwner, async (req, res) => {
  try {
    const { name, slug, adminName, adminEmail, adminPassword } = req.body as Record<string, string>;
    const normalizedSlug = slug?.trim().toLowerCase();
    const normalizedEmail = adminEmail?.trim().toLowerCase();

    if (!name?.trim() || !normalizedSlug || !adminName?.trim() || !normalizedEmail || !adminPassword) {
      return res.status(400).json({ error: 'Subscriber and administrator details are required' });
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
      return res.status(400).json({ error: 'Slug must contain lowercase letters, numbers, or hyphens' });
    }
    if (!/^\S+@\S+\.\S+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'A valid administrator email is required' });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: 'Administrator password must be at least 8 characters' });
    }

    const [existingOrganization, existingIdentity] = await Promise.all([
      prisma.organization.findUnique({ where: { slug: normalizedSlug }, select: { id: true } }),
      prisma.identity.findUnique({ where: { email: normalizedEmail }, select: { id: true } }),
    ]);
    if (existingOrganization) return res.status(409).json({ error: 'Subscriber slug is already in use' });
    if (existingIdentity) return res.status(409).json({ error: 'Administrator email is already in use' });

    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const subscriber = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: name.trim(), slug: normalizedSlug, status: 'PENDING', tier: 'FREE', paymentProvider: 'manual' },
      });
      const identity = await tx.identity.create({
        data: { email: normalizedEmail, passwordHash, platformRole: 'NONE' },
      });
      const generalTeam = await tx.team.create({
        data: {
          organizationId: organization.id,
          name: 'General',
          slug: 'general',
          color: '#2563EB',
          isDefault: true,
        },
      });
      // Starter auto-replies as editable rows the subscriber owns.
      await seedDefaultAutoReplies(tx, organization.id);
      const admin = await tx.user.create({
        data: {
          organizationId: organization.id,
          identityId: identity.id,
          name: adminName.trim(),
          primaryTeamId: generalTeam.id,
          role: 'ADMIN',
        },
      });
      await tx.userTeam.create({
        data: {
          organizationId: organization.id,
          userId: admin.id,
          teamId: generalTeam.id,
        },
      });
      const whatsappSession = await tx.whatsappSession.create({
        data: {
          organizationId: organization.id,
          sessionName: `${normalizedSlug}-primary`,
          phoneNumber: null,
          teamId: generalTeam.id,
          label: 'WhatsApp',
          isActive: true,
        },
      });
      await tx.organizationConfig.create({
        data: {
          organizationId: organization.id,
          sharedLine: false,
        },
      });
      await tx.organizationBranding.create({
        data: {
          organizationId: organization.id,
          productName: name.trim(),
        },
      });
      await tx.workingHours.create({
        data: { organizationId: organization.id },
      });
      await tx.orgSequence.createMany({
        data: [
          { organizationId: organization.id, kind: 'ticketLabel', value: 0 },
          { organizationId: organization.id, kind: 'conversationDisplayId', value: 0 },
        ],
      });
      await tx.organizationChannel.create({
        data: {
          organizationId: organization.id,
          kind: 'OPENWA',
          baseUrl: '',
          apiKeyEnc: '',
          webhookToken: crypto.randomBytes(32).toString('hex'),
          status: 'PENDING',
          managedByProvisioner: true,
          provisioningState: 'PENDING',
          provisioningStep: 'ALLOCATE_RESOURCES',
        },
      });
      return { organization, admin, whatsappSession };
    });

    res.status(201).json(subscriber);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create subscriber' });
  }
});

router.patch('/subscribers/:id/status', requirePlatformOwner, async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ error: 'Status must be ACTIVE or SUSPENDED' });
    }
    const channel = await prisma.organizationChannel.findUnique({
      where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
      select: { managedByProvisioner: true, provisioningState: true },
    });
    if (!channel) return res.status(404).json({ error: 'Subscriber gateway not found' });
    if (!channel.managedByProvisioner) {
      const subscriber = await prisma.organization.update({
        where: { id: req.params.id },
        data: { status },
        select: { id: true, name: true, slug: true, status: true, updatedAt: true },
      });
      return res.json(subscriber);
    }
    const action = status === 'SUSPENDED' ? 'suspend' : 'resume';
    await queueGatewayAction(req.params.id, action);
    res.status(202).json({ organizationId: req.params.id, action });
  } catch (err) {
    res.status(404).json({ error: 'Subscriber not found' });
  }
});

router.post('/subscribers/:id/billing/activate', requirePlatformOwner, async (req, res) => {
  try {
    const planCode = normalizePlanCode(req.body.planCode || 'GROWTH');
    const subscription = await activateManualSubscription(req.params.id, planCode);
    res.status(202).json({ organizationId: req.params.id, subscription });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to activate subscription' });
  }
});

router.post('/subscribers/:id/billing/mark-failed', requirePlatformOwner, async (req, res) => {
  try {
    await markPaymentFailed(req.params.id, String(req.body.reason || 'Manual payment failure'));
    res.status(202).json({ organizationId: req.params.id, status: 'PAST_DUE' });
  } catch {
    res.status(503).json({ error: 'Failed to mark payment failed' });
  }
});

router.post('/subscribers/:id/billing/cancel', requirePlatformOwner, async (req, res) => {
  try {
    await cancelCurrentSubscription(req.params.id);
    res.status(202).json({ organizationId: req.params.id, status: 'CANCELED' });
  } catch {
    res.status(503).json({ error: 'Failed to cancel subscription' });
  }
});

router.patch('/subscribers/:id/openwa-channel', requirePlatformOwner, async (req, res) => {
  const { baseUrl, apiKey, rotateWebhookToken } = req.body as {
    baseUrl?: string;
    apiKey?: string;
    rotateWebhookToken?: boolean;
  };
  if (!baseUrl?.trim() || !apiKey?.trim()) {
    return res.status(400).json({ error: 'OpenWA base URL and API key are required' });
  }
  try {
    const existing = await prisma.organizationChannel.findUnique({
      where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
      select: { managedByProvisioner: true },
    });
    if (existing?.managedByProvisioner) {
      return res.status(409).json({ error: 'Managed gateways must be changed through provisioning actions' });
    }
    const channel = await prisma.organizationChannel.update({
      where: {
        organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' },
      },
      data: {
        baseUrl: baseUrl.trim().replace(/\/$/, ''),
        apiKeyEnc: encryptCredential(apiKey.trim()),
        status: 'ACTIVE',
        provisioningState: 'ACTIVE',
        provisioningStep: 'COMPLETE',
        managedByProvisioner: false,
        ...(rotateWebhookToken
          ? { webhookToken: crypto.randomBytes(32).toString('hex') }
          : {}),
      },
      select: {
        id: true,
        organizationId: true,
        kind: true,
        baseUrl: true,
        status: true,
        updatedAt: true,
      },
    });
    res.json(channel);
  } catch {
    res.status(404).json({ error: 'Subscriber OpenWA channel not found' });
  }
});

async function queueOwnerAction(req: Request, res: Response, action: 'suspend' | 'resume' | 'restart') {
  const channel = await prisma.organizationChannel.findUnique({
    where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
    select: { managedByProvisioner: true, provisioningState: true },
  });
  if (!channel) return res.status(404).json({ error: 'Subscriber gateway not found' });
  if (!channel.managedByProvisioner) {
    return res.status(409).json({ error: 'Subscriber gateway is not managed by the provisioner' });
  }
  await queueGatewayAction(req.params.id, action);
  return res.status(202).json({ organizationId: req.params.id, action });
}

router.post('/subscribers/:id/gateway/retry', requirePlatformOwner, async (req, res) => {
  try {
    const channel = await prisma.organizationChannel.findUnique({
      where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
      select: {
        managedByProvisioner: true,
        provisioningState: true,
        failureStep: true,
        deletionRequestedAt: true,
      },
    });
    if (!channel) return res.status(404).json({ error: 'Subscriber gateway not found' });
    if (!channel.managedByProvisioner || channel.provisioningState !== 'FAILED') {
      return res.status(409).json({ error: 'Only failed managed provisioning can be retried' });
    }
    const action = channel.deletionRequestedAt
      ? 'destroy'
      : channel.failureStep === 'SUSPEND_GATEWAY'
        ? 'suspend'
        : 'provision';
    await queueGatewayAction(req.params.id, action);
    res.status(202).json({ organizationId: req.params.id, action });
  } catch {
    res.status(503).json({ error: 'Failed to queue gateway retry' });
  }
});

router.post('/subscribers/:id/gateway/suspend', requirePlatformOwner, async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'suspend');
  } catch {
    res.status(503).json({ error: 'Failed to queue gateway suspension' });
  }
});

router.post('/subscribers/:id/gateway/resume', requirePlatformOwner, async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'resume');
  } catch {
    res.status(503).json({ error: 'Failed to queue gateway resume' });
  }
});

router.post('/subscribers/:id/gateway/restart', requirePlatformOwner, async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'restart');
  } catch {
    res.status(503).json({ error: 'Failed to queue gateway restart' });
  }
});

router.delete('/subscribers/:id', requirePlatformOwner, async (req, res) => {
  try {
    const channel = await prisma.organizationChannel.findUnique({
      where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
      select: { managedByProvisioner: true },
    });
    if (!channel) return res.status(404).json({ error: 'Subscriber not found' });
    if (!channel.managedByProvisioner) {
      return res.status(409).json({ error: 'Unmanaged subscriber gateways require manual cleanup' });
    }
    await prisma.$transaction(async (tx) => {
      await tx.organizationChannel.update({
        where: { organizationId_kind: { organizationId: req.params.id, kind: 'OPENWA' } },
        data: {
          deletionRequestedAt: new Date(),
          provisioningState: 'PROVISIONING',
          provisioningStep: 'DESTROY_GATEWAY',
        },
      });
      await tx.organization.update({ where: { id: req.params.id }, data: { status: 'SUSPENDED' } });
    });
    await queueGatewayAction(req.params.id, 'destroy');
    res.status(202).json({ organizationId: req.params.id, action: 'destroy' });
  } catch {
    res.status(503).json({ error: 'Failed to queue subscriber destruction' });
  }
});

export default router;
