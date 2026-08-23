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
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { probeOrganization } from '../gateway/health-monitor';
import { isCommercialTermsError, parseCommercialPatch } from '../billing/commercial-terms';
import { auditPlatformScope } from '../../lib/audit';
import {
  PaymentError,
  createInvoice,
  formatMoney,
  listFinanceDocuments,
  recordPayment,
} from './finance.service';
import { renderFinanceCsv, renderFinanceDocument } from './finance.document';
import { hasOverdueBalance } from './finance.service';
import {
  getDunningGraceDays,
  runDunning,
  setDunningGraceDays,
} from '../billing/dunning.service';
import { getTrialHours, setTrialHours, getTrialPlanCode, setTrialPlanCode } from '../billing/trial.service';

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
        // Dunning state on the row: a subscriber counting down to cut-off is
        // the thing an owner most needs to see without opening anything.
        suspendAt: true,
        suspendReason: true,
        // Surfaced on the row so an overridden subscriber is visible in the
        // list, not only after opening a dialog.
        planOverride: true,
        overrideExpiresAt: true,
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
            // The console shows time left, so it needs the deadline itself —
            // a duration computed here would be stale before it rendered.
            trialEndsAt: true,
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
    /*
     * MRR counts ACTIVE only.
     *
     * It used to include TRIALING, which cost nothing while trials ran on the
     * free plan at zero. They now run on a real paid plan, so every trial
     * would have added its full list price to reported revenue — money nobody
     * has paid and most of whom never will. Trials are counted separately,
     * because how many are open is a useful number and adding it to revenue
     * is a lie.
     */
    const [paid, trialing] = await Promise.all([
      prisma.subscription.findMany({ where: { status: 'ACTIVE' }, select: { planCode: true } }),
      prisma.subscription.findMany({
        where: { status: 'TRIALING' },
        select: { planCode: true, trialEndsAt: true },
      }),
    ]);

    const mrrCents = paid.reduce((sum, subscription) => {
      const code = normalizePlanCode(subscription.planCode);
      return sum + PLAN_ENTITLEMENTS[code].monthlyPriceCents;
    }, 0);

    const now = Date.now();
    res.json({
      mrrCents,
      activeSubscriptions: paid.length,
      trials: {
        open: trialing.filter((t) => t.trialEndsAt && t.trialEndsAt.getTime() > now).length,
        expired: trialing.filter((t) => t.trialEndsAt && t.trialEndsAt.getTime() <= now).length,
        // What this would be worth if every open trial converted. Kept
        // clearly separate from mrrCents so the two can never be added by
        // accident.
        potentialCents: trialing
          .filter((t) => t.trialEndsAt && t.trialEndsAt.getTime() > now)
          .reduce((sum, t) => sum + PLAN_ENTITLEMENTS[normalizePlanCode(t.planCode)].monthlyPriceCents, 0),
      },
      byTier: paid.reduce<Record<string, number>>((acc, subscription) => {
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

/** The commercial columns, selected identically for before/after snapshots. */
const COMMERCIAL_SELECT = {
  id: true,
  name: true,
  tier: true,
  planOverride: true,
  macQuotaOverride: true,
  discountPercent: true,
  creditCents: true,
  overrideReason: true,
  overrideExpiresAt: true,
  overrideSetBy: true,
  overrideSetAt: true,
} as const;

/**
 * PATCH /api/platform/subscribers/:id/commercials
 *
 * The owner's lever for enterprise deals: plan override, MAC quota, discount and
 * credit, with a mandatory reason and an optional expiry.
 *
 * Deliberately does NOT call applyPlanLimits(). A plan override must not rewrite
 * OrganizationConfig — see the header of modules/billing/entitlements.resolver.ts
 * for why write-through was rejected.
 */
router.patch('/subscribers/:id/commercials', requirePlatformOwner, async (req, res) => {
  try {
    // Read first: this snapshot is both the validation baseline and beforeState.
    // Taken after the write it would be worthless.
    const before = await prisma.organization.findUnique({
      where: { id: req.params.id },
      select: COMMERCIAL_SELECT,
    });
    // 404 rather than 403 for an id in another scope: existence is information.
    if (!before) return res.status(404).json({ error: 'Subscriber not found' });

    const patch = parseCommercialPatch(req.body || {}, before);

    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: req.params.id },
        data: {
          ...patch,
          // Never from the request body.
          overrideSetBy: req.platformUser!.id,
          overrideSetAt: new Date(),
        },
        select: COMMERCIAL_SELECT,
      });
      // Inside the transaction so an override can never exist without the record
      // of who granted it and why. That guarantee is the point of the feature.
      await tx.platformAuditLog.create({
        data: {
          reason: updated.overrideReason || 'commercial terms cleared',
          action: 'platform.commercials.updated',
          actorIdentityId: req.platformUser!.id,
          actorEmail: req.platformUser!.email,
          targetOrgId: updated.id,
          targetOrgName: updated.name,
          beforeState: before as never,
          afterState: updated as never,
          ipAddress: req.ip,
        },
      });
      return updated;
    });

    const effective = await resolveEntitlements(after.id);
    res.json({ organization: after, effective });
  } catch (err) {
    if (isCommercialTermsError(err)) return res.status(400).json({ error: err.message });
    logger.error('Commercial terms update failed', {
      organizationId: req.params.id,
      error: String(err),
    });
    res.status(500).json({ error: 'Server error' });
  }
});

/** Commercial terms plus the resolved entitlement, for the console dialog. */
router.get('/subscribers/:id/commercials', requirePlatformOwner, async (req, res) => {
  try {
    const organization = await prisma.organization.findUnique({
      where: { id: req.params.id },
      select: COMMERCIAL_SELECT,
    });
    if (!organization) return res.status(404).json({ error: 'Subscriber not found' });
    // Resolved to an email rather than returning a raw Identity cuid: a bare id
    // in a UI reads as unfinished. overrideSetBy has no FK on purpose (an audit
    // trail must outlive the actor), so this may legitimately come back null.
    const setBy = organization.overrideSetBy
      ? await prisma.identity.findUnique({
          where: { id: organization.overrideSetBy },
          select: { email: true },
        })
      : null;
    res.json({
      organization: { ...organization, overrideSetByEmail: setBy?.email ?? null },
      effective: await resolveEntitlements(organization.id),
    });
  } catch (err) {
    logger.error('Commercial terms read failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/** Recent commercial changes for one subscriber — platform scope only. */
router.get('/subscribers/:id/commercials/history', requirePlatformOwner, async (req, res) => {
  try {
    const entries = await prisma.platformAuditLog.findMany({
      where: { targetOrgId: req.params.id, action: 'platform.commercials.updated' },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });
    res.json(entries);
  } catch (err) {
    logger.error('Commercial history read failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
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

/**
 * Give a trial more time, for a pilot or a sales conversation.
 *
 * Extends from *now* rather than from the old deadline. Adding hours to a
 * deadline that passed last night would grant a subscriber who is currently
 * locked out an extension that is also already over, and the owner would be
 * left clicking a button that visibly does nothing.
 *
 * Nothing else has to be undone: expiry is decided at read time, so moving the
 * date is the whole operation — no status to un-flip, no gateway to resume.
 */
router.post('/subscribers/:id/billing/extend-trial', requirePlatformOwner, async (req, res) => {
  try {
    const hours = Number(req.body.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
      return res.status(400).json({ error: 'Extension must be between 0 and 8760 hours' });
    }

    const organization = await prisma.organization.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!organization) return res.status(404).json({ error: 'Subscriber not found' });

    const subscription = await prisma.subscription.findFirst({
      where: { organizationId: req.params.id, status: 'TRIALING' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, trialEndsAt: true },
    });
    if (!subscription) {
      // Not an error worth a 500: a converted or cancelled subscriber simply
      // has no trial to extend, and saying so is more use than 'failed'.
      return res.status(409).json({ error: 'This subscriber is not on a trial' });
    }

    const trialEndsAt = new Date(Date.now() + hours * 3600_000);
    // In one transaction so an extension can never exist without the record of
    // who granted it — the same guarantee the commercial overrides above rely
    // on, and for the same reason: this is a decision someone has to answer for.
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: subscription.id }, data: { trialEndsAt } });
      await tx.platformAuditLog.create({
        data: {
          reason: String(req.body.reason || 'trial extended'),
          action: 'platform.trial.extended',
          actorIdentityId: req.platformUser!.id,
          actorEmail: req.platformUser!.email,
          targetOrgId: organization.id,
          targetOrgName: organization.name,
          beforeState: { trialEndsAt: subscription.trialEndsAt } as never,
          afterState: { trialEndsAt, hours } as never,
        },
      });
    });
    res.json({ organizationId: req.params.id, trialEndsAt: trialEndsAt.toISOString() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to extend the trial' });
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

/**
 * POST /api/platform/gateway/health-check/:orgId
 *
 * Run a probe now. `probe` defaults to 'status' — the free HTTP poll.
 *
 * Passing `probe: 'selfSend'` sends a REAL WhatsApp message to that
 * subscriber's own number. It is an internal probe: platform traffic, never
 * sent to a customer, and not charged to the tenant. It is exposed manually
 * because verifying the outbound path after a fix is exactly when you want it
 * on demand — that is the fault a status poll cannot see.
 */
router.post('/gateway/health-check/:orgId', requirePlatformOwner, async (req, res) => {
  try {
    const probe = req.body?.probe === 'selfSend' ? 'selfSend' : 'status';
    const result = await probeOrganization(req.params.orgId, probe);
    res.json(result);
  } catch (err) {
    logger.error('Manual gateway health check failed', {
      organizationId: req.params.orgId,
      error: String(err),
    });
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /api/platform/gateway/health
 *
 * Latest probe result per organization plus any open alert, for the console.
 */
router.get('/gateway/health', requirePlatformOwner, async (_req, res) => {
  try {
    const [recent, alerts] = await Promise.all([
      prisma.gatewayHealthCheck.findMany({
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: { organizationId: true, probe: true, ok: true, error: true, latencyMs: true, createdAt: true },
      }),
      prisma.platformAlert.findMany({
        where: { type: 'GATEWAY_UNHEALTHY' },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    // Collapse to the newest row per org+probe. Done here rather than with a
    // distinct-on query because $queryRaw would bypass the tenancy extension,
    // and the row count is bounded by the take above.
    const latest = new Map<string, (typeof recent)[number]>();
    for (const row of recent) {
      const key = `${row.organizationId}--${row.probe}`;
      if (!latest.has(key)) latest.set(key, row);
    }

    res.json({ latest: [...latest.values()], alerts });
  } catch (err) {
    logger.error('Gateway health read failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

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


// ── Dunning ────────────────────────────────────────────────────────────────

/** The grace period, in days, between an invoice going overdue and cut-off. */
/**
 * How long every *new* signup gets.
 *
 * Separate from extending one subscriber's trial, which is a sales decision
 * about one workspace. This is the product's offer, and it was configurable
 * in the database and nowhere else.
 */
router.get('/trial/settings', requirePlatformOwner, async (_req, res) => {
  res.json({ hours: await getTrialHours(), planCode: await getTrialPlanCode() });
});

router.patch('/trial/settings', requirePlatformOwner, async (req, res) => {
  try {
    const actor = req.platformUser!.email;
    const hours = req.body.hours === undefined ? undefined : Number(req.body.hours);
    if (hours !== undefined) await setTrialHours(hours, actor);
    if (req.body.planCode !== undefined) await setTrialPlanCode(String(req.body.planCode), actor);
    // Changing the offer affects nobody mid-trial: the deadline is stamped
    // once at signup, so this cannot retroactively expire anyone.
    res.json({ hours: await getTrialHours(), planCode: await getTrialPlanCode() });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message || 'Failed to update trial settings' });
  }
});

router.get('/dunning/settings', requirePlatformOwner, async (_req, res) => {
  res.json({ graceDays: await getDunningGraceDays() });
});

router.patch('/dunning/settings', requirePlatformOwner, async (req, res) => {
  try {
    const graceDays = await setDunningGraceDays(Number(req.body?.graceDays), req.platformUser!.id);
    await auditPlatformScope('dunning grace period set to ' + graceDays + ' days', {
      action: 'platform.dunning.settings',
      actorIdentityId: req.platformUser!.id,
      actorEmail: req.platformUser!.email,
      afterState: { graceDays },
      ipAddress: req.ip,
    });
    res.json({ graceDays });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/**
 * Run the pass now.
 *
 * It runs itself every half hour; this is for an owner who has just changed
 * the grace period or settled something and wants the state to catch up
 * while they are looking at it.
 */
router.post('/dunning/run', requirePlatformOwner, async (req, res) => {
  try {
    const result = await runDunning();
    await auditPlatformScope('dunning pass run manually', {
      action: 'platform.dunning.run',
      actorIdentityId: req.platformUser!.id,
      actorEmail: req.platformUser!.email,
      afterState: result,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) {
    logger.error('Manual dunning run failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Finance ────────────────────────────────────────────────────────────────
//
// Every route below is owner-only and writes a PlatformAuditLog row. Money
// moving through a system with no record of who moved it is the failure mode
// this console exists to prevent, and a platform owner has no User row in the
// subscriber's organization, so the tenant-scoped AuditLog cannot carry these.

/** Name on issued documents. Set per deployment; falls back to the product. */
const ISSUER_NAME = process.env.PLATFORM_ISSUER_NAME || 'RabiTech';

/**
 * The subscriber a finance route is acting on, with an address to put on the
 * document.
 *
 * Organization has no owner email of its own, so the workspace's admin is
 * used. `findFirst` ordered by creation because a workspace can have several
 * admins and the founding one is the one whose name is on the account.
 */
async function subscriberOr404(id: string) {
  const organization = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, name: true },
  });
  if (!organization) return null;

  const admin = await prisma.user.findFirst({
    where: { organizationId: id, role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    // The address lives on Identity, not User: a person signs in once and can
    // hold a User row in several workspaces.
    select: { identity: { select: { email: true } } },
  });

  return { ...organization, ownerEmail: admin?.identity?.email ?? null };
}

router.get('/subscribers/:id/finance', requirePlatformOwner, async (req, res) => {
  try {
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const documents = await listFinanceDocuments(subscriber.id);
    const outstandingCents = documents
      .filter((doc) => doc.kind === 'invoice')
      .reduce((sum, doc) => sum + (doc.amountCents - doc.amountPaidCents), 0);

    res.json({ subscriber, documents, outstandingCents });
  } catch (err) {
    logger.error('Finance list failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/subscribers/:id/invoices', requirePlatformOwner, async (req, res) => {
  try {
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    // Cents from the client, never a float. A price typed as 49.99 and parsed
    // as a float is 4998.999… cents, and a ledger that rounds is a ledger that
    // eventually disagrees with the bank.
    const amountCents = Number(req.body?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amountCents must be a positive whole number of cents' });
    }
    const currency = String(req.body?.currency || 'USD').toUpperCase().slice(0, 3);
    const dueAt = req.body?.dueAt ? new Date(req.body.dueAt) : null;
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      return res.status(400).json({ error: 'dueAt is not a valid date' });
    }

    const subscription = await prisma.subscription.findFirst({
      where: { organizationId: subscriber.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    const invoice = await createInvoice({
      organizationId: subscriber.id,
      amountCents,
      currency,
      dueAt,
      subscriptionId: subscription?.id ?? null,
    });

    await auditPlatformScope(
      'invoice ' + invoice.invoiceRef + ' issued for ' + formatMoney(amountCents, currency),
      {
        action: 'platform.invoice.issued',
        actorIdentityId: req.platformUser!.id,
        actorEmail: req.platformUser!.email,
        targetOrgId: subscriber.id,
        targetOrgName: subscriber.name,
        afterState: invoice,
        ipAddress: req.ip,
      },
    );

    res.status(201).json(invoice);
  } catch (err) {
    logger.error('Invoice issue failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Record a payment against an invoice. The receipt is issued by the same
 * transaction — see recordPayment() for why neither half is allowed alone.
 */
router.post('/subscribers/:id/invoices/:invoiceId/payments', requirePlatformOwner, async (req, res) => {
  try {
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const amountCents = Number(req.body?.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return res.status(400).json({ error: 'amountCents must be a positive whole number of cents' });
    }
    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      return res.status(400).json({ error: 'paidAt is not a valid date' });
    }

    const { receipt, invoice } = await recordPayment({
      organizationId: subscriber.id,
      invoiceId: req.params.invoiceId,
      amountCents,
      method: String(req.body?.method || 'other').slice(0, 40),
      externalRef: req.body?.externalRef ? String(req.body.externalRef).slice(0, 120) : null,
      note: req.body?.note ? String(req.body.note).slice(0, 500) : null,
      paidAt,
      issuedByEmail: req.platformUser!.email,
    });

    /*
     * Out of dunning the moment the balance clears.
     *
     * The scheduled pass would get there within half an hour; a customer who
     * has just paid should not spend that half hour watching a suspension
     * countdown they no longer deserve.
     */
    if (!(await hasOverdueBalance(subscriber.id))) {
      const before = await prisma.organization.findUnique({
        where: { id: subscriber.id },
        select: { status: true, suspendAt: true },
      });

      if (before?.suspendAt) {
        await prisma.organization.update({
          where: { id: subscriber.id },
          data: {
            suspendAt: null,
            suspendReason: null,
            // Restore only what dunning stopped: a deadline that had already
            // passed. An owner's manual suspension is their decision and
            // paying an invoice does not reverse it.
            ...(before.status === 'SUSPENDED' && before.suspendAt <= new Date()
              ? { status: 'ACTIVE' as const }
              : {}),
          },
        });

        if (before.status === 'SUSPENDED' && before.suspendAt <= new Date()) {
          await prisma.subscription.updateMany({
            where: { organizationId: subscriber.id, status: 'PAST_DUE' },
            data: { status: 'ACTIVE' },
          });
          await queueGatewayAction(subscriber.id, 'resume');
        }
      }
    }

    await auditPlatformScope(
      'payment ' + formatMoney(amountCents, receipt.currency) + ' recorded, receipt ' + receipt.reference,
      {
        action: 'platform.payment.recorded',
        actorIdentityId: req.platformUser!.id,
        actorEmail: req.platformUser!.email,
        targetOrgId: subscriber.id,
        targetOrgName: subscriber.name,
        afterState: { receipt, invoice },
        ipAddress: req.ip,
      },
    );

    res.status(201).json({ receipt, invoice });
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    logger.error('Payment record failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/** One document, as a printable HTML file the browser downloads. */
router.get('/subscribers/:id/finance/:kind/:documentId', requirePlatformOwner, async (req, res) => {
  try {
    const { kind } = req.params;
    if (kind !== 'invoice' && kind !== 'receipt') {
      return res.status(400).json({ error: 'Unknown document kind' });
    }
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const shared = {
      issuerName: ISSUER_NAME,
      subscriberName: subscriber.name,
      subscriberEmail: subscriber.ownerEmail,
    };

    let html: string;
    let filename: string;

    if (kind === 'invoice') {
      const invoice = await prisma.invoice.findFirst({
        where: { id: req.params.documentId, organizationId: subscriber.id },
      });
      if (!invoice) return res.status(404).json({ error: 'Document not found' });
      const reference = invoice.invoiceRef || invoice.id;
      filename = reference + '.html';
      html = renderFinanceDocument({
        ...shared,
        kind: 'invoice',
        reference,
        amountCents: invoice.amountDueCents,
        amountPaidCents: invoice.amountPaidCents,
        currency: invoice.currency,
        dateLabel: 'Issued',
        date: invoice.createdAt,
        dueAt: invoice.dueAt,
        method: null,
        externalRef: null,
        note: null,
      });
    } else {
      const receipt = await prisma.paymentReceipt.findFirst({
        where: { id: req.params.documentId, organizationId: subscriber.id },
      });
      if (!receipt) return res.status(404).json({ error: 'Document not found' });
      filename = receipt.reference + '.html';
      html = renderFinanceDocument({
        ...shared,
        kind: 'receipt',
        reference: receipt.reference,
        amountCents: receipt.amountCents,
        amountPaidCents: null,
        currency: receipt.currency,
        dateLabel: 'Paid',
        date: receipt.paidAt,
        dueAt: null,
        method: receipt.method,
        externalRef: receipt.externalRef,
        note: receipt.note,
      });
    }

    // attachment, not inline: this is a document the owner keeps, and a page
    // that merely opens in a tab is one refresh away from being gone.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(html);
  } catch (err) {
    logger.error('Document render failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/** The whole ledger for one subscriber, as CSV. */
router.get('/subscribers/:id/finance-export.csv', requirePlatformOwner, async (req, res) => {
  try {
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const documents = await listFinanceDocuments(subscriber.id);
    const csv = renderFinanceCsv(
      documents.map((doc) => ({
        kind: doc.kind,
        reference: doc.reference,
        status: doc.status,
        // Major units in the export: this file is opened in a spreadsheet by a
        // person, not parsed by the code that stores cents.
        amount: (doc.amountCents / 100).toFixed(2),
        paid: (doc.amountPaidCents / 100).toFixed(2),
        currency: doc.currency,
        issued_at: doc.issuedAt.slice(0, 10),
        effective_at: doc.effectiveAt?.slice(0, 10) ?? '',
        method: doc.method ?? '',
        note: doc.note ?? '',
      })),
      ['kind', 'reference', 'status', 'amount', 'paid', 'currency', 'issued_at', 'effective_at', 'method', 'note'],
    );

    await auditPlatformScope('finance ledger exported for ' + subscriber.name, {
      action: 'platform.finance.exported',
      actorIdentityId: req.platformUser!.id,
      actorEmail: req.platformUser!.email,
      targetOrgId: subscriber.id,
      targetOrgName: subscriber.name,
      ipAddress: req.ip,
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="finance-' + subscriber.id + '.csv"');
    res.send(csv);
  } catch (err) {
    logger.error('Finance export failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
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
