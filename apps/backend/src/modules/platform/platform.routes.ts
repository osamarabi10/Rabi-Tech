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
import { PLAN_CODE_PATTERN, RESERVED_PLAN_CODES, normalizePlanCode } from '../billing/plans';
import { getEdition, refreshEditions } from '../billing/editions.service';
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
  voidInvoice,
} from './finance.service';
import { CurrencyPolicyError, assertSellableCurrency } from '../billing/currency-policy';
import { renderFinanceCsv, renderFinanceDocument } from './finance.document';
import { hasOverdueBalance } from './finance.service';
import {
  getDunningGraceDays,
  runDunning,
  setDunningGraceDays,
} from '../billing/dunning.service';
import { getTrialHours, setTrialHours, getTrialPlanCode, setTrialPlanCode } from '../billing/trial.service';
import {
  ALL_PLATFORM_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  SUGGESTED_ADVISOR_PERMISSIONS,
  hasPlatformPermission,
  isPlatformPermission,
  type PlatformPermission,
} from './platform-permissions';

const router = Router();

/** Unknown permission strings are dropped, not stored. */
function normalizePermissions(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map(String).filter(isPlatformPermission))];
}

/**
 * Every staff change is written down.
 *
 * Who can see every subscriber in the system is exactly the question an
 * owner will be asked one day, and "I think so" is not an answer.
 */
async function auditStaff(
  req: Request,
  action: string,
  targetId: string,
  targetEmail: string,
  afterState: unknown,
) {
  await prisma.platformAuditLog.create({
    data: {
      reason: `${action} for ${targetEmail}`,
      action,
      actorIdentityId: req.platformUser!.id,
      actorEmail: req.platformUser!.email,
      targetOrgId: null,
      targetOrgName: targetEmail,
      afterState: { targetId, ...(afterState as object) } as never,
    },
  });
}

function requirePlatformOwner(req: Request, res: Response, next: NextFunction) {
  if (req.platformUser?.platformRole !== 'OWNER') {
    return res.status(403).json({ error: 'RabiTech owner access required' });
  }
  next();
}

/**
 * A route an advisor may reach if they were granted it.
 *
 * The owner passes everything without being listed anywhere — see
 * platform-permissions.ts for why. Everyone else needs the exact permission,
 * and the refusal names it so the owner reading a support ticket knows which
 * box to tick rather than guessing.
 */
function requirePlatformPermission(permission: PlatformPermission) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hasPlatformPermission(req.platformUser, permission)) return next();
    return res.status(403).json({
      error: 'This action is not part of your access',
      permission,
    });
  };
}

/**
 * Platform staff.
 *
 * Owner-only, and not grantable — an advisor who can manage staff can grant
 * themselves anything, and every other permission becomes decoration.
 *
 * Before this existed, hiring a support advisor meant an UPDATE against the
 * production database.
 */
router.get('/staff', requirePlatformOwner, async (_req, res) => {
  try {
    const staff = await prisma.identity.findMany({
      where: { platformRole: { in: ['OWNER', 'SUPPORT'] } },
      orderBy: [{ platformRole: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        email: true,
        platformRole: true,
        platformPermissions: true,
        platformDisabledAt: true,
        createdAt: true,
      },
    });
    res.json({ staff, catalogue: PLATFORM_PERMISSIONS, suggested: SUGGESTED_ADVISOR_PERMISSIONS });
  } catch (error) {
    logger.error('Staff list failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to load staff' });
  }
});

router.post('/staff', requirePlatformOwner, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const permissions = normalizePermissions(req.body.permissions);

    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (password.length < 12) {
      // Longer than a tenant user, deliberately: this account can read every
      // subscriber in the system.
      return res.status(400).json({ error: 'Staff passwords must be at least 12 characters' });
    }

    const existing = await prisma.identity.findUnique({ where: { email } });
    if (existing) {
      /*
       * An existing identity is promoted rather than duplicated.
       *
       * Email is globally unique and is how someone signs in, so a second row
       * is impossible anyway — but refusing outright would leave the owner
       * unable to make an advisor out of someone who already has a workspace
       * account, which is the normal case for a small team.
       */
      if (existing.platformRole === 'OWNER') {
        return res.status(409).json({ error: 'That address already belongs to an owner' });
      }
      const promoted = await prisma.identity.update({
        where: { id: existing.id },
        data: { platformRole: 'SUPPORT', platformPermissions: permissions, platformDisabledAt: null },
        select: { id: true, email: true, platformRole: true, platformPermissions: true },
      });
      await auditStaff(req, 'platform.staff.promoted', promoted.id, email, { permissions });
      return res.status(200).json(promoted);
    }

    const created = await prisma.identity.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        platformRole: 'SUPPORT',
        platformPermissions: permissions,
      },
      select: { id: true, email: true, platformRole: true, platformPermissions: true },
    });
    await auditStaff(req, 'platform.staff.created', created.id, email, { permissions });
    res.status(201).json(created);
  } catch (error) {
    logger.error('Staff create failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to create staff account' });
  }
});

router.patch('/staff/:id', requirePlatformOwner, async (req, res) => {
  try {
    const target = await prisma.identity.findUnique({
      where: { id: req.params.id },
      select: { id: true, email: true, platformRole: true },
    });
    if (!target) return res.status(404).json({ error: 'Staff account not found' });
    if (target.platformRole === 'OWNER') {
      // The owner is not editable through the staff screen. There is no
      // version of this product where the person who owns it can be locked
      // out of it by a mis-click on a permission list.
      return res.status(403).json({ error: 'The owner account cannot be edited here' });
    }

    const data: Record<string, unknown> = {};
    if (req.body.permissions !== undefined) data.platformPermissions = normalizePermissions(req.body.permissions);
    if (req.body.disabled !== undefined) {
      data.platformDisabledAt = req.body.disabled ? new Date() : null;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nothing to change' });

    const updated = await prisma.identity.update({
      where: { id: target.id },
      data,
      select: { id: true, email: true, platformRole: true, platformPermissions: true, platformDisabledAt: true },
    });
    await auditStaff(req, 'platform.staff.updated', target.id, target.email, data);
    res.json(updated);
  } catch (error) {
    logger.error('Staff update failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to update staff account' });
  }
});

router.get('/subscribers', requirePlatformPermission('subscriber:read'), async (req, res) => {
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
    logger.error('Subscriber list failed', { error: err instanceof Error ? err.stack : String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to list subscribers' });
  }
});

router.get('/billing/summary', requirePlatformPermission('billing:view'), async (req, res) => {
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
      return sum + getEdition(code).monthlyPriceCents;
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
          .reduce((sum, t) => sum + getEdition(normalizePlanCode(t.planCode)).monthlyPriceCents, 0),
      },
      byTier: paid.reduce<Record<string, number>>((acc, subscription) => {
        acc[subscription.planCode] = (acc[subscription.planCode] || 0) + 1;
        return acc;
      }, {}),
    });
  } catch (error) {
    logger.error('Platform billing summary failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to load billing summary' });
  }
});

router.get('/subscribers/:id/usage', requirePlatformPermission('subscriber:read'), async (req, res) => {
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
  } catch (error) {
    logger.error('Subscriber usage failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
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
    logger.error('Subscriber creation failed', { error: err instanceof Error ? err.stack : String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to create subscriber' });
  }
});

router.patch('/subscribers/:id/status', requirePlatformPermission('subscriber:suspend'), async (req, res) => {
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
router.patch('/subscribers/:id/commercials', requirePlatformPermission('commercials:manage'), async (req, res) => {
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
router.get('/subscribers/:id/commercials', requirePlatformPermission('billing:view'), async (req, res) => {
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

router.post('/subscribers/:id/billing/activate', requirePlatformPermission('billing:activate'), async (req, res) => {
  try {
    // No default. An owner activating a subscription is choosing what the
    // subscriber will be billed for, and silently choosing Growth on their
    // behalf is a commercial decision made by an omission. The console's three
    // activation buttons all send a plan code, so this refuses only a caller
    // that genuinely did not say.
    if (!req.body?.planCode) {
      return res.status(400).json({ error: 'planCode is required to activate a subscription' });
    }
    const planCode = normalizePlanCode(req.body.planCode);
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
router.post('/subscribers/:id/billing/extend-trial', requirePlatformPermission('trial:extend'), async (req, res) => {
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
    logger.error('Trial extension failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to extend the trial' });
  }
});

router.post('/subscribers/:id/billing/mark-failed', requirePlatformOwner, async (req, res) => {
  try {
    await markPaymentFailed(req.params.id, String(req.body.reason || 'Manual payment failure'));
    res.status(202).json({ organizationId: req.params.id, status: 'PAST_DUE' });
  } catch (error) {
    logger.error('Payment failure marking failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(503).json({ error: 'Failed to mark payment failed' });
  }
});

router.post('/subscribers/:id/billing/cancel', requirePlatformOwner, async (req, res) => {
  try {
    await cancelCurrentSubscription(req.params.id);
    res.status(202).json({ organizationId: req.params.id, status: 'CANCELED' });
  } catch (error) {
    logger.error('Subscription cancellation failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
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

router.post('/subscribers/:id/gateway/retry', requirePlatformPermission('gateway:operate'), async (req, res) => {
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
  } catch (error) {
    logger.error('Gateway retry queue failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(503).json({ error: 'Failed to queue gateway retry' });
  }
});

router.post('/subscribers/:id/gateway/suspend', requirePlatformPermission('gateway:suspend'), async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'suspend');
  } catch (error) {
    logger.error('Gateway suspension queue failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(503).json({ error: 'Failed to queue gateway suspension' });
  }
});

router.post('/subscribers/:id/gateway/resume', requirePlatformPermission('gateway:operate'), async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'resume');
  } catch (error) {
    logger.error('Gateway resume queue failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(503).json({ error: 'Failed to queue gateway resume' });
  }
});

router.post('/subscribers/:id/gateway/restart', requirePlatformPermission('gateway:operate'), async (req, res) => {
  try {
    await queueOwnerAction(req, res, 'restart');
  } catch (error) {
    logger.error('Gateway restart queue failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
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

router.get('/subscribers/:id/finance', requirePlatformPermission('billing:view'), async (req, res) => {
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
    // No default. An invoice silently issued in USD because the caller omitted
    // a currency is wrong by the exchange rate, and nothing downstream can
    // detect it — the amount is a well-formed number either way. The allowlist
    // comes from the active plans, so it cannot drift from what is sold.
    const currency = await assertSellableCurrency(req.body?.currency);
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
    // A refused currency is the caller's mistake, not a server fault, and the
    // message names the currencies that would have worked. Logging it at error
    // and returning 500 would tell the operator nothing they can act on.
    if (err instanceof CurrencyPolicyError) {
      return res.status(err.status).json({ error: err.message });
    }
    logger.error('Invoice issue failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Withdraw an invoice. There is deliberately no DELETE counterpart.
 *
 * An invoice that is deleted takes its reference out of the record while the
 * numbers either side of it keep implying it existed. Voiding leaves the
 * document, its number and the decision to withdraw it all visible, which is
 * what anyone auditing the ledger later actually needs.
 */
router.post('/subscribers/:id/invoices/:invoiceId/void', requirePlatformOwner, async (req, res) => {
  try {
    const subscriber = await subscriberOr404(req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'Subscriber not found' });

    const invoice = await voidInvoice({
      organizationId: subscriber.id,
      invoiceId: req.params.invoiceId,
    });

    await auditPlatformScope(
      'invoice ' + invoice.invoiceRef + ' voided',
      {
        action: 'platform.invoice.voided',
        actorIdentityId: req.platformUser!.id,
        actorEmail: req.platformUser!.email,
        targetOrgId: subscriber.id,
        targetOrgName: subscriber.name,
        afterState: invoice,
        ipAddress: req.ip,
      },
    );

    res.json(invoice);
  } catch (err) {
    if (err instanceof PaymentError) return res.status(err.status).json({ error: err.message });
    logger.error('Invoice void failed', { organizationId: req.params.id, error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Record a payment against an invoice. The receipt is issued by the same
 * transaction — see recordPayment() for why neither half is allowed alone.
 */
router.post('/subscribers/:id/invoices/:invoiceId/payments', requirePlatformPermission('billing:record-payment'), async (req, res) => {
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
  } catch (error) {
    logger.error('Subscriber destruction queue failed', { error: error instanceof Error ? error.stack : String(error), requestId: (req as any).id });
    res.status(503).json({ error: 'Failed to queue subscriber destruction' });
  }
});


/**
 * The edition catalogue: the product's offer, not one subscriber's deal.
 *
 * Distinct from /subscribers/:id/commercials, which grants one workspace an
 * exception. This changes the menu everyone is sold from, so it is owner-only
 * and it takes effect without a deploy - which was the entire point of moving
 * the catalogue out of a TypeScript constant.
 */
router.get('/editions', requirePlatformOwner, async (_req, res) => {
  const editions = await prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  // Both of the caveats this used to carry are gone: autoProvisionGateway now
  // decides gateway provisioning at activation, and allowedChannels is checked
  // when a channel is connected or activated. Every switch on this screen
  // grants something.
  res.json({ editions, notEnforced: [] });
});

/**
 * What an edition used to be.
 *
 * The record already existed — every edition change writes a PlatformAuditLog
 * row with full beforeState and afterState snapshots, the actor and a
 * timestamp — and there was simply no way to read it back. This is that way.
 *
 * Owner-only and shaped like /subscribers/:id/commercials/history, which
 * answers the same question one workspace at a time. The one difference is the
 * handle: commercials filter on targetOrgId, and an edition change sets that
 * null deliberately, so this filters on targetEditionCode instead.
 *
 * `?code=` narrows to one edition; without it, the whole catalogue's history,
 * newest first. Both are served by an index rather than by scanning.
 *
 * Answers the question `Plan.updatedAt` cannot: that column says a change
 * happened and never what it was.
 */
router.get('/editions/history', requirePlatformOwner, async (req, res) => {
  try {
    const code = typeof req.query.code === 'string' && req.query.code.trim()
      ? req.query.code.trim().toUpperCase()
      : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const entries = await prisma.platformAuditLog.findMany({
      where: code
        ? { targetEditionCode: code }
        : { action: { in: ['platform.edition.updated', 'platform.edition.created'] } },
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    /*
      The diff is computed here rather than in the console, so every reader of
      this history sees the same answer to "what actually changed". Two clients
      deriving it separately is how one of them starts showing a field the other
      does not.

      Fields whose values are equal are omitted: an edition row carries around
      thirty columns and a price change touches one of them, so returning all
      thirty would bury the answer in its own context.
    */
    const changes = entries.map((entry) => {
      const before = (entry.beforeState ?? null) as Record<string, unknown> | null;
      const after = (entry.afterState ?? null) as Record<string, unknown> | null;
      const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
      const diff: Array<{ field: string; before: unknown; after: unknown }> = [];
      for (const key of keys) {
        // updatedAt moves on every write by definition; reporting it as a
        // change would put a row in every diff that means nothing.
        if (key === 'updatedAt') continue;
        const from = before ? before[key] : undefined;
        const to = after ? after[key] : undefined;
        if (JSON.stringify(from) !== JSON.stringify(to)) diff.push({ field: key, before: from, after: to });
      }
      return {
        id: entry.id,
        action: entry.action,
        editionCode: entry.targetEditionCode,
        at: entry.timestamp.toISOString(),
        actorEmail: entry.actorEmail,
        reason: entry.reason,
        changes: diff,
      };
    });

    res.json({ entries: changes });
  } catch (error) {
    logger.error('Edition history read failed', { error: String(error) });
    res.status(500).json({ error: 'Failed to read edition history' });
  }
});

/** A limit is a non-negative integer, or null meaning unlimited. */
function parseLimit(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative whole number, or empty for unlimited`), { status: 400 });
  }
  return parsed;
}

/** Channel kinds the product actually has. Mirrors ChannelKind in channels. */
const KNOWN_CHANNEL_KINDS = ['OPENWA', 'WHATSAPP_CLOUD'] as const;

function parseFlag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  return Boolean(value);
}

/** Mirrors the PricingModel enum in schema.prisma. */
const PRICING_MODELS = ['FREE', 'FIXED', 'NEGOTIATED'] as const;

/**
 * The price/pricingModel invariants, enforced against the row **as it will be
 * after this write** rather than against the patch in isolation.
 *
 * That distinction is the whole reason this is a separate step. A PATCH can
 * carry either field alone: setting GROWTH to FREE while its price stays at
 * 4900, or setting a FIXED edition's price to 0, each produce an inconsistent
 * row while looking locally reasonable. Checking the merged result catches both;
 * checking the patch catches neither.
 *
 * These were established when pricingModel landed and were enforced only at
 * seed time, which meant the console could write states the constant could not.
 *
 *   FIXED       price > 0    an edition sold at a list price
 *   FREE        price = 0    not sold
 *   NEGOTIATED  price = 0    sold, but the number lives in the contract
 *
 * NEGOTIATED coerces rather than refuses, because a price is not a fact about a
 * negotiated edition — ENTERPRISE stores 0 and always has. Refusing a supplied
 * price would make the caller delete a field to satisfy a rule that intends to
 * ignore it.
 */
function applyPricingInvariant(
  data: Record<string, unknown>,
  current: { pricingModel: string; monthlyPriceCents: number } | null,
): void {
  const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
  // FIXED is the column default, so a create naming no model is a FIXED one and
  // has to satisfy FIXED's rule rather than slipping past unchecked.
  const model = String(data.pricingModel ?? current?.pricingModel ?? 'FIXED');
  const price = Number(data.monthlyPriceCents ?? current?.monthlyPriceCents ?? 0);

  if (model === 'NEGOTIATED') {
    data.monthlyPriceCents = 0;
    return;
  }
  if (model === 'FREE' && price !== 0) {
    throw bad('A FREE edition must be priced at 0. Use FIXED for an edition with a list price.');
  }
  if (model === 'FIXED' && price <= 0) {
    throw bad('A FIXED edition must be priced above 0. Use FREE for an unsold edition, or NEGOTIATED for one priced by agreement.');
  }
}

/**
 * Parse the editable edition fields out of a request body into a Prisma `data`
 * object, leaving anything the caller did not send untouched.
 *
 * Shared by PATCH and POST so the two cannot drift. Two copies of these rules
 * would eventually disagree, and the shape that disagreement takes is a field
 * that can be set when an edition is created and never corrected afterwards, or
 * the reverse — both of which get discovered by an owner, in production.
 *
 * Throws with a `status` instead of writing a response, so both callers report
 * it through the same catch.
 */
function applyEditionFields(body: Record<string, unknown>, data: Record<string, unknown>): void {
  const bad = (message: string) => Object.assign(new Error(message), { status: 400 });

  // Both of these used to be refused because nothing read them. Both are now
  // enforced — autoProvisionGateway at activation, allowedChannels when a
  // channel is connected or activated — so setting them grants something.
  const autoProvision = parseFlag(body.autoProvisionGateway);
  if (autoProvision !== undefined) data.autoProvisionGateway = autoProvision;

  if (body.allowedChannels !== undefined) {
    if (!Array.isArray(body.allowedChannels)) throw bad('allowedChannels must be a list of channel kinds');
    const kinds = [...new Set(body.allowedChannels.map((kind: unknown) => String(kind).trim().toUpperCase()))];
    const unknown = kinds.filter((kind) => !KNOWN_CHANNEL_KINDS.includes(kind as (typeof KNOWN_CHANNEL_KINDS)[number]));
    if (unknown.length) throw bad(`Unknown channel kind: ${unknown.join(', ')}`);
    // An edition allowing nothing is a subscriber who cannot message anyone,
    // which is never a deliberate offer.
    if (kinds.length === 0) throw bad('An edition must allow at least one channel');
    data.allowedChannels = kinds;
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw bad('Name is required');
    data.name = name;
  }
  const price = parseLimit(body.monthlyPriceCents, 'Monthly price');
  if (price !== undefined) {
    if (price === null) throw bad('Monthly price is required; use 0 for a free or negotiated edition');
    data.monthlyPriceCents = price;
  }

  /*
    Whether an edition is billable at all, and therefore settable from the
    console rather than only by a direct database write.

    This is not a display field. isPaidPlan reads pricingModel, and it decides
    whether a signup opens a checkout session, whether a subscription starts
    TRIALING, whether dunning may suspend, and whether an edition may be used as
    the trial plan. Moving an edition to FREE stops it collecting money.

    The invariant against price is applied separately, by applyPricingInvariant,
    because it has to see the row this patch produces rather than the patch.
  */
  if (body.pricingModel !== undefined) {
    const model = String(body.pricingModel).trim().toUpperCase();
    if (!(PRICING_MODELS as readonly string[]).includes(model)) {
      throw bad(`pricingModel must be one of ${PRICING_MODELS.join(', ')}`);
    }
    data.pricingModel = model;
  }
  for (const field of [
    'monthlyActiveContactsLimit',
    'monthlyOutboundMessagesLimit',
    'monthlyCampaignSendsLimit',
    'customFieldsLimit',
    'usersLimit',
    'workflowsLimit',
    'monthlyAiTokensInLimit',
    'monthlyAiTokensOutLimit',
    'campaignRateMax',
    'campaignRateDurationMs',
  ] as const) {
    const parsed = parseLimit(body[field], field);
    if (parsed !== undefined) data[field] = parsed;
  }
  for (const flag of ['customDomain', 'whiteLabel', 'maskContactDetails'] as const) {
    const parsed = parseFlag(body[flag]);
    if (parsed !== undefined) data[flag] = parsed;
  }
  const isActive = parseFlag(body.isActive);
  if (isActive !== undefined) data.isActive = isActive;

  /*
    Archiving is a separate decision from withdrawing from sale, and stays one.

    `archivedAt` is strictly stronger than `isActive` in *effect*: the published
    set is `isActive && !archivedAt`, so an archived edition is already unsold
    and unlisted whatever `isActive` holds. Precisely because the filter already
    does that, forcing `isActive` false here would add no behaviour at all — and
    it would destroy something, namely the owner's separate decision about
    whether this edition was on sale before it was archived. Un-archiving could
    then only guess at it, and would guess wrong for every edition that was
    deliberately deactivated first.

    So the two columns move independently. Clearing `archivedAt` restores the
    edition to whatever `isActive` already said: back on sale in one action if
    it was active, back to "not sold, still listed" if the owner had also
    deactivated it — which is the state they chose and the state they get back.

    A boolean rather than a timestamp, because *when* an edition was withdrawn
    is a fact the server records, not a value a caller supplies.
  */
  const archived = parseFlag(body.archived);
  if (archived !== undefined) data.archivedAt = archived ? new Date() : null;

  // Ladder position is editable, because it is read as one. editionGranting and
  // channelRefusal both name an upgrade by taking the first edition that grants
  // a thing, so without this an edition created at the end of the ladder could
  // never be moved into the middle of it — and the owner would be told to buy
  // the dearest edition that happens to qualify.
  if (body.sortOrder !== undefined) {
    const parsed = Number(body.sortOrder);
    if (!Number.isInteger(parsed) || parsed < 0) throw bad('sortOrder must be a non-negative whole number');
    data.sortOrder = parsed;
  }
}

router.patch('/editions/:code', requirePlatformOwner, async (req, res) => {
  try {
    const code = normalizePlanCode(req.params.code);
    const body = (req.body || {}) as Record<string, unknown>;

    const data: Record<string, unknown> = {};
    applyEditionFields(body, data);

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'No editable fields supplied' });
    }

    const before = await prisma.plan.findUnique({ where: { code } });

    // Archiving stamps the moment it happened, and only when it actually
    // happens. Re-archiving an already-archived edition must not move the
    // timestamp: when an edition was withdrawn is a fact about the past, and a
    // second PATCH saying the same thing is not a second withdrawal.
    if (data.archivedAt instanceof Date && before?.archivedAt) {
      delete data.archivedAt;
    }

    // Only when this patch touches either half. An unrelated edit — a rename, a
    // limit — must not be refused because of a row that was already
    // inconsistent before anyone touched it.
    if (data.pricingModel !== undefined || data.monthlyPriceCents !== undefined) {
      applyPricingInvariant(data, before);
    }

    const updated = await prisma.plan.update({ where: { code }, data });

    // Make the change live in this process immediately rather than waiting for
    // the next scheduled refresh. Other processes pick it up within their
    // refresh interval; nobody has to restart anything.
    await refreshEditions();

    // Platform audit, not tenant audit: this changes the offer, not one
    // workspace. targetOrg stays null for the same reason - no subscriber was
    // acted on, and pretending otherwise would make the per-org trail lie.
    await prisma.platformAuditLog.create({
      data: {
        reason: `edition ${code} updated`,
        action: 'platform.edition.updated',
        // The handle this row is read back by. targetOrgId stays null on
        // purpose - no subscriber was acted on.
        targetEditionCode: code,
        actorIdentityId: req.platformUser!.id,
        actorEmail: req.platformUser!.email,
        beforeState: before as never,
        afterState: updated as never,
        ipAddress: req.ip,
      },
    });

    res.json({ edition: updated });
  } catch (error) {
    const status = (error as { status?: number }).status || 400;
    res.status(status).json({ error: (error as Error).message || 'Failed to update edition' });
  }
});

/**
 * The codes this endpoint is allowed to create.
 *
 * **It ships closed, and that is the feature.** Every code listed here already
 * exists as a row, so every create refuses today. The path is built, wired,
 * audited and exercised by the harness; what it is not yet permitted to do is
 * bring an edition into existence that the original five do not name.
 *
 * **Widening this set is the irreversible act.** Migration
 * `20260923090000_open_plan_code_space` dropped the CHECK constraint on
 * `Organization.planOverride`, and the HARD RULE in
 * docs/RESPONDIO-PARITY-CHECKPOINT.md says that migration must never be
 * reversed once any code outside the original five exists anywhere: `down.sql`
 * re-adds the constraint, `ADD CONSTRAINT` validates every existing row, and a
 * sixth code makes it fail *late* — after any code rollback has already
 * happened. The half that does not fail is worse: nothing constrains
 * `Plan.code`, so catalogue rows carrying new codes survive the reversal and
 * become unresolvable, and every subscriber on one is entitled to nothing while
 * the row still sits there looking present. Recovery past that point is
 * snapshot-restore or forward-fix, never a rollback.
 *
 * So the gate is one constant, in one place, and opening it is a decision
 * someone makes on purpose having read that rule. Applying the migration was
 * never the one-way door. Creating the sixth edition is.
 */
const CREATABLE_PLAN_CODES: ReadonlySet<string> = new Set([
  'FREE',
  'STANDARD',
  'GROWTH',
  'BUSINESS',
  'ENTERPRISE',
]);

/**
 * Create an edition.
 *
 * Owner-only, like the rest of the catalogue: this changes the menu everyone is
 * sold from rather than one workspace's deal.
 */
router.post('/editions', requirePlatformOwner, async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const code = String(body.code ?? '').trim().toUpperCase();

    // Format is checked directly rather than through normalizePlanCode, which
    // validates membership of the *loaded catalogue* — so it rejects every code
    // that does not already exist, which is every code a create could be for.
    if (!PLAN_CODE_PATTERN.test(code)) {
      return res.status(400).json({
        error: 'code must start with a letter and be 2-24 characters of A-Z, 0-9 or underscore',
      });
    }

    if (!CREATABLE_PLAN_CODES.has(code)) {
      // 409 rather than 400. The request is well-formed and the code is legal;
      // what refuses it is policy. A 400 would tell the caller they mistyped
      // something, and they can retype it all day without getting through.
      return res.status(409).json({
        error: `The edition code space is closed. ${code} is outside the five original editions, and opening it is a deliberate and irreversible step — see CREATABLE_PLAN_CODES in platform.routes.ts.`,
        code: 'PLAN_CODE_SPACE_CLOSED',
      });
    }

    /*
      Reserved before existing, so the refusal states the real reason.

      FREE is reserved and also happens to exist, so a create for it was already
      refused — as PLAN_EXISTS, which is the wrong reason and only accidentally
      the right outcome. That guard is load-bearing by coincidence: it holds
      only because ensurePlans always seeds FREE, and it fails silently the day
      anything changes that. Two overlapping guards where one is accidental
      break the day the accidental one moves.

      Distinct from PLAN_EXISTS because the remedy is different, and that is the
      whole reason to spend a second code on it. PLAN_EXISTS is a statement
      about current state — delete the row and the same create would succeed.
      PLAN_CODE_RESERVED is a statement about the code itself: deleting FREE
      would not make creating FREE legal. Both are 409 rather than 400 because
      both requests are well formed and legal in shape, and what refuses them is
      the server's state or policy, not anything the caller can retype.
    */
    if (RESERVED_PLAN_CODES.has(code)) {
      return res.status(409).json({
        error: `${code} is a reserved edition code and cannot be created or redefined.`,
        code: 'PLAN_CODE_RESERVED',
      });
    }

    const existing = await prisma.plan.findUnique({ where: { code } });
    if (existing) {
      return res.status(409).json({ error: `Edition ${code} already exists`, code: 'PLAN_EXISTS' });
    }

    const data: Record<string, unknown> = {};
    applyEditionFields(body, data);

    // The two the schema has no default for. Everything else may be omitted and
    // take its column default, which is what makes a minimal create legible.
    if (data.name === undefined) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (data.monthlyPriceCents === undefined) {
      return res.status(400).json({ error: 'Monthly price is required; use 0 for a free or negotiated edition' });
    }

    // No existing row to merge against: a create is judged entirely on what it
    // supplies, defaulting to the column's own FIXED.
    applyPricingInvariant(data, null);

    if (data.sortOrder === undefined) {
      // Appended past the current end of the ladder, explicitly. The column
      // defaults to 0, which would place a new edition level with FREE and
      // ahead of everything else — precisely the position that reads as
      // "cheapest" to editionGranting and channelRefusal, so a brand new
      // edition would become the upgrade every refusal recommends. Last rung
      // until an owner moves it, which PATCH now allows.
      const highest = await prisma.plan.aggregate({ _max: { sortOrder: true } });
      data.sortOrder = (highest._max.sortOrder ?? -1) + 1;
    }

    const created = await prisma.plan.create({
      data: {
        ...data,
        // Same id shape as ensurePlans. This is what PLAN_CODE_PATTERN's
        // charset exists to keep safe: the id has to be usable in a URL and a
        // filename.
        id: `plan_${code.toLowerCase()}`,
        code,
        name: data.name as string,
        monthlyPriceCents: data.monthlyPriceCents as number,
      } as Parameters<typeof prisma.plan.create>[0]['data'],
    });

    // Live in this process at once rather than at the next scheduled refresh,
    // the same as an edit. Other processes pick it up within their interval.
    await refreshEditions();

    // Platform audit, not tenant audit: this changes the offer, not one
    // workspace. No beforeState, because there was no edition before this.
    await prisma.platformAuditLog.create({
      data: {
        reason: `edition ${code} created`,
        action: 'platform.edition.created',
        targetEditionCode: code,
        actorIdentityId: req.platformUser!.id,
        actorEmail: req.platformUser!.email,
        afterState: created as never,
        ipAddress: req.ip,
      },
    });

    res.status(201).json({ edition: created });
  } catch (error) {
    const status = (error as { status?: number }).status || 400;
    res.status(status).json({ error: (error as Error).message || 'Failed to create edition' });
  }
});

export default router;
