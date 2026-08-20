import { Queue, Worker } from 'bullmq';
import { prisma } from '../prisma';
import logger from '../lib/logger';
import { runAsPlatform, runAsOrganization } from '../lib/tenant-context';
import { campaignQueue } from './campaign.worker';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

const QUEUE_NAME = 'campaign-scheduler';
const SEND_SPACING_MS = Number(process.env.CAMPAIGN_SEND_SPACING_MS || 1200);

export const campaignSchedulerQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Dispatches campaigns whose scheduled time has arrived.
 *
 * Scanning across organizations needs platform scope, but each campaign is then
 * queued inside its own organization scope — a scheduled send must not become a
 * hole in tenant isolation.
 */
export async function dispatchDueCampaigns(now = new Date()) {
  const due = await runAsPlatform('campaign-scheduler:scan', () =>
    prisma.campaign.findMany({
      where: {
        status: 'DRAFT',
        scheduledAt: { not: null, lte: now },
      },
      select: { id: true, organizationId: true },
      take: 50,
    })
  );

  let dispatched = 0;

  for (const row of due) {
    try {
      await runAsOrganization(row.organizationId, async () => {
        // Claim conditionally: if another instance already moved this campaign to
        // SENDING, updateMany matches nothing and we skip rather than double-send.
        const claimed = await prisma.campaign.updateMany({
          where: { id: row.id, status: 'DRAFT' },
          data: { status: 'SENDING' },
        });
        if (claimed.count === 0) return;

        const campaign = await prisma.campaign.findUnique({
          where: { id: row.id },
          include: {
            recipients: { where: { status: 'pending' }, include: { contact: true } },
            session: true,
          },
        });
        if (!campaign) return;

        const jobs = campaign.recipients.map((r, i) => ({
          name: 'send-message',
          data: {
            organizationId: row.organizationId,
            campaignId: campaign.id,
            recipientId: r.id,
            phone: r.contact.phone,
            message: campaign.message,
            mediaUrl: campaign.mediaUrl,
            session: campaign.session.sessionName,
          },
          // ':' is BullMQ's own key separator and is rejected in custom job ids.
          opts: {
            delay: i * SEND_SPACING_MS,
            jobId: `${row.organizationId}--${campaign.id}--${r.id}`,
          },
        }));

        if (jobs.length === 0) {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: 'SENT', sentAt: new Date() },
          });
          return;
        }

        await campaignQueue.addBulk(jobs);
        dispatched += jobs.length;
        logger.info('Scheduled campaign dispatched', {
          campaignId: campaign.id,
          organizationId: row.organizationId,
          recipients: jobs.length,
        });
      });
    } catch (err) {
      logger.error('Failed to dispatch scheduled campaign', {
        campaignId: row.id,
        organizationId: row.organizationId,
        error: String(err),
      });
    }
  }

  return { scanned: due.length, dispatched };
}

export function startCampaignSchedulerWorker() {
  const worker = new Worker(QUEUE_NAME, async () => dispatchDueCampaigns(), {
    connection,
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    logger.error('Campaign scheduler run failed', { jobId: job?.id, error: err.message });
  });

  campaignSchedulerQueue
    .add(
      'scan',
      {},
      {
        repeat: { every: Number(process.env.CAMPAIGN_SCHEDULER_INTERVAL_MS || 60_000) },
        removeOnComplete: 20,
        removeOnFail: 20,
        jobId: 'platform--campaign-scheduler',
      },
    )
    .catch((err) => logger.error('Failed to register campaign scheduler', { error: String(err) }));

  logger.info('Campaign scheduler worker started');
  return worker;
}
