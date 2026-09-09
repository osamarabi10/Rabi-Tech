import { Prisma, SubscriptionStatus, UsageMetric } from '@prisma/client';
import { prisma } from '../../prisma';
import { displayE164, normalizePhone } from '../contacts/phone';
import {
  PLAN_VERSION_EDITION_INCLUDE,
  SUBSCRIPTION_EDITION_SELECT,
  subscriptionEditionOf,
  versionedEditionOf,
} from '../billing/editions.service';
import {
  resolveEntitlements,
  type EffectiveEntitlements,
} from '../billing/entitlements.resolver';
import {
  limitOf,
  limitState,
  type Capability,
  type LimitState,
} from '../billing/capabilities';
import { monthRange } from '../usage/usage.service';
import { USAGE_METRICS } from '../usage/metrics';

const SEARCH_LIMIT = 20;
const NUMBERS_PER_RESULT = 20;
const FAILURE_LIMIT = 10;
const FAILURE_WINDOW_DAYS = 30;
const STALE_INBOUND_DAYS = 14;

/** Current commercial markets whose local forms support may need to search. */
const SERVED_PHONE_COUNTRY_CODES = ['962', '970', '972'] as const;
const LIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'TRIALING'];

const SEARCH_ORGANIZATION_SELECT = {
  id: true,
  name: true,
  slug: true,
  status: true,
  whatsappSessions: {
    where: { phoneNumber: { not: null } },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: NUMBERS_PER_RESULT,
    select: {
      id: true,
      label: true,
      phoneNumber: true,
      isActive: true,
      channel: {
        select: {
          id: true,
          kind: true,
          status: true,
          provisioningState: true,
        },
      },
    },
  },
} satisfies Prisma.OrganizationSelect;

type SearchOrganization = Prisma.OrganizationGetPayload<{
  select: typeof SEARCH_ORGANIZATION_SELECT;
}>;

export type SubscriberSearchResult = {
  id: string;
  name: string;
  slug: string;
  status: string;
  numbers: Array<{
    id: string;
    label: string;
    phoneNumber: string;
    isActive: boolean;
    channelKind: string | null;
    channelState: string | null;
  }>;
};

export class SubscriberSearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriberSearchInputError';
  }
}

function normalizedLength(value: string): number {
  return Array.from(value).length;
}

function fullInternationalNumber(raw: string | null): string | null {
  if (!raw) return null;
  const normalized = normalizePhone(raw);
  return normalized.ok ? displayE164(normalized.phone) : null;
}

function presentSearchResult(organization: SearchOrganization): SubscriberSearchResult {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
    numbers: organization.whatsappSessions.flatMap((session) => {
      const phoneNumber = fullInternationalNumber(session.phoneNumber);
      return phoneNumber
        ? [{
            id: session.id,
            label: session.label,
            phoneNumber,
            isActive: session.isActive,
            channelKind: session.channel?.kind ?? null,
            channelState: session.channel?.provisioningState ?? session.channel?.status ?? null,
          }]
        : [];
    }),
  };
}

function phoneCandidates(input: string): string[] {
  const compact = input.replace(/[\s()\-.\u200e\u200f]/g, '');
  const digits = compact.replace(/\D/g, '');
  const isExplicitInternational = compact.startsWith('+')
    || compact.startsWith('00')
    || SERVED_PHONE_COUNTRY_CODES.some((code) => digits.startsWith(code));
  const countryCodes = isExplicitInternational ? [undefined] : [...SERVED_PHONE_COUNTRY_CODES];
  const candidates = countryCodes.flatMap((countryCode) => {
    const normalized = normalizePhone(input, countryCode);
    return normalized.ok ? [normalized.phone] : [];
  });
  return [...new Set(candidates)];
}

function normalizeSearchQuery(raw: unknown): string {
  const query = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const length = normalizedLength(query);
  if (length < 2 || length > 80) {
    throw new SubscriberSearchInputError('Search must be between 2 and 80 characters');
  }
  return query;
}

/** Bounded platform search. A local phone produces candidates, never a chosen country. */
export async function searchSubscribers(rawQuery: unknown): Promise<SubscriberSearchResult[]> {
  const query = normalizeSearchQuery(rawQuery);
  const phoneLike = /^[+\d\s()\-.\u200e\u200f]+$/u.test(query);

  let organizations: SearchOrganization[];
  if (phoneLike) {
    const candidates = phoneCandidates(query);
    if (candidates.length === 0) {
      throw new SubscriberSearchInputError('Enter a complete phone number');
    }

    const matchingRows = await prisma.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT ws."organizationId"
      FROM "WhatsappSession" ws
      JOIN "Organization" organization ON organization."id" = ws."organizationId"
      WHERE regexp_replace(
        regexp_replace(COALESCE(ws."phoneNumber", ''), '^\\s*00', ''),
        '[^0-9]',
        '',
        'g'
      ) IN (${Prisma.join(candidates)})
      GROUP BY ws."organizationId", organization."name"
      ORDER BY organization."name" ASC, ws."organizationId" ASC
      LIMIT ${SEARCH_LIMIT}
    `);
    const organizationIds = matchingRows.map((row) => row.organizationId);
    organizations = organizationIds.length === 0
      ? []
      : await prisma.organization.findMany({
          where: { id: { in: organizationIds } },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: SEARCH_ORGANIZATION_SELECT,
        });
  } else {
    organizations = await prisma.organization.findMany({
      where: { name: { contains: query, mode: 'insensitive' } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_LIMIT,
      select: SEARCH_ORGANIZATION_SELECT,
    });
  }

  return organizations.map(presentSearchResult);
}

type DiagnosticFailureSource =
  | 'Outbound message'
  | 'Channel setup'
  | 'Channel credential'
  | 'Gateway health'
  | 'Platform alert';

type DiagnosticFailure = {
  source: DiagnosticFailureSource;
  occurredAt: string;
  reason: string;
  resolved: boolean;
};

/** Raw provider text stays server-side; support receives a stable, actionable reason. */
function humanFailureReason(raw: string | null, source: DiagnosticFailureSource): string {
  const value = String(raw ?? '').toLocaleLowerCase();
  if (/quota|limit|allowance|usage_quota|حصة|الحد/.test(value)) {
    return 'The subscriber reached an enforced usage limit.';
  }
  if (/rate.?limit|too many|429/.test(value)) {
    return 'The WhatsApp provider is temporarily rate limiting requests.';
  }
  if (/credential|token|unauthori[sz]ed|forbidden|permission|\b401\b|\b403\b/.test(value)) {
    return 'The WhatsApp provider rejected the channel credentials.';
  }
  if (/not registered|not a whatsapp|invalid number|مش مسج/.test(value)) {
    return 'The recipient number is not registered on WhatsApp.';
  }
  if (/media|attachment|file too large|unsupported|المرفق/.test(value)) {
    return 'WhatsApp rejected the message attachment.';
  }
  if (/disconnect|not connected|not active|not authenticated|pair|\bqr\b|القناة غير متصلة/.test(value)) {
    return 'The WhatsApp number is disconnected and must be connected again.';
  }
  if (/webhook/.test(value)) {
    return 'The channel webhook could not be registered or reached.';
  }
  if (/timeout|timed out|etimedout/.test(value)) {
    return 'The WhatsApp provider did not respond in time.';
  }
  if (/network|econn|enotfound|socket|dns/.test(value)) {
    return 'The channel could not reach the WhatsApp provider.';
  }

  switch (source) {
    case 'Outbound message': return 'WhatsApp could not send the outbound message.';
    case 'Channel setup': return 'The WhatsApp channel did not complete setup.';
    case 'Channel credential': return 'The WhatsApp channel credential needs attention.';
    case 'Gateway health': return 'The WhatsApp gateway failed its health check.';
    case 'Platform alert': return 'The platform reported an unresolved subscriber incident.';
  }
}

type ChannelDiagnosticState =
  | 'active'
  | 'connecting'
  | 'needs_pairing'
  | 'failed'
  | 'suspended'
  | 'inactive';

type ChannelForState = {
  kind: string;
  status: string;
  provisioningState: string;
  failureReason: string | null;
  metaCredentials: Array<{ status: string }>;
};

function channelState(channel: ChannelForState): ChannelDiagnosticState {
  if (channel.status === 'SUSPENDED' || channel.provisioningState === 'SUSPENDED') return 'suspended';
  if (channel.failureReason || channel.provisioningState === 'FAILED') return 'failed';
  if (channel.provisioningState === 'AWAITING_QR') return 'needs_pairing';
  if (channel.kind === 'WHATSAPP_CLOUD') {
    if (channel.status === 'ACTIVE' && channel.metaCredentials.some((row) => row.status === 'ACTIVE')) {
      return 'active';
    }
    return channel.status === 'PENDING' ? 'connecting' : 'inactive';
  }
  if (channel.status === 'ACTIVE' && channel.provisioningState === 'ACTIVE') return 'active';
  if (channel.status === 'PENDING' || ['PENDING', 'PROVISIONING'].includes(channel.provisioningState)) {
    return 'connecting';
  }
  return 'inactive';
}

export type DiagnosticVerdictFacts = {
  suspended: boolean;
  billingCutoff: boolean;
  trialExpired: boolean;
  paymentPastDue: boolean;
  usableChannel: boolean;
  activeBoundNumber: boolean;
  recentFailure: boolean;
  atLimit: boolean;
  lastInboundAt: Date | null;
  createdAt: Date;
  now: Date;
};

/** One verdict, with precedence fixed here so every caller gives the same answer. */
export function diagnosticVerdict(facts: DiagnosticVerdictFacts): string {
  if (facts.suspended) return 'The customer account is suspended.';
  if (facts.billingCutoff) return 'Payment grace has ended and the account needs billing follow-up.';
  if (facts.trialExpired) return 'The trial has expired and the account needs billing follow-up.';
  if (facts.paymentPastDue) return 'Payment is overdue, but service remains available during the grace period.';
  if (!facts.usableChannel) return 'No WhatsApp channel is currently ready to carry messages.';
  if (!facts.activeBoundNumber) return 'No active business number is bound to a ready WhatsApp channel.';
  if (facts.recentFailure) return 'Recent WhatsApp failures need investigation.';
  if (facts.atLimit) return 'The account has reached at least one enforced limit.';
  if (!facts.lastInboundAt) return 'No customer has sent an inbound message to this account yet.';
  if (facts.now.getTime() - facts.lastInboundAt.getTime() >= STALE_INBOUND_DAYS * 86_400_000) {
    return 'No inbound customer message has arrived in the last 14 days.';
  }
  return 'Account, billing, channel, and current limits look healthy.';
}

const CAPABILITY_LABELS: Record<Capability, string> = {
  seats: 'Seats',
  workspaces: 'Workspaces',
  customFields: 'Custom fields',
  workflows: 'Workflows',
  messages_inbound: 'Inbound messages',
  messages_outbound: 'Outbound messages',
  active_contacts: 'Monthly active contacts',
  ai_tokens_in: 'AI input tokens',
  ai_tokens_out: 'AI output tokens',
  campaign_sends: 'Campaign sends',
  customDomain: 'Custom domain',
  whiteLabel: 'White label',
  maskContactDetails: 'Contact masking',
  autoProvisionGateway: 'Automatic gateway provisioning',
};

function limitItem(
  entitlements: EffectiveEntitlements,
  capability: Capability,
  current: bigint | number,
): {
  capability: Capability;
  label: string;
  current: string;
  limit: string | null;
  state: LimitState;
} {
  const limit = limitOf(entitlements, capability);
  return {
    capability,
    label: CAPABILITY_LABELS[capability],
    current: String(current),
    limit: limit === null ? null : String(limit),
    state: limitState(entitlements, capability, Number(current)),
  };
}

/** Assemble support facts without selecting message bodies, media, contacts, or conversations. */
export async function getSubscriberDiagnostics(organizationId: string, now = new Date()) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      name: true,
      slug: true,
      status: true,
      paymentProvider: true,
      suspendAt: true,
      suspendReason: true,
      downgradeGraceEndsAt: true,
      downgradeGraceReason: true,
      createdAt: true,
      updatedAt: true,
      channels: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          kind: true,
          status: true,
          provisioningState: true,
          provisioningStep: true,
          failureReason: true,
          failureStep: true,
          managedByProvisioner: true,
          provisionedAt: true,
          connectedAt: true,
          suspendedAt: true,
          lastCheckedAt: true,
          updatedAt: true,
          metaCredentials: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              status: true,
              invalidReason: true,
              lastValidatedAt: true,
              displayPhoneNumber: true,
              verifiedName: true,
              qualityRating: true,
              messagingTier: true,
              updatedAt: true,
            },
          },
        },
      },
      whatsappSessions: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          channelId: true,
          label: true,
          phoneNumber: true,
          isActive: true,
        },
      },
    },
  });
  if (!organization) return null;

  const failureSince = new Date(now.getTime() - FAILURE_WINDOW_DAYS * 86_400_000);
  const { start: periodStart, end: periodEnd } = monthRange(now);
  const [
    effective,
    activeSubscription,
    latestSubscription,
    seatCount,
    workspaceCount,
    customFieldCount,
    workflowCount,
    meterRows,
    activeContactRows,
    lastInbound,
    messageFailures,
    healthFailures,
    platformAlerts,
  ] = await Promise.all([
    resolveEntitlements(organizationId, now),
    prisma.subscription.findFirst({
      where: { organizationId, status: { in: LIVE_SUBSCRIPTION_STATUSES } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        provider: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        trialEndsAt: true,
        activatedAt: true,
        ...SUBSCRIPTION_EDITION_SELECT,
      },
    }),
    prisma.subscription.findFirst({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        provider: true,
        currentPeriodEnd: true,
        trialEndsAt: true,
      },
    }),
    prisma.user.count({ where: { organizationId, isActive: true } }),
    prisma.workspace.count({ where: { organizationId } }),
    prisma.customFieldDefinition.count({ where: { organizationId } }),
    prisma.workflow.count({ where: { organizationId } }),
    prisma.usageEvent.groupBy({
      by: ['metric'],
      where: {
        organizationId,
        metric: { not: 'active_contacts' },
        occurredAt: { gte: periodStart, lt: periodEnd },
      },
      _sum: { quantity: true },
    }),
    prisma.usageEvent.findMany({
      where: {
        organizationId,
        metric: 'active_contacts',
        occurredAt: { gte: periodStart, lt: periodEnd },
        subjectId: { not: null },
      },
      distinct: ['subjectId'],
      select: { subjectId: true },
    }),
    prisma.message.findFirst({
      where: { organizationId, direction: 'INBOUND' },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    }),
    prisma.message.findMany({
      where: {
        organizationId,
        direction: 'OUTBOUND',
        status: 'FAILED',
        timestamp: { gte: failureSince },
      },
      orderBy: { timestamp: 'desc' },
      take: FAILURE_LIMIT,
      select: { timestamp: true, failureReason: true },
    }),
    prisma.gatewayHealthCheck.findMany({
      where: { organizationId, ok: false, createdAt: { gte: failureSince } },
      orderBy: { createdAt: 'desc' },
      take: FAILURE_LIMIT,
      select: { createdAt: true, error: true },
    }),
    prisma.platformAlert.findMany({
      where: { organizationId, createdAt: { gte: failureSince } },
      orderBy: { createdAt: 'desc' },
      take: FAILURE_LIMIT,
      select: { createdAt: true, message: true, resolvedAt: true },
    }),
  ]);

  const exactVersion = effective.source === 'subscription'
    ? subscriptionEditionOf(activeSubscription)
    : versionedEditionOf(await prisma.planVersion.findFirstOrThrow({
        where: { isCurrent: true, plan: { code: effective.plan } },
        include: PLAN_VERSION_EDITION_INCLUDE,
      }));
  if (!exactVersion) {
    throw new Error(`Subscriber ${organizationId} resolved to a subscription without edition terms`);
  }

  const channelStates = new Map(
    organization.channels.map((channel) => [channel.id, channelState(channel)]),
  );
  const channels = organization.channels.map((channel) => {
    const credential = channel.metaCredentials[0] ?? null;
    return {
      id: channel.id,
      kind: channel.kind,
      status: channel.status,
      state: channelStates.get(channel.id)!,
      provisioningState: channel.provisioningState,
      provisioningStep: channel.provisioningStep,
      failureStep: channel.failureStep,
      managedByProvisioner: channel.managedByProvisioner,
      problem: channel.failureReason
        ? humanFailureReason(channel.failureReason, 'Channel setup')
        : credential?.status === 'INVALID'
          ? humanFailureReason(credential.invalidReason, 'Channel credential')
          : null,
      provisionedAt: channel.provisionedAt?.toISOString() ?? null,
      connectedAt: channel.connectedAt?.toISOString() ?? null,
      suspendedAt: channel.suspendedAt?.toISOString() ?? null,
      lastCheckedAt: channel.lastCheckedAt?.toISOString() ?? null,
      credential: credential
        ? {
            status: credential.status,
            lastValidatedAt: credential.lastValidatedAt?.toISOString() ?? null,
            displayPhoneNumber: fullInternationalNumber(credential.displayPhoneNumber),
            verifiedName: credential.verifiedName,
            qualityRating: credential.qualityRating,
            messagingTier: credential.messagingTier,
          }
        : null,
    };
  });

  const numbers = organization.whatsappSessions.map((session) => {
    const boundChannelState = session.channelId ? channelStates.get(session.channelId) ?? null : null;
    const state = !session.isActive
      ? 'inactive'
      : !session.channelId
        ? 'unbound'
        : boundChannelState === 'active'
          ? 'active'
          : 'channel_unavailable';
    return {
      id: session.id,
      label: session.label,
      phoneNumber: fullInternationalNumber(session.phoneNumber),
      isActive: session.isActive,
      channelId: session.channelId,
      channelKind: organization.channels.find((channel) => channel.id === session.channelId)?.kind ?? null,
      state,
    };
  });

  const recentFailures: DiagnosticFailure[] = [
    ...messageFailures.map((failure) => ({
      source: 'Outbound message' as const,
      occurredAt: failure.timestamp.toISOString(),
      reason: humanFailureReason(failure.failureReason, 'Outbound message'),
      resolved: false,
    })),
    ...healthFailures.map((failure) => ({
      source: 'Gateway health' as const,
      occurredAt: failure.createdAt.toISOString(),
      reason: humanFailureReason(failure.error, 'Gateway health'),
      resolved: false,
    })),
    ...platformAlerts.map((alert) => ({
      source: 'Platform alert' as const,
      occurredAt: alert.createdAt.toISOString(),
      reason: humanFailureReason(alert.message, 'Platform alert'),
      resolved: alert.resolvedAt !== null,
    })),
    ...organization.channels.flatMap((channel) => channel.failureReason
      ? [{
          source: 'Channel setup' as const,
          occurredAt: channel.updatedAt.toISOString(),
          reason: humanFailureReason(channel.failureReason, 'Channel setup'),
          resolved: false,
        }]
      : []),
    ...organization.channels.flatMap((channel) => channel.metaCredentials.flatMap((credential) =>
      credential.status === 'INVALID'
        ? [{
            source: 'Channel credential' as const,
            occurredAt: credential.updatedAt.toISOString(),
            reason: humanFailureReason(credential.invalidReason, 'Channel credential'),
            resolved: false,
          }]
        : [])),
  ]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, FAILURE_LIMIT);

  const meterUsage = new Map<UsageMetric, bigint>(
    meterRows.map((row) => [row.metric, row._sum.quantity ?? 0n]),
  );
  meterUsage.set('active_contacts', BigInt(activeContactRows.length));
  const limits = [
    limitItem(effective, 'seats', seatCount),
    limitItem(effective, 'workspaces', workspaceCount),
    limitItem(effective, 'customFields', customFieldCount),
    limitItem(effective, 'workflows', workflowCount),
    ...USAGE_METRICS.map((metric) => limitItem(effective, metric, meterUsage.get(metric) ?? 0n)),
  ];

  const lastInboundAt = lastInbound?.timestamp ?? null;
  const usableChannel = [...channelStates.values()].some((state) => state === 'active');
  const activeBoundNumber = numbers.some((number) => number.state === 'active');
  const verdict = diagnosticVerdict({
    suspended: organization.status === 'SUSPENDED',
    billingCutoff: organization.suspendAt !== null && organization.suspendAt <= now,
    trialExpired: latestSubscription?.status === 'TRIALING'
      && latestSubscription.trialEndsAt !== null
      && latestSubscription.trialEndsAt <= now,
    paymentPastDue: latestSubscription?.status === 'PAST_DUE',
    usableChannel,
    activeBoundNumber,
    recentFailure: recentFailures.some((failure) => !failure.resolved),
    atLimit: limits.some((item) => item.state === 'full'),
    lastInboundAt,
    createdAt: organization.createdAt,
    now,
  });

  return {
    capturedAt: now.toISOString(),
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      status: organization.status,
      createdAt: organization.createdAt.toISOString(),
      updatedAt: organization.updatedAt.toISOString(),
    },
    plan: {
      source: effective.source,
      code: exactVersion.edition.code,
      name: exactVersion.edition.name,
      planVersionId: exactVersion.planVersionId,
      version: exactVersion.version,
      priceId: exactVersion.priceId,
      pricingModel: exactVersion.edition.pricingModel,
      billingInterval: exactVersion.edition.billingInterval,
      currency: exactVersion.edition.currency,
      listPriceCents: exactVersion.edition.monthlyPriceCents,
      effectivePriceCents: effective.effectivePriceCents,
      subscription: activeSubscription
        ? {
            id: activeSubscription.id,
            status: activeSubscription.status,
            provider: activeSubscription.provider,
            currentPeriodStart: activeSubscription.currentPeriodStart?.toISOString() ?? null,
            currentPeriodEnd: activeSubscription.currentPeriodEnd?.toISOString() ?? null,
            trialEndsAt: activeSubscription.trialEndsAt?.toISOString() ?? null,
            activatedAt: activeSubscription.activatedAt?.toISOString() ?? null,
          }
        : null,
      override: {
        active: effective.isOverridden,
        plan: effective.override.plan,
        macQuota: effective.override.macQuota,
        discountPercent: effective.override.discountPercent,
        creditCents: effective.override.creditCents,
        reason: effective.override.reason,
        expiresAt: effective.override.expiresAt?.toISOString() ?? null,
        expired: effective.override.expired,
      },
    },
    billing: {
      paymentProvider: organization.paymentProvider,
      latestSubscriptionStatus: latestSubscription?.status ?? null,
      suspendAt: organization.suspendAt?.toISOString() ?? null,
      suspendReason: organization.suspendReason,
      downgradeGraceEndsAt: organization.downgradeGraceEndsAt?.toISOString() ?? null,
      downgradeGraceReason: organization.downgradeGraceReason,
    },
    channels,
    numbers,
    lastInboundAt: lastInboundAt?.toISOString() ?? null,
    recentFailures,
    usagePeriod: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
    },
    limits,
    verdict,
  };
}
