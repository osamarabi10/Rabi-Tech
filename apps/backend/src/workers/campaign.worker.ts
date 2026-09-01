import { Queue, Worker } from 'bullmq';
import { ChannelService } from '../modules/channels/channel.service';
import { prisma } from '../prisma';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import { runAsOrganization } from '../lib/tenant-context';
import logger from '../lib/logger';
import { quietWindow, resolveContactTimezone } from '../utils/contact-timezone';
import { isCapabilityNotIncludedError, isQuotaExceededError } from '../modules/usage/entitlements';
import { resolveEntitlements } from '../modules/billing/entitlements.resolver';
import { getEdition } from '../modules/billing/editions.service';
import {
  coordinationKey,
  waitForRedisRateLimit,
  withFifoRedisLock,
} from '../lib/redis-coordination';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export const campaignQueue = new Queue('campaign-send', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

/**
 * Whether this recipient is inside their own quiet window, and for how long.
 *
 * Returns null when quiet hours are off, when the window is malformed, or when
 * the recipient is awake. Every failure resolves to "send now": a broadcast
 * that stops working because a timezone lookup threw would be a far worse
 * outcome than one message arriving at an awkward hour, and the caller is a
 * worker with nobody watching it.
 *
 * Call inside the organization scope — it reads `OrganizationConfig`.
 */
async function quietHoursHold(
  phone: string,
  recipientId: string | undefined,
): Promise<{ msUntilOver: number } | null> {
  try {
    const config = await prisma.organizationConfig.findFirst({
      select: { quietHoursEnabled: true, quietHoursStart: true, quietHoursEnd: true, timezone: true },
    });
    if (!config?.quietHoursEnabled) return null;

    // The recipient row carries the contact; the contact carries the asserted
    // country. Falling back to the phone prefix, then to the organization's own
    // timezone — see resolveContactTimezone for why that default is usually
    // right rather than merely safe.
    const recipient = recipientId
      ? await prisma.campaignRecipient.findUnique({
          where: { id: recipientId },
          select: { contact: { select: { countryCode: true, phone: true } } },
        })
      : null;

    const { timezone } = resolveContactTimezone({
      countryCode: recipient?.contact?.countryCode ?? null,
      phone: recipient?.contact?.phone ?? phone,
      organizationTimezone: config.timezone,
    });

    const window = quietWindow({
      at: new Date(),
      timezone,
      start: config.quietHoursStart,
      end: config.quietHoursEnd,
    });
    return window.quiet ? { msUntilOver: window.msUntilOver } : null;
  } catch (error) {
    logger.error('Quiet-hours check failed; sending rather than holding', {
      error: String(error),
      recipientId,
    });
    return null;
  }
}

export async function processCampaignJob(data: any) {
  const { organizationId } = data;
  if (!organizationId) throw new Error('Campaign job missing organizationId');

  const gatewayKey = coordinationKey('campaign-gateway', organizationId, String(data.session || ''));
  return withFifoRedisLock(gatewayKey, () => runAsOrganization(organizationId, async () => {
    const { campaignId, recipientId, phone, message, mediaUrl, session } = data;

    try {
      /*
        Quiet hours, in the recipient's local time.

        A broadcast is the one thing this platform does that reaches somebody
        who is not currently talking to it — everything else is a reply. So it
        is the only thing that can wake a person at 03:00, and the only place a
        time-of-day guard earns its complexity.

        The recipient is **deferred, never dropped**. Skipping would mean a
        contact silently missing a campaign their neighbours received, which
        looks like a delivery failure and is impossible to distinguish from one
        afterwards. Re-queueing with a delay until the window ends sends it
        late, which is the intent.

        Checked before the rate limiter on purpose: waiting on the gateway
        token and then discovering it is 02:00 for this recipient would spend a
        send slot to do nothing, and the FIFO lock is held for the duration.
      */
      const hold = await quietHoursHold(phone, recipientId);
      if (hold) {
        await campaignQueue.add('send', data, {
          jobId: `campaign--${campaignId}--${recipientId}--held--${Date.now()}`,
          delay: hold.msUntilOver,
        });
        return { deferred: true, minutes: Math.round(hold.msUntilOver / 60_000) };
      }

      const effective = await resolveEntitlements(organizationId);
      const planRate = getEdition(effective.plan);
      const hardMax = positiveInteger(process.env.CAMPAIGN_RATE_HARD_MAX);
      const minimumDuration = positiveInteger(process.env.CAMPAIGN_RATE_MIN_DURATION_MS);
      await waitForRedisRateLimit(
        gatewayKey,
        hardMax ? Math.min(planRate.campaignRateMax, hardMax) : planRate.campaignRateMax,
        minimumDuration
          ? Math.max(planRate.campaignRateDurationMs, minimumDuration)
          : planRate.campaignRateDurationMs,
      );
      const response = mediaUrl
        ? await ChannelService.sendMedia(
            session,
            phone,
            mediaUrl,
            message,
            { campaign: true, campaignSubjectId: recipientId },
          )
        : await ChannelService.sendText(
            session,
            phone,
            message,
            { campaign: true, campaignSubjectId: recipientId },
          );

      if (recipientId) {
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            status: 'sent',
            sentAt: new Date(),
            // Delivery and read acks arrive later keyed by this id.
            // The adapter normalises this, so the worker no longer digs through
            // a provider-shaped response - which is what made the id
            // OpenWA-specific in the first place.
            waMessageId: response.providerMessageId,
          },
        });
      }

      try {
        const stats = await prisma.campaignRecipient.groupBy({
          by: ['status'],
          where: { campaignId },
          _count: true,
        });
        getIO().to(socketRoom.organization(organizationId)).emit(SocketEvents.CAMPAIGN_PROGRESS, { campaignId, stats });
      } catch {}
    } catch (err: any) {
      if (recipientId) {
        await prisma.campaignRecipient.update({
          where: { id: recipientId },
          data: {
            /*
              `pending` means "try again when the quota resets". That is only
              true for an exhausted allowance. A capability the edition never
              included has no reset, so recipients marked pending under one sat
              in the queue forever, waiting on a date that would change nothing
              — this is the state-machine half of that bug, not just a bad
              message.

              CapabilityNotIncludedError is not a QuotaExceededError, so it
              already reaches `failed` here. Stated explicitly rather than left
              to fall through, because the next person to add an error type to
              this branch needs to see which way it has to go and why.
            */
            status: isQuotaExceededError(err) && !isCapabilityNotIncludedError(err)
              ? 'pending'
              : 'failed',
            error: err.message,
          },
        });
      }
      throw err;
    }
  }));
}

export function startCampaignWorker() {
  const worker = new Worker(
    'campaign-send',
    async (job) => processCampaignJob(job.data),
    {
      connection,
      // Work can overlap across gateways. The processor serializes and rate
      // limits each organization/session key independently.
      concurrency: Number(process.env.CAMPAIGN_WORKER_CONCURRENCY || 8),
    }
  );

  worker.on('completed', async (job) => {
    const { campaignId, organizationId } = job.data;
    if (!campaignId || !organizationId) return;

    await runAsOrganization(organizationId, async () => {
      const pending = await prisma.campaignRecipient.count({
        where: { campaignId, status: 'pending' },
      });
      if (pending === 0) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'SENT', sentAt: new Date() },
        });
      }
    });
  });

  worker.on('failed', (job, err) => {
    console.error(`Campaign job failed: ${job?.id}`, err.message);
  });

  console.log('Campaign worker started');
  return worker;
}
