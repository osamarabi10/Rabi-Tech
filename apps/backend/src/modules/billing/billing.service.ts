import { defaultWorkspaceData, workspaceMemberData } from '../../lib/workspace-provisioning';
import { currentWorkspaceId } from '../../lib/current-workspace';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OrganizationConfig, Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { queueGatewayAction } from '../../workers/gateway-provisioning.queue';
import logger from '../../lib/logger';
import { getCurrentUsage, getMetricUsage } from '../usage/usage.service';
// ACCESS_GRANTING_SUBSCRIPTION_STATUSES is deliberately no longer imported
// here. Its only use was the ternary in verifyEmail that let a subscription
// status decide whether an organization could be logged into. That coupling is
// gone; the constant remains in trial.service for the trial logic it names.
import {
  getTrialPlanCode,
  trialDeadlineFrom,
} from './trial.service';
import { getPaymentProvider, paymentProviderFor } from './provider-registry';
// ENTRY_PAID_PLAN_CODE is deliberately no longer imported here. It was used for
// exactly one thing in this file — guessing a plan when a payment event named
// none — and that guess is now a park in MANUAL_REVIEW. It remains in plans.ts
// as trial.service.ts's TRIAL_PLAN_DEFAULT, which is a real use, so the constant
// stays; it simply has no activation consumer any more.
import { isPaidPlan, normalizePlanCode, PLAN_ENTITLEMENTS, PlanCode, PlanEntitlements, UNLIMITED_SENTINEL } from './plans';
import { getEdition, getEditions, getEditionEditedAt } from './editions.service';
import { resolveEntitlements } from './entitlements.resolver';
import { editionOfferability } from '../channels/channel-viability';
import { channelGrantRefusal } from '../channels/channel-entitlement';
import { seedDefaultAutoReplies } from '../../utils/seed-auto-replies';
import { seedLifecycleStages } from '../lifecycle/lifecycle.service';

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

/**
 * Seeds the plan catalogue on boot. **Create-only, deliberately.**
 *
 * This used to rewrite name, price, sortOrder and isActive on every start.
 * That was harmless while the constant was the only source of truth — the row
 * was a projection of it, so re-projecting cost nothing. It stops being
 * harmless the moment an owner can edit a plan from the console: the same
 * update branch reverts their change at the next restart, so a price set on
 * Friday is back to the shipped default by Monday with nothing in any log to
 * say why. The owner would be left believing the console does not work.
 *
 * So the constant seeds a plan that does not exist yet and never touches one
 * that does. `PLAN_ENTITLEMENTS` is now the seed source and **nothing else** —
 * it is no longer a boot fallback, because editions.service.ts falls to a
 * restricted floor rather than to the constant. Once a row exists, the row is
 * the only truth there is.
 */
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
          pricingModel: plan.pricingModel,
          billingInterval: plan.billingInterval,
          // Declaration order in PLAN_ENTITLEMENTS, which is already cheapest
          // to dearest. The literal array this replaces was a second copy of
          // that ordering, and a code absent from it seeded at -1 — sorting
          // ahead of Free on the pricing page.
          sortOrder: Object.keys(PLAN_ENTITLEMENTS).indexOf(plan.code),
        },
        // Empty on purpose. An existing row is owner-editable state, not a
        // copy of the constant to be refreshed. See the note above.
        update: {},
      });
    }
  });
}

/**
 * The published catalogue: price and name from the database, limits from the
 * entitlement table that actually enforces them.
 *
 * Returning only the Plan rows left the public pricing page with no limits to
 * show, so it kept a hardcoded copy — which had already drifted from what the
 * server grants. A price list that disagrees with the system charging the
 * customer is the worst page in the product to maintain by hand.
 *
 * A null limit is passed through as null rather than the billion
 * applyPlanLimits() stores: "no limit" is a promise, and 1,000,000,000 is an
 * implementation detail that reads like a bizarre quota.
 */
export async function listPlans() {
  return runAsPlatform('billing-list-plans', async () => {
    // Archived editions leave the price list entirely, rather than merely being
    // unticked. This asks the same question getEditions() answers - what is on
    // sale - so it filters on the same two columns. Filtering on only one of
    // them is how the pricing page and the entitlement catalogue come to
    // disagree about which editions exist, which is the drift this function was
    // written to end.
    // sortOrder is not unique and defaults to 0, so two editions can share a
    // position. code breaks the tie so the price list cannot reorder itself
    // between requests for reasons no one can see.
    const plans = await prisma.plan.findMany({
      where: { isActive: true, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });

    return plans.map((plan) => {
      const entitlements = getEdition(normalizePlanCode(plan.code));
      const offer = editionOfferability(entitlements.allowedChannels);
      return {
        code: plan.code,
        name: plan.name,
        monthlyPriceCents: plan.monthlyPriceCents,
        currency: plan.currency,
        /*
          Published so the pricing page can stop inferring it from the price.

          It had been reading `monthlyPriceCents === 0` as "negotiated", which
          was true of ENTERPRISE by coincidence and would be wrong for any
          edition that is genuinely free. The catalogue has said which is which
          since pricingModel landed; the page simply could not see it.

          billingInterval travels with it, because a price without its interval
          is not a price - "$490" means different things monthly and yearly,
          and the page has to render the difference.
        */
        pricingModel: plan.pricingModel,
        billingInterval: plan.billingInterval,
        monthlyActiveContactsLimit: entitlements.monthlyActiveContactsLimit,
        monthlyOutboundMessagesLimit: entitlements.monthlyOutboundMessagesLimit,
        monthlyCampaignSendsLimit: entitlements.monthlyCampaignSendsLimit,
        usersLimit: entitlements.usersLimit,
        autoProvisionGateway: entitlements.autoProvisionGateway,
        customDomain: entitlements.customDomain,
        whiteLabel: entitlements.whiteLabel,
        /*
          Whether the platform can actually operate this edition today.

          Published rather than filtered: an edition the owner has put on sale
          and the platform cannot honour is still part of the offer, and hiding
          it would leave a would-be customer wondering where a tier they read
          about went. Shown and marked unavailable tells them something true.

          Derived from allowedChannels against platform configuration, so this
          answers a different question from isActive/archivedAt above. Those are
          the owner's intent; this is whether that intent is currently
          deliverable. Both must hold for a sale, and only the second heals
          itself when the configuration is fixed.
        */
        offerable: offer.offerable,
        unavailableReason: offer.reasonCode,
      };
    });
  });
}

async function applyPlanLimits(organizationId: string, planCode: PlanCode): Promise<void> {
  const plan = getEdition(planCode);
  const activeContactsLimit = plan.monthlyActiveContactsLimit ?? UNLIMITED_SENTINEL;
  const outboundLimit = plan.monthlyOutboundMessagesLimit ?? UNLIMITED_SENTINEL;
  const campaignLimit = plan.monthlyCampaignSendsLimit ?? UNLIMITED_SENTINEL;
  /*
    The AI columns are nullable on OrganizationConfig, unlike the three priced
    ones, so null is written straight through rather than via the sentinel.
    Writing the sentinel would mean the same thing to the resolver but would
    replace every existing null with 1,000,000,000 for no reason.

    Note what this does on activation: it **overwrites** whatever the config
    held. No organization has a negotiated AI allowance today - all six values
    are null - so nothing is lost now. The first per-deal AI number will need
    its own override column, the way macQuotaOverride exists for contacts;
    until then, activating a subscription resets AI to the edition's value.
  */
  const aiInLimit = plan.monthlyAiTokensInLimit;
  const aiOutLimit = plan.monthlyAiTokensOutLimit;
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
      monthlyAiTokensInLimit: aiInLimit,
      monthlyAiTokensOutLimit: aiOutLimit,
    },
    update: {
      monthlyActiveContactsLimit: activeContactsLimit,
      monthlyOutboundMessagesLimit: outboundLimit,
      monthlyCampaignSendsLimit: campaignLimit,
      monthlyAiTokensInLimit: aiInLimit,
      monthlyAiTokensOutLimit: aiOutLimit,
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

  /*
    Refuse an edition this platform cannot currently operate.

    The pricing page marks these unpurchasable; this is the guard, because a
    direct POST naming the code reaches here without ever loading that page.
    Before it existed, GROWTH/BUSINESS/ENTERPRISE - narrowed to WHATSAPP_CLOUD
    only - were sellable through a working checkout while META_APP_SECRET was
    unset, and the buyer landed in a workspace whose one permitted channel
    could neither send nor receive.

    409, matching PLAN_CODE_RESERVED's reasoning: the request is well formed
    and legal in shape, and what refuses it is the server's state, not
    anything the caller can retype. Deliberately not 503 - that promises the
    caller a retry will succeed shortly, and nobody has made that promise.

    Checked before the throttle counters so a refused signup does not spend
    the caller's per-IP budget on a request the platform was never going to
    accept.
  */
  const offer = editionOfferability(getEdition(planCode).allowedChannels);
  if (!offer.offerable) {
    logger.warn('Signup refused: edition not operable on this platform', {
      planCode,
      reason: offer.reason,
    });
    throw Object.assign(
      new Error('This edition requires a channel that is not available on this platform yet.'),
      { status: 409, code: 'PLAN_CHANNEL_UNAVAILABLE' },
    );
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

    /*
     * Whether this signup is a trial, and what it is a trial *of*.
     *
     * Choosing a paid plan up front still goes to checkout — someone ready to
     * buy should not be made to wait out a trial first. Everyone else gets the
     * trial, and it runs on a real plan rather than on Free, because Free
     * grants no WhatsApp connection and a trial without one demonstrates
     * nothing.
     *
     * Read inside the platform context — these load platform settings and the
     * tenancy extension fails closed on an unscoped query — but outside the
     * transaction, since a transaction held open across unrelated reads is a
     * lock held for no reason.
     */
    const isTrial = !isPaidPlan(planCode);
    const effectivePlanCode = isTrial ? await getTrialPlanCode() : planCode;
    const trialEndsAt = isTrial ? await trialDeadlineFrom(new Date()) : null;

    /*
      The plan actually provisioned, which for a trial is not the one asked for.

      Recorded, not refused. The guard at the top of this function turns away a
      caller who *named* an edition this platform cannot operate. A trial names
      nothing: effectivePlanCode comes from getTrialPlanCode(), and today that
      resolves to GROWTH - ENTRY_PAID_PLAN_CODE, with no billing.trialPlan row
      set - which the E5g narrowing made Meta-only. So every trial signup is
      placed on an edition whose one channel this platform cannot currently
      operate.

      Refusing here was written and backed out: it would close self-serve
      signup completely, which is a larger outage than the one being fixed, and
      substituting a different plan silently makes a commercial decision - the
      only offerable alternatives grant no gateway at all
      (autoProvisionGateway is false on FREE and STANDARD), so a substituted
      trial would demonstrate less than a broken one. Neither belongs in a
      correctness fix. See D-26; the resolution is the platform owner's.

      No money changes hands on this path, which is what separates it from the
      defect above: a paid signup for an inoperable edition is refused, a free
      trial on one is logged and allowed to proceed.
    */
    const effectiveOffer = editionOfferability(getEdition(effectivePlanCode).allowedChannels);
    if (!effectiveOffer.offerable) {
      logger.warn('Trial placed on an edition this platform cannot operate (D-26)', {
        requested: planCode,
        effective: effectivePlanCode,
        reason: effectiveOffer.reason,
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: input.organizationName.trim(),
          slug,
          // ACTIVE at creation. Activation used to require a staff member to
          // press a button, and PENDING was how that queue was represented --
          // an organization nobody could log into until somebody acted. Signup
          // is self-serve now, so the status a new organization is born with is
          // the status it keeps.
          status: 'ACTIVE',
          // The plan actually in force, which for a trial is the plan the
          // trial is *of*. Hardcoding FREE here while the subscription said
          // otherwise would leave tier and subscription disagreeing, and
          // detectQuotaDrift — which exists because those two drifted once
          // already — would then fire on every trial in the system. A detector
          // that always fires is a detector nobody reads.
          tier: effectivePlanCode,
          paymentProvider: provider.provider,
        },
      });
      const identity = await tx.identity.create({ data: { email, passwordHash, platformRole: 'NONE' } });
      /*
        The organization's default workspace, created here because the migration
        that gave one to every existing organization cannot reach forward to
        organizations created later. An organization without a default workspace
        cannot resolve a scope, so its very first inbound message would throw.

        The id comes from the shared helper rather than being spelled out, so
        this and migration 20261013090000_workspaces_schema cannot drift into two
        conventions — down.sql's guard 1 recognises its own rows by exactly this
        shape.
      */
      const workspace = await tx.workspace.create({
        data: defaultWorkspaceData(organization.id, organization.name),
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
      // Same principle for the contact pipeline: a default list they can
      // rename, reorder or delete, not a vocabulary the product imposes.
      await seedLifecycleStages(tx, organization.id);
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
      // Membership mirrors the organization role, the same copy the backfill
      // made. A default here would re-permission the first admin of every new
      // organization and leave down.sql guard 2 with nothing to measure.
      await tx.workspaceMember.create({
        data: workspaceMemberData(organization.id, admin.id, admin.role),
      });

      const whatsappSession = await tx.whatsappSession.create({
        data: {
          // The explicit id, not currentOrganizationId(): that resolver reads
          // through the ambient client, which cannot see a row created inside
          // this still-open transaction.
          workspaceId: workspace.id,
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
          // Seeded from the same plan as the tier, for the same reason.
          monthlyActiveContactsLimit: getEdition(effectivePlanCode).monthlyActiveContactsLimit ?? UNLIMITED_SENTINEL,
          monthlyOutboundMessagesLimit: getEdition(effectivePlanCode).monthlyOutboundMessagesLimit ?? UNLIMITED_SENTINEL,
          monthlyCampaignSendsLimit: getEdition(effectivePlanCode).monthlyCampaignSendsLimit ?? UNLIMITED_SENTINEL,
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
          planCode: effectivePlanCode,
          provider: provider.provider,
          // The deadline is stamped once, here, so a later change to the trial
          // length cannot retroactively expire somebody already inside one.
          status: isTrial ? 'TRIALING' : 'MANUAL_REVIEW',
          trialEndsAt,
          // Nothing has been paid, so nothing is activated. `activatedAt` is
          // the moment money changed hands, and a trial is not that moment.
          activatedAt: null,
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
      data: {
        emailVerifiedAt: new Date(),
        /*
          Verification records that the address is real. It does not decide
          access, and this line used to.

          It read the *subscription* status and left the organization PENDING
          unless the subscription was ACTIVE or TRIALING -- so MANUAL_REVIEW,
          which is a billing state, silently became the gate on logging in. The
          component named for that decision, access-gate.middleware.ts, checked
          neither value. A decision made inside an email-verification side
          effect is a decision nobody can audit.

          Organizations are ACTIVE from creation now, so there is nothing here
          to flip. Any future restriction on an unverified payment belongs in
          access-gate.middleware.ts as an allow-listed check with a reason code
          -- see docs/DECISIONS.md.
        */
      },
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

    /*
      Do not build a gateway the edition forbids.

      GROWTH, BUSINESS and ENTERPRISE carry autoProvisionGateway: true with
      allowedChannels: ['WHATSAPP_CLOUD'], so before this check every workspace
      on them had an OpenWA gateway built automatically - a real resource,
      reaching AWAITING_QR, pairable, and sendable through, because nothing
      downstream asked about the edition. See D-27.

      Checked here rather than only at the QR endpoint because provisioning
      happens unattended: the gateway is built at activation whether or not a
      human ever opens the pairing screen, and a resource nobody may use should
      not be built in the first place.

      channelGrantRefusal grandfathers a channel that is already ACTIVE, so this
      cannot disconnect a live workspace - it only stops new ones. Existing
      subscribers on a Meta-only edition with a working OpenWA channel keep it.
    */
    const forbidden = await channelGrantRefusal(organizationId, 'OPENWA');
    if (forbidden) {
      logger.warn('Gateway provisioning refused: the edition does not permit this channel', {
        organizationId,
        planCode,
        kind: 'OPENWA',
        reason,
      });
      return false;
    }

    if (!channel || ['ACTIVE', 'AWAITING_QR', 'PROVISIONING'].includes(channel.provisioningState)) return false;
    await prisma.organization.update({ where: { id: organizationId }, data: { status: 'PROVISIONING' } });
    await queueGatewayAction(organizationId, 'provision');
    return true;
  });
}

/**
 * What a provider knows a subscription by. All optional; see
 * VerifiedPaymentEvent for why.
 */
export type ProviderIdentifiers = {
  subscriptionRef?: string | null;
  customerRef?: string | null;
  /** For the alert, when an activation arrives without references. */
  source?: string;
};

export async function activateManualSubscription(
  organizationId: string,
  planInput: string,
  identifiers: ProviderIdentifiers = {},
) {
  const planCode = normalizePlanCode(planInput);
  return runAsPlatform(`billing-manual-activate:${organizationId}:${planCode}`, async () => {
    const now = new Date();
    /*
      The period follows the edition's billing interval rather than a hardcoded
      month. Nothing reads currentPeriodEnd to decide access today (D-22), so
      this is a record being made correct rather than an enforcement change -
      but a yearly subscription whose period said one month would be wrong in
      the console the moment yearly editions exist.
    */
    const periodEnd = new Date(now);
    if (getEdition(planCode).billingInterval === 'YEARLY') {
      periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    } else {
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    }
    const existing = await prisma.subscription.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, planCode: true, provider: true, subscriptionRef: true, customerRef: true },
    });

    /*
      The row keeps the provider that created it; only a brand new subscription
      takes the configured one.

      This used to read getPaymentProvider() and write that name onto the row
      unconditionally, which meant an owner activating an existing subscriber
      from the console under PAYMENT_PROVIDER=stripe relabelled a `manual` row
      as `stripe` while still writing synthetic `manual_*` references. A row
      that lies about its own provenance is worse than one with synthetic
      references: cancellation dispatches on that name, so the lie is what
      routes a manual subscription to Stripe.
    */
    const providerName = existing?.provider || getPaymentProvider().provider;

    /*
      Real references win, then whatever the row already holds, then synthetic.

      The synthetic form is not dead weight — ManualProvider looks its own rows
      up by it — so it stays as the last resort rather than being removed. What
      changes is that a provider which supplies real identifiers no longer has
      them thrown away.
    */
    const syntheticSubscriptionRef = `manual_subscription_${organizationId}`;
    const syntheticCustomerRef = `manual_customer_${organizationId}`;
    const subscriptionRef = identifiers.subscriptionRef || existing?.subscriptionRef || syntheticSubscriptionRef;
    const customerRef = identifiers.customerRef || existing?.customerRef || syntheticCustomerRef;
    const usingSyntheticRefs = subscriptionRef === syntheticSubscriptionRef;

    const currentMac = await runAsOrganization(organizationId, () => getMetricUsage('active_contacts'));
    const targetLimit = getEdition(planCode).monthlyActiveContactsLimit;
    const overLimit = targetLimit !== null && currentMac > BigInt(targetLimit);
    const graceEnd = overLimit ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;

    const subscription = existing
      ? await prisma.subscription.update({
          where: { id: existing.id },
          data: {
            planCode,
            provider: providerName,
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
            provider: providerName,
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
        // No status write. Organizations are ACTIVE from creation, so there is
        // nothing for a payment to activate. A suspension is dunning's to place
        // and dunning's to lift -- see the un-suspend branch in dunning.service,
        // which restores only what dunning itself suspended.
        paymentProvider: providerName,
        paymentCustomerRef: customerRef,
        downgradeGraceEndsAt: graceEnd,
        downgradeGraceReason: overLimit ? `Current monthly active contacts (${currentMac}) exceed ${planCode} limit (${targetLimit}). Outbound is blocked until usage is reduced or plan is upgraded.` : null,
      },
    });
    /*
      The edition's flag, not the code's name.

      This read `isPaidPlan(planCode)` while the console showed and the billing
      summary reported `autoProvisionGateway` — a flag and a hidden name-check
      answering the same question, free to disagree. They already did, on
      STANDARD: the flag says no, `isPaidPlan` says yes, so a STANDARD
      subscriber would have had a gateway provisioned while the console hid the
      control that supposedly governs it.

      No organization is on STANDARD, so nothing changes today. What changes is
      that the flag now decides, which is what the console has been claiming.
    */
    if (getEdition(planCode).autoProvisionGateway) {
      await maybeProvisionGateway(organizationId, 'manual-activation');
    }

    /*
      Activated, but with a reference the provider has never heard of.

      Only for real providers: `manual` invents these strings by design and
      looks its own rows up by them, so alerting there would fire on every
      activation and teach everyone to ignore the alert.

      A separate type from PAYMENT_EVENT_NEEDS_REVIEW, deliberately. That one
      means "nothing happened and a person must act". This means "everything
      happened, and one thing is missing" — a WARNING rather than an ERROR.
      Filing them under one name would put "the customer is not activated" and
      "the customer is fine" in the same queue, and the queue would stop being
      read.

      It is an alert rather than a log line because of when the consequence
      lands: a missing subscription reference costs nothing until somebody
      cancels, which may be months later, and at that point the failure appears
      in the cancellation path with nothing pointing back to the activation that
      caused it. This is the only moment the connection is visible.
    */
    if (usingSyntheticRefs && providerName !== 'manual') {
      const message = `Subscription activated for ${organizationId} on provider ${providerName} `
        + 'with a synthetic reference: the provider supplied none. Cancellation through the provider '
        + 'will not work for this subscription until a real reference is recorded.';
      logger.warn('Activation carried no provider references', {
        organizationId, provider: providerName, source: identifiers.source ?? 'unknown',
      });
      await prisma.platformAlert.create({
        data: {
          organizationId,
          type: 'PAYMENT_REFS_MISSING',
          severity: 'WARNING',
          message,
          metadata: { provider: providerName, source: identifiers.source ?? 'unknown', planCode } as never,
        },
      });
    }

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

/**
 * Cancel the current subscription.
 *
 * `originatedFromProvider` suppresses the call back to the provider. A
 * `subscription_canceled` webhook is the provider telling us it has already
 * cancelled; asking it to cancel again is at best a redundant API call against
 * a subscription that no longer exists, and at worst a loop — if that call
 * emits its own cancellation event it arrives with a *different* eventId, so
 * PaymentEvent's idempotency will not stop it.
 *
 * Everything else — a tenant cancelling from the panel, an owner cancelling
 * from the console — originates here and must reach the provider, or the local
 * row reads CANCELED while billing continues.
 */
export async function cancelCurrentSubscription(
  organizationId: string,
  options: { originatedFromProvider?: boolean } = {},
): Promise<void> {
  await runAsPlatform(`billing-cancel:${organizationId}`, async () => {
    const subscription = await prisma.subscription.findFirst({
      where: { organizationId, status: { in: ['ACTIVE', 'TRIALING', 'MANUAL_REVIEW', 'PENDING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!subscription) return;
    /*
      Cancelled through the provider that created the row, not the one
      configured now.

      These are not the same the moment PAYMENT_PROVIDER changes, and the
      database currently holds subscriptions created under `manual` whose
      subscriptionRef is a synthetic `manual_subscription_*` string. Handing
      that to Stripe means nothing to Stripe: the call errors, and if it were
      ever made not to error the local row would read CANCELED while the real
      subscription kept billing.

      A subscription is a relationship with one provider and it outlives the
      environment variable. An unregistered name throws — see the registry.
    */
    if (subscription.subscriptionRef && !options.originatedFromProvider) {
      await paymentProviderFor(subscription.provider).cancelSubscription(subscription.subscriptionRef);
    }
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'CANCELED', canceledAt: new Date(), cancelAtPeriodEnd: false },
    });
    await prisma.organization.update({ where: { id: organizationId }, data: { tier: 'FREE' } });
    await applyPlanLimits(organizationId, 'FREE');
  });
}

/**
 * Activate from a payment event, but only onto a plan the subscription of
 * record can vouch for.
 *
 * The event's plan used to be passed straight through. `normalizePlanCode`
 * checks only that a code exists in the catalogue, so any code in the catalogue
 * was accepted: an event naming ENTERPRISE activated ENTERPRISE, whatever the
 * customer signed up for or paid. The subscription already records the plan its
 * checkout was created for — `createSignup` writes `planCode` and `externalRef`
 * in the same row — so there is something to check against, and not checking was
 * the whole defect.
 *
 * Anything that cannot be verified is **parked in MANUAL_REVIEW** rather than
 * guessed at. That state already exists for exactly this purpose: a paid signup
 * sits in it until a person confirms. Parking is visible and reversible; the
 * previous behaviour — falling back to the entry paid plan with a warning — put
 * a subscriber on a plan nobody chose and left a log line as the only evidence.
 *
 * A parked event is still *consumed*: it is recorded in PaymentEvent, so a
 * provider retrying it gets `duplicate` rather than a second attempt. The alert
 * is what asks for a human, and it is an alert rather than a log because the
 * money has already moved and silence here costs a customer their service.
 */
async function activateFromPaymentEvent(
  organizationId: string,
  namedPlan: string | null,
  context: { provider: string; type: string },
  identifiers: ProviderIdentifiers = {},
): Promise<'activated' | 'parked'> {
  const subscription = await prisma.subscription.findFirst({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, planCode: true, status: true },
  });

  const park = async (reason: string): Promise<'parked'> => {
    logger.error('Payment event parked for review', { organizationId, ...context, reason });
    // Never demote a subscription that is already live. An odd event about an
    // active customer is a question for an owner, not grounds for taking a
    // working service away from someone who is paying for it.
    if (subscription && subscription.status !== 'ACTIVE') {
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'MANUAL_REVIEW' },
      });
    }
    await prisma.platformAlert.create({
      data: {
        organizationId,
        type: 'PAYMENT_EVENT_NEEDS_REVIEW',
        severity: 'ERROR',
        message: reason,
        metadata: { ...context, namedPlan, subscriptionPlan: subscription?.planCode ?? null } as never,
      },
    });
    return 'parked';
  };

  if (!subscription) {
    return park('Payment event names an organization with no subscription to activate.');
  }
  if (!namedPlan) {
    return park('Payment event activated a subscription without naming a plan.');
  }

  let requested: PlanCode;
  try {
    requested = normalizePlanCode(namedPlan);
  } catch {
    return park(`Payment event named a plan the catalogue does not carry: ${namedPlan}`);
  }

  // Compared against the stored string rather than through normalizePlanCode,
  // which throws on a code the catalogue no longer carries — an edition that has
  // since been renamed or removed must park, not crash the webhook.
  const ofRecord = String(subscription.planCode || '').trim().toUpperCase();
  if (requested !== ofRecord) {
    return park(
      `Payment event names ${requested} but the subscription of record is ${ofRecord || 'unset'}.`,
    );
  }

  await activateManualSubscription(organizationId, requested, identifiers);
  return 'activated';
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
      case 'subscription_activated': {
        const namedPlan = event.planCode || payload?.planCode;
        await activateFromPaymentEvent(organizationId, namedPlan ? String(namedPlan) : null, {
          provider: provider.provider,
          type: event.type,
        }, {
          subscriptionRef: event.subscriptionRef,
          customerRef: event.customerRef,
          source: `webhook:${event.type}`,
        });
        break;
      }
      case 'payment_failed':
        await markPaymentFailed(organizationId, String(event.reason || payload?.reason || 'Payment failed'));
        break;
      case 'subscription_canceled':
        // The provider has already cancelled; calling back would ask it to
        // cancel a subscription that no longer exists. See the echo guard on
        // cancelCurrentSubscription.
        await cancelCurrentSubscription(organizationId, { originatedFromProvider: true });
        break;
      default:
        logger.warn('Unhandled payment event type', {
          provider: provider.provider, type: event.type, kind: event.kind,
        });
    }
    return { duplicate: false, processed: true };
  });
}

/**
 * What the provider says about a checkout. **Reports; never changes anything.**
 *
 * This is served by `GET /api/billing/checkout-status/:externalRef`, which is in
 * the authentication bypass in index.ts and has to be: its only caller is the
 * return-from-checkout landing page, reached by someone who has just come back
 * from the payment provider and has not logged in yet. They hold no token, so
 * requiring one would break the only legitimate use.
 *
 * This reason used to be "their organization is still PENDING, so they cannot
 * hold a session". That stopped being true when manual activation was removed
 * and organizations became ACTIVE at signup. The exemption is unchanged and
 * still correct; only its justification was stale, which on an auth bypass is
 * the kind of drift that gets a real exemption removed by someone who reads the
 * comment and finds it false.
 *
 * It used to activate. A `paid` status called activateManualSubscription and a
 * `failed` status called markPaymentFailed, which suspends the organization.
 * That made an unauthenticated endpoint, keyed on a value that travels in a URL,
 * able both to grant a subscription and to suspend an organization. It was inert
 * only by accident: the manual provider derives checkout status *from* the
 * subscription's own status, so it could never report anything the database did
 * not already say. Integrating any real provider removes that accident.
 *
 * **Activation now has exactly one externally reachable entrance: the signed
 * webhook.** The missed-webhook fallback is not lost — reconcileBilling still
 * polls the same provider method and still acts on it — but it runs on a
 * schedule, in-process, triggered by no request. Nothing outside can reach it.
 */
export async function getCheckoutStatus(externalRef: string) {
  /*
    Resolved from the row that owns this reference, not from configuration.

    Same defect as the cancellation path had: a checkout created under `manual`
    carries a `manual_...` externalRef, and asking Stripe about it once Stripe
    is the configured provider is a 404 from Stripe and a 500 from an endpoint
    that is deliberately unauthenticated.

    An unknown reference returns `pending` without contacting any provider. That
    is what ManualProvider already answered for a reference it did not
    recognise, so the observable behaviour is unchanged — and it removes an
    unauthenticated path that reached a third-party API with a caller-supplied
    string, which was a request-forgery shaped surface even though the reference
    is unguessable.

    Nothing about the provider is returned. The response is the same
    CheckoutStatusResult as before, so which provider a workspace is on stays
    unobservable from here.
  */
  const subscription = await runAsPlatform(`billing-checkout-status:${externalRef}`, () =>
    prisma.subscription.findFirst({ where: { externalRef }, select: { provider: true } }));
  if (!subscription) return { status: 'pending' as const };
  return paymentProviderFor(subscription.provider).getCheckoutStatus(externalRef);
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
      plans: getEditions(),
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
          // getCheckoutStatus returns the provider's real identifiers alongside
          // the status, and this is the path that records them when a webhook
          // was missed — so it passes them on rather than letting the
          // activation fall back to a synthetic reference.
          await activateManualSubscription(subscription.organizationId, subscription.planCode, {
            subscriptionRef: status.subscriptionRef,
            customerRef: status.customerRef,
            source: 'reconcile',
          });
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

/**
 * Everything the tenant subscription panel needs, in one call.
 *
 * Deliberately one endpoint rather than three: the panel shows plan, usage and
 * invoices as a single unit, and three round-trips would let them render out of
 * sync with each other (a meter from before an upgrade beside the new plan name).
 *
 * `entitlements` is what the UI gates features on. It is the plan's published
 * allowance — the server still enforces independently via assertMetricAvailable
 * and assertSeatAvailable, because a UI gate is a courtesy, not a control.
 */

/** Treats the "unlimited" sentinel applyPlanLimits writes as what it means. */
function normalize(raw: number | bigint | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return value >= UNLIMITED_SENTINEL ? null : value;
}

/**
 * Compares the plan's published allowance against the quota actually enforced.
 *
 * These are two stores that can drift: `Organization.tier` names the plan, but
 * `OrganizationConfig` holds the numbers `assertMetricAvailable` enforces.
 * applyPlanLimits() writes both together, so they only diverge if a tier is
 * changed out-of-band — and then the tenant silently keeps quotas they are no
 * longer paying for. Surfacing it makes that visible instead of invisible.
 */
function detectQuotaDrift(
  planOfRecord: PlanEntitlements,
  config: OrganizationConfig | null,
  effective: Record<string, number | null>,
  isOverridden: boolean,
  editionEditedAt: Date | null,
) {
  // An edition edit is a NEW BASELINE, not drift.
  //
  // applyPlanLimits() copies an edition's numbers into OrganizationConfig when
  // a tier is set. Once the owner can edit the edition itself, those numbers
  // legitimately diverge the moment a price or a limit changes - and without
  // this, raising GROWTH's allowance would report every organization on GROWTH
  // as drifted. That is the failure this detector was built to avoid: one that
  // always fires is one nobody reads.
  //
  // Re-applying limits on edit was rejected as the fix, because it would stomp
  // per-subscriber overrides. Instead the config is read as pre-baseline when it
  // predates the edition's last edit, and its divergence is explained.
  //
  // A null editionEditedAt means the catalogue has not loaded, not that the
  // edition has never been edited. Suppressing on unknown would hide real drift
  // during the boot window, so unknown suppresses nothing.
  const configUpdatedAt = config?.updatedAt ?? null;
  const predatesEdition = Boolean(
    editionEditedAt && configUpdatedAt && configUpdatedAt < editionEditedAt,
  );
  // Compared against the plan of RECORD, not the effective plan. When an
  // override is live the two differ by design, and comparing config against the
  // override would report every overridden organization as drifted — which is
  // how a real signal becomes noise nobody reads.
  const expected: Record<string, number | null> = {
    active_contacts: planOfRecord.monthlyActiveContactsLimit,
    messages_outbound: planOfRecord.monthlyOutboundMessagesLimit,
    campaign_sends: planOfRecord.monthlyCampaignSendsLimit,
  };
  const configured: Record<string, number | null> = {
    active_contacts: normalize(config?.monthlyActiveContactsLimit),
    messages_outbound: normalize(config?.monthlyOutboundMessagesLimit),
    campaign_sends: normalize(config?.monthlyCampaignSendsLimit),
  };

  const drift: Array<{
    metric: string;
    planAllows: number | null;
    enforced: number | null;
    configured: number | null;
    kind: 'drift' | 'override-written-through';
  }> = [];

  for (const metric of Object.keys(expected)) {
    const planAllows = expected[metric];
    const stored = configured[metric];
    const enforced = effective[metric] ?? null;

    // Config still matches the plan it was derived from: nothing has diverged.
    // An override sitting on top of it is intentional, not drift.
    if (stored === planAllows) continue;

    // Config diverges from the plan of record. Two different faults look alike
    // here, and only one is the classic P8-b drift:
    //
    //  - No override live, or an override that config does not equal: something
    //    changed a tier out of band and the tenant silently kept — or lost —
    //    quota. That is drift.
    //  - An override IS live and config now equals the enforced number: an
    //    override was written through into config. That is the one thing
    //    entitlements.resolver.ts exists to prevent, so it is named separately
    //    rather than buried among ordinary drift.
    const writtenThrough = isOverridden && stored === enforced;

    // Suppress ordinary drift the edition edit already explains. Write-through
    // is never suppressed: it is a different fault - the one the resolver exists
    // to prevent - and an edition edit says nothing about whether it happened.
    if (!writtenThrough && predatesEdition) continue;

    drift.push({
      metric,
      planAllows,
      enforced,
      configured: stored,
      kind: writtenThrough ? 'override-written-through' : 'drift',
    });
  }
  return drift;
}

export async function getBillingSummary(organizationId: string) {
  // Usage is tenant-scoped; billing detail needs platform scope. Read usage
  // first so we are not inside runAsPlatform when getTenantId() is called.
  const [usage, seatsUsed] = await Promise.all([
    getCurrentUsage(),
    prisma.user.count({ where: { isActive: true } }),
  ]);

  const detail = await getCurrentBilling(organizationId);
  // The effective entitlement, after any platform-owner override. The tenant is
  // shown what is actually enforced, not what their nominal tier would grant.
  const effective = await resolveEntitlements(organizationId);
  const plan = getEdition(effective.plan);
  const config = await runAsPlatform('billing-summary:config', () =>
    prisma.organizationConfig.findUnique({ where: { organizationId } }));

  const seatLimit = effective.seatLimit;

  /**
   * The currency of the plan in force.
   *
   * Read from the Plan rows rather than the entitlements, because entitlements
   * describe allowances and carry no price. Matched through normalizePlanCode
   * for the same reason listPlans() does: the stored code and the normalized
   * one are not guaranteed to be written identically, and matching on the raw
   * string would silently find nothing.
   *
   * Deliberately not filtered by archivedAt, for the same reason
   * sellableCurrencies() is not: this reports the currency of the plan already
   * in force, so it is a resolution question. A subscriber whose edition was
   * archived must still be shown what they are billed in, not null.
   */
  const planRows = await runAsPlatform('billing-summary:plan-currency', () =>
    prisma.plan.findMany({ where: { isActive: true }, select: { code: true, currency: true } }));
  const planCurrency =
    planRows.find((row) => normalizePlanCode(row.code) === effective.plan)?.currency ?? null;

  return {
    plan: {
      code: plan.code,
      name: plan.name,
      monthlyPriceCents: effective.listPriceCents,
    },
    entitlements: plan,
    /*
      The cheapest published edition that grants each gated feature, by name.

      This replaces a hardcoded map in the frontend that read
      `{ broadcasts: 'Growth', customDomain: 'Business', ... }`. Those strings
      were written when the ladder was fixed in a constant, and nothing kept
      them true afterwards: an owner moving broadcasts to Business from the
      console would leave the upsell still saying Growth, and the server's own
      402 refusals - which have derived this from the catalogue since E5a -
      would disagree with the button that led the user there.

      Derived here so there is one answer. Sent with the summary rather than
      waiting for a 402, because the UI needs it *before* the attempt: it
      renders a locked control that says what to buy, and a reactive payload
      cannot label a button nobody has pressed yet.

      An offer read - getEditions() is already filtered to what is on sale and
      ordered by ladder position, so "cheapest that grants it" is the first
      match. Null means no published edition grants it at all, which the
      caller must render as "no upgrade unlocks this" rather than as a name.
    */
    featureUpgrades: (() => {
      const published = getEditions();
      const cheapest = (grants: (edition: PlanEntitlements) => boolean) =>
        published.find(grants)?.name ?? null;
      return {
        broadcasts: cheapest((e) => e.monthlyCampaignSendsLimit === null || e.monthlyCampaignSendsLimit > 0),
        autoGateway: cheapest((e) => e.autoProvisionGateway),
        customDomain: cheapest((e) => e.customDomain),
        whiteLabel: cheapest((e) => e.whiteLabel),
      };
    })(),
    subscription: detail.subscription,
    organization: detail.organization,
    seats: {
      used: seatsUsed,
      limit: seatLimit,
      remaining: seatLimit === null ? null : Math.max(0, seatLimit - seatsUsed),
      atLimit: seatLimit !== null && seatsUsed >= seatLimit,
    },
    usage,
    invoices: detail.invoices,
    plans: detail.plans,
    /**
     * Commercial terms, for the "عرض خاص" badge and the credit line.
     *
     * overrideReason is deliberately NOT included: it is the owner's internal
     * note ("matched competitor quote", "compensation for the October outage")
     * and will eventually say something that must never reach the customer.
     */
    commercial: {
      isOverridden: effective.isOverridden,
      source: effective.source,
      expiresAt: effective.override.expiresAt?.toISOString() ?? null,
      discountPercent: effective.isOverridden ? effective.override.discountPercent : null,
      listPriceCents: effective.listPriceCents,
      effectivePriceCents: effective.effectivePriceCents,
      creditCents: effective.override.creditCents,
      /**
       * The currency these amounts are in.
       *
       * Sent because the client had no way to know it and was formatting all
       * three as ILS by default — a price rendered in the wrong currency is
       * wrong by the exchange rate and looks entirely correct. The server
       * knows the answer; it just was not saying it.
       */
      currency: planCurrency,
    },
    /** Non-empty means enforced quotas no longer match the named plan. */
    quotaDrift: detectQuotaDrift(
      getEdition(effective.planOfRecord),
      config,
      effective.limits,
      effective.isOverridden,
      getEditionEditedAt(effective.planOfRecord),
    ),
  };
}
