import { Queue, Worker } from 'bullmq';
import { prisma } from '../prisma';
import { OpenWAService, responseMessageId } from '../modules/whatsapp/openwa.service';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import { runAsOrganization } from '../lib/tenant-context';
import { isQuotaExceededError } from '../modules/usage/entitlements';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

export const campaignQueue = new Queue('campaign-send', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export async function processCampaignJob(data: any) {
  const { organizationId } = data;
  if (!organizationId) throw new Error('Campaign job missing organizationId');

  return runAsOrganization(organizationId, async () => {
    const { campaignId, recipientId, phone, message, mediaUrl, session } = data;

    try {
      const response = mediaUrl
        ? await OpenWAService.sendMedia(
            session,
            phone,
            mediaUrl,
            message,
            { campaign: true, campaignSubjectId: recipientId },
          )
        : await OpenWAService.sendText(
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
            waMessageId: responseMessageId(response),
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
            status: isQuotaExceededError(err) ? 'pending' : 'failed',
            error: err.message,
          },
        });
      }
      throw err;
    }
  });
}

export function startCampaignWorker() {
  const worker = new Worker(
    'campaign-send',
    async (job) => processCampaignJob(job.data),
    {
      connection,
      // Backstop against WhatsApp throttling/bans. OpenWA drives WhatsApp Web
      // rather than an official API, so a number that blasts is at real risk —
      // keep this conservative and concurrency at 1 (sends must stay ordered
      // per gateway). Enqueue-time spacing in the send route is the first line.
      limiter: {
        max: Number(process.env.CAMPAIGN_RATE_MAX || 1),
        duration: Number(process.env.CAMPAIGN_RATE_DURATION_MS || 1000),
      },
      concurrency: 1,
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
