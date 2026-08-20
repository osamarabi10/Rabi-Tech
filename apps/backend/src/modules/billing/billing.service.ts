import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { queueGatewayAction } from '../../workers/gateway-provisioning.queue';
import logger from '../../lib/logger';
import { getMetricUsage } from '../usage/usage.service';
import { getPaymentProvider } from './provider-registry';
import { isPaidPlan, normalizePlanCode, PLAN_ENTITLEMENTS, PlanCode } from './plans';
import { seedDefaultAutoReplies } from '../../utils/seed-auto-replies';

const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_IP_LIMIT = Number(process.env.SIGNUP_IP_HOURLY_LIMIT || 10);
const SIGNUP_DOMAIN_LIMIT = Number(process.env.SIGNUP_DOMAIN_HOURLY_LIMIT || 50);

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function appBaseUrl(): string {
  return (process.env.FRONTEND_PUBLIC_URL || process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

async function uniqueSlug(base: string): Promise<string> {
  const clean = slugify(base) || `org-${crypto.randomBytes(3).toString('hex')}`;
  for (let i = 0; i < 20; i += 1) {
    const candidate = i === 0 ? clean : `${clean}-${i + 1}`;
    const exists = await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!exists) return candidate;
  }
  return `${clean}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function ensurePlans(): Promise<void> {
  await runAsPlatform('billing-ensure-plans', async () => {
    for (const plan of Object.values(PLAN_ENTITLEMENTS)) {
      await prisma.plan.upsert({
        where: { code: plan.code },
        create: {
          id: `plan_${plan.code.toLowerCase()}`,
          code: plan.code,
          name: plan.name,
          monthlyPriceCents: plan.monthlyPriceCents,
          sortOrder: ['FREE', 'GROWTH', 'BUSINESS', 'ENTERPRISE'].indexOf(plan.code),
        },
        update: {
          name: plan.name,
          monthlyPriceCents: plan.monthlyPriceCents,
          sortOrder: ['FREE', 'GROWTH', 'BUSINESS', 'ENTERPRISE'].indexOf(plan.code),
          isActive: true,
        },
      });
    }
  });
}

export async function listPlans() {
  return runAsPlatform('billing-list-plans', async () =>
    prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
  );
}

async function applyPlanLimits(organizationId: string, planCode: PlanCode): Promise<void> {
  const plan = PLAN_ENTITLEMENTS[planCode];
  const activeContactsLimit = plan.monthlyActiveContactsLimit ?? 1_000_000_000;
  const outboundLimit = plan.monthlyOutboundMessagesLimit ?? 1_000_000_000;
  const campaignLimit = plan.monthlyCampaignSendsLimit ?? 1_000_000_000;
  await prisma.organization.update({
    where: { id: organizationId },
    data: { tier: planCode },
  });
  await prisma.organizationConfig.upsert({
    where: { organizationId },
    create: {
      organizationId,
      monthlyActiveContactsLimit: activeContactsLimit,
      monthlyOutboundMessagesLimit: outboundLimit,
      monthlyCampaignSendsLimit: campaignLimit,
    },
    update: {
      monthlyActiveContactsLimit: activeContactsLimit,
      monthlyOutboundMessagesLimit: outboundLimit,
      monthlyCampaignSendsLimit: campaignLimit,
    },
  });
}

export async function createSignup(input: {
  organizationName: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  planCode?: string;
  ipAddress: string;
}) {
  const planCode = normalizePlanCode(input.planCode || 'FREE');
  const email = input.adminEmail.trim().toLowerCase();
  const emailDomain = email.split('@')[1]?.toLowerCase();
  if (!input.organizationName.trim() || !input.adminName.trim() || !email || !input.adminPassword) {
    throw Object.assign(new Error('Organization and administrator details are required'), { status: 400 });
  }
  if (!/^\S+@\S+\.\S+$/.test(email) || !emailDomain) {
    throw Object.assign(new Error('A valid administrator email is required'), { status: 400 });
  }
  if (input.adminPassword.length < 8) {
    throw Object.assign(new Error('Administrator password must be at least 8 characters'), { status: 400 });
  }

  return runAsPlatform(`billing-signup:${emailDomain}`, async () => {
    const since = new Date(Date.now() - SIGNUP_WINDOW_MS);
    const [ipCount, domainCount, existingIdentity] = await Promise.all([
      prisma.signupThrottleEvent.count({ where: { ipAddress: input.ipAddress, createdAt: { gte: since } } }),
      prisma.signupThrottleEvent.count({ where: { emailDomain, createdAt: { gte: since } } }),
      prisma.identity.findUnique({ where: { email }, select: { id: true } }),
    ]);
    if (ipCount >= SIGNUP_IP_LIMIT) throw Object.assign(new Error('Too many signups from this network'), { status: 429 });
    if (domainCount >= SIGNUP_DOMAIN_LIMIT) throw Object.assign(new Error('Too many signups for this email domain'), { status: 429 });
    if (existingIdentity) throw Object.assign(new Error('Administrator email is already in use'), { status: 409 });

    const passwordHash = await bcrypt.hash(input.adminPassword, 10);
    const slug = await uniqueSlug(input.organizationName);
    const provider = getPaymentProvider();
    const verificationToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const created = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: input.organizationName.trim(),
          slug,
          status: 'PENDING',
          tier: 'FREE',
          paymentProvider: provider.provider,
        },
      });
      const identity = await tx.identity.create({ data: { email, passwordHash, platformRole: 'NONE' } });
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
          name: input.adminName.trim(),
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
          sessionName: `${slug}-primary`,
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
          monthlyActiveContactsLimit: PLAN_ENTITLEMENTS.FREE.monthlyActiveContactsLimit ?? 1_000_000_000,
          monthlyOutboundMessagesLimit: PLAN_ENTITLEMENTS.FREE.monthlyOutboundMessagesLimit ?? 1_000_000_000,
          monthlyCampaignSendsLimit: PLAN_ENTITLEMENTS.FREE.monthlyCampaignSendsLimit ?? 1_000_000_000,
        },
      });
      await tx.organizationBranding.create({ data: { organizationId: organization.id, productName: organization.name } });
      await tx.workingHours.create({ data: { organizationId: organization.id } });
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
      const subscription = await tx.subscription.create({
        data: {
          organizationId: organization.id,
          planCode,
          provider: provider.provider,
          status: planCode === 'FREE' ? 'ACTIVE' : 'MANUAL_REVIEW',
          activatedAt: planCode === 'FREE' ? new Date() : null,
        },
      });
      await tx.emailVerificationToken.create({
        data: {
          organizationId: organization.id,
          email,
          tokenHash: tokenHash(verificationToken),
          expiresAt,
        },
      });
      await tx.signupThrottleEvent.create({
        data: { organizationId: organization.id, ipAddress: input.ipAddress, emailDomain },
      });
      return { organization, admin, subscription };
    });

    const checkout = isPaidPlan(planCode)
      ? await provider.createCheckout(created.organization.id, planCode)
      : null;
    if (checkout) {
      await prisma.subscription.update({
        where: { id: created.subscription.id },
        data: { externalRef: checkout.externalRef },
      });
    }

    return {
      organizationId: created.organization.id,
      adminId: created.admin.id,
      verificationRequired: true,
      verificationUrl: `${appBaseUrl()}/verify-email?token=${encodeURIComponent(verificationToken)}`,
      checkoutUrl: checkout?.checkoutUrl ?? null,
      externalRef: checkout?.externalRef ?? null,
    };
  });
}

export async function verifyEmail(token: string) {
  const hashed = tokenHash(token);
  return runAsPlatform('billing-verify-email', async () => {
    const row = await prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashed },
      include: { organization: { include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
    });
    if (!row || row.consumedAt || row.expiresAt < new Date()) {
      throw Object.assign(new Error('Verification link is invalid or expired'), { status: 400 });
    }
    await prisma.emailVerificationToken.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
    await prisma.organization.update({
      where: { id: row.organizationId },
      data: { emailVerifiedAt: new Date(), status: row.organization.subscriptions[0]?.status === 'ACTIVE' ? 'ACTIVE' : row.organization.status },
    });
    await maybeProvisionGateway(row.organizationId, 'email-verified');
    return { organizationId: row.organizationId, verified: true };
  });
}

export async function maybeProvisionGateway(organizationId: string, reason: string, explicitAdminRequest = false): Promise<boolean> {
  return runAsPlatform(`billing-provision-gate:${organizationId}:${reason}`, async () => {
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscriptions: { where: { status: { in: ['ACTIVE', 'TRIALING'] } }, orderBy: { createdAt: 'desc' }, take: 1 },
        channels: { where: { kind: 'OPENWA' }, take: 1 },
      },
    });
    if (!organization || !organization.emailVerifiedAt) return false;
    const active = organization.subscriptions[0];
    const planCode = normalizePlanCode(active?.planCode || organization.tier || 'FREE');
    if (!isPaidPlan(planCode) && !explicitAdminRequest) return false;
    const channel = organization.channels[0];
    if (!channel || ['ACTIVE', 'AWAITING_QR', 'PROVISIONING'].includes(channel.provisioningState)) return false;
    await prisma.organization.update({ where: { id: organizationId }, data: { status: 'PROVISIONING' } });
    await queueGatewayAction(organizationId, 'provision');
    return true;
  });
}

export async function activateManualSubscription(organizationId: string, planInput: string) {
  const planCode = normalizePlanCode(planInput);
  return runAsPlatform(`billing-manual-activate:${organizationId}:${planCode}`, async () => {
    const provider = getPaymentProvider();
    const customerRef = `manual_customer_${organizationId}`;
    const subscriptionRef = `manual_subscription_${organizationId}`;
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    const existing = await prisma.subscription.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, planCode: true },
    });

    const currentMac = await runAsOrganization(organizationId, () => getMetricUsage('active_contacts'));
    const targetLimit = PLAN_ENTITLEMENTS[planCode].monthlyActiveContactsLimit;
    const overLimit = targetLimit !== null && currentMac > BigInt(targetLimit);
    const graceEnd = overLimit ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

    const subscription = existing
      ? await prisma.subscription.update({
          where: { id: existing.id },
          data: {
            planCode,
            provider: provider.provider,
            status: 'ACTIVE',
            customerRef,
            subscriptionRef,
            activatedAt: now,
            canceledAt: null,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        })
      : await prisma.subscription.create({
          data: {
            organizationId,
            planCode,
            provider: provider.provider,
            status: 'ACTIVE',
            customerRef,
            subscriptionRef,
            activatedAt: now,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
          },
        });
    await applyPlanLimits(organizationId, planCode);
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        status: 'ACTIVE',
        paymentProvider: provider.provider,
        paymentCustomerRef: customerRef,
        downgradeGraceEndsAt: graceEnd,
        downgradeGraceReason: overLimit ? `Current monthly active contacts (${currentMac}) exceed ${planCode} limit (${targetLimit}). Outbound is blocked until usage is reduced or plan is upgraded.` : null,
      },
    });
    if (isPaidPlan(planCode)) await maybeProvisionGateway(organizationId, 'manual-activation');
    return subscription;
  });
}

export async function requestGatewayForCurrentOrganization(organizationId: string): Promise<boolean> {
  return maybeProvisionGateway(organizationId, 'admin-request', true);
}

export async function markPaymentFailed(organizationId: string, reason = 'Payment failed'): Promise<void> {
  await runAsPlatform(`billing-payment-failed:${organizationId}`, async () => {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.updateMany({ where: { organizationId, status: 'ACTIVE' }, data: { status: 'PAST_DUE' } });
      await tx.organization.update({ where: { id: organizationId }, data: { status: 'SUSPENDED' } });
      await tx.platformAlert.create({ data: { organizationId, type: 'PAYMENT_FAILED', severity: 'ERROR', message: reason } });
    });
    await queueGatewayAction(organizationId, 'suspend');
  });
}

export async function cancelCurrentSubscription(organizationId: string): Promise<void> {
  await runAsPlatform(`billing-cancel:${organizationId}`, async () => {
    const subscription = await prisma.subscription.findFirst({
      where: { organizationId, status: { in: ['ACTIVE', 'TRIALING', 'MANUAL_REVIEW', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) return;
    if (subscription.subscriptionRef) await getPaymentProvider().cancelSubscription(subscription.subscriptionRef);
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED', canceledAt: new Date(), cancelAtPeriodEnd: false },
    });
    await prisma.organization.update({ where: { id: organizationId }, data: { tier: 'FREE' } });
    await applyPlanLimits(organizationId, 'FREE');
  });
}

export async function handlePaymentWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  const provider = getPaymentProvider();
  const event = await provider.verifyWebhook(rawBody, headers);
  if (!event.valid || !event.eventId || !event.type) {
    throw Object.assign(new Error('Invalid payment webhook signature'), { status: 400 });
  }
  return runAsPlatform(`billing-webhook:${provider.provider}:${event.type}`, async () => {
    const existingEvent = await prisma.paymentEvent.findUnique({
      where: { provider_eventId: { provider: provider.provider, eventId: event.eventId } },
      select: { id: true },
    });
    if (existingEvent) return { duplicate: true, processed: false };
    try {
      await prisma.paymentEvent.create({
        data: {
          provider: provider.provider,
          eventId: event.eventId,
          type: event.type,
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { duplicate: true, processed: false };
      }
      throw error;
    }

    // Dispatch on the normalized kind, never the provider's own event name —
    // otherwise every new provider needs a new branch here and silently
    // activates nothing until someone adds it.
    //
    // `processed` means "consumed — will not be re-processed", NOT "acted upon":
    // by this point the event is persisted and a redelivery gets {duplicate:true},
    // so reporting anything but success would invite providers to retry events
    // we have already recorded. Events we take no action on are still consumed.
    const payload = event.payload as any;
    const organizationId = String(event.organizationId || payload?.organizationId || '');

    if (!organizationId) {
      logger.warn('Payment event carried no organization', {
        provider: provider.provider, type: event.type, kind: event.kind,
      });
      return { duplicate: false, processed: true };
    }

    switch (event.kind) {
      case 'subscription_activated':
        await activateManualSubscription(organizationId, String(event.planCode || payload?.planCode || 'GROWTH'));
        break;
      case 'payment_failed':
        await markPaymentFailed(organizationId, String(event.reason || payload?.reason || 'Payment failed'));
        break;
      case 'subscription_canceled':
        await cancelCurrentSubscription(organizationId);
        break;
      default:
        logger.warn('Unhandled payment event type', {
          provider: provider.provider, type: event.type, kind: event.kind,
        });
    }
    return { duplicate: false, processed: true };
  });
}

export async function getCheckoutStatus(externalRef: string) {
  const provider = getPaymentProvider();
  const status = await provider.getCheckoutStatus(externalRef);
  await runAsPlatform(`billing-checkout-reconcile:${externalRef}`, async () => {
    const subscription = await prisma.subscription.findFirst({ where: { provider: provider.provider, externalRef } });
    if (!subscription) return;
    if (status.status === 'paid' && subscription.status !== 'ACTIVE') {
      await activateManualSubscription(subscription.organizationId, subscription.planCode);
    }
    if (status.status === 'failed') await markPaymentFailed(subscription.organizationId, 'Checkout reported failed');
  });
  return status;
}

export async function getCurrentBilling(organizationId: string) {
  return runAsPlatform(`billing-current:${organizationId}`, async () => {
    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: {
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 },
        invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
        channels: { where: { kind: 'OPENWA' }, take: 1 },
      },
    });
    return {
      organization: {
        id: organization.id,
        name: organization.name,
        status: organization.status,
        tier: organization.tier,
        emailVerifiedAt: organization.emailVerifiedAt,
        downgradeGraceEndsAt: organization.downgradeGraceEndsAt,
        downgradeGraceReason: organization.downgradeGraceReason,
      },
      subscription: organization.subscriptions[0] ?? null,
      invoices: organization.invoices,
      gateway: organization.channels[0] ?? null,
      plans: Object.values(PLAN_ENTITLEMENTS),
    };
  });
}

export async function reconcileBilling(): Promise<{ checked: number; repaired: number; alerted: number }> {
  const provider = getPaymentProvider();
  return runAsPlatform(`billing-reconcile:${provider.provider}`, async () => {
    const subscriptions = await prisma.subscription.findMany({
      where: { provider: provider.provider, externalRef: { not: null }, status: { in: ['PENDING', 'MANUAL_REVIEW', 'ACTIVE', 'PAST_DUE'] } },
      select: { id: true, organizationId: true, planCode: true, externalRef: true, status: true },
    });
    let repaired = 0;
    let alerted = 0;
    for (const subscription of subscriptions) {
      try {
        const status = await provider.getCheckoutStatus(subscription.externalRef!);
        if (status.status === 'paid' && subscription.status !== 'ACTIVE') {
          await activateManualSubscription(subscription.organizationId, subscription.planCode);
          repaired += 1;
        }
        if (status.status === 'failed' && subscription.status !== 'PAST_DUE') {
          await markPaymentFailed(subscription.organizationId, 'Reconciliation detected payment failure');
          repaired += 1;
        }
      } catch (error) {
        alerted += 1;
        await prisma.platformAlert.create({
          data: {
            organizationId: subscription.organizationId,
            type: 'BILLING_RECONCILIATION_FAILED',
            severity: 'ERROR',
            message: String(error),
            metadata: { provider: provider.provider, subscriptionId: subscription.id },
          },
        });
      }
    }
    return { checked: subscriptions.length, repaired, alerted };
  });
}
