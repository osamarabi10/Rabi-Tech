import { Job, Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { runAsOrganization } from '../lib/tenant-context';
import {
  organizationsForNightlyRollup,
  parseDateOnly,
  rollupOrganizationDate,
} from '../modules/usage/usage-rollup.service';
import { addUtcDays, utcDay } from '../modules/usage/usage.service';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

export const usageRollupQueue = new Queue('usage-rollup', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});

export async function queueOrganizationRollup(organizationId: string, date: Date): Promise<void> {
  const dateKey = utcDay(date).toISOString().slice(0, 10);
  await usageRollupQueue.add(
    'rollup-organization-date',
    { organizationId, date: dateKey },
    { jobId: `${organizationId}--usage-rollup--${dateKey}` },
  );
}

async function queueNightlyOrganizationJobs(reference = new Date()): Promise<void> {
  const date = addUtcDays(utcDay(reference), -1);
  const organizations = await organizationsForNightlyRollup(date);
  await Promise.all(organizations.map((organizationId) => queueOrganizationRollup(organizationId, date)));
}

async function processUsageRollupJob(job: Job): Promise<void> {
  if (job.name === 'schedule-nightly') {
    await queueNightlyOrganizationJobs();
    return;
  }

  const { organizationId, date } = job.data as { organizationId?: string; date?: string };
  if (!organizationId || !date) throw new Error('Usage rollup job missing organizationId or date');
  await runAsOrganization(organizationId, () => rollupOrganizationDate(parseDateOnly(date)));
}

export function startUsageRollupWorker(): Worker {
  usageRollupQueue.upsertJobScheduler(
    'platform:usage-rollup-nightly',
    { pattern: '15 0 * * *' },
    { name: 'schedule-nightly', data: {} },
  ).catch((error) => logger.error('Failed to schedule nightly usage rollup', { error: String(error) }));

  const worker = new Worker('usage-rollup', processUsageRollupJob, { connection, concurrency: 2 });
  worker.on('failed', (job, error) => {
    logger.error('Usage rollup job failed', { jobId: job?.id, error: error.message });
  });
  logger.info('Usage rollup worker started');
  return worker;
}
