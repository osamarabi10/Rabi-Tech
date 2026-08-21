import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import { rollupSweep, ROLLUP_TRAILING_HOURS } from '../modules/analytics/rollup.service';

/**
 * Scheduled hourly analytics rollup (M7).
 *
 * Runs a few times an hour rather than once, because the trailing window is
 * what makes the numbers correct: campaign delivery and read acks land minutes
 * to hours after the send, and a failed message is marked `FAILED` after the
 * fact. Recomputing the last few hours lets those late facts settle into the
 * bucket they belong to.
 *
 * Recomputation is idempotent, so a missed run costs nothing but freshness and
 * a duplicated run costs nothing at all.
 *
 * Job ids use `--`, never `:`. Colons are BullMQ's own key separator and have
 * silently broken both inbound processing and campaign sends in this codebase
 * before.
 */

export const analyticsRollupQueue = new Queue('analytics-rollup', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    // One attempt. The next cycle recomputes the same window, so a retry would
    // only duplicate work that is about to happen anyway.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

let worker: Worker | null = null;

export async function scheduleAnalyticsRollup(): Promise<void> {
  if (process.env.DISABLE_ANALYTICS_ROLLUP_WORKER === '1') return;

  await analyticsRollupQueue.add(
    'sweep',
    {},
    {
      jobId: 'platform--analytics-rollup-sweep',
      repeat: { pattern: process.env.ANALYTICS_ROLLUP_CRON || '*/20 * * * *' },
    },
  );
}

export function startAnalyticsRollupWorker(): Worker | null {
  if (process.env.DISABLE_ANALYTICS_ROLLUP_WORKER === '1') return null;
  if (worker) return worker;

  worker = new Worker(
    'analytics-rollup',
    async () => {
      const trailing = Number(process.env.ANALYTICS_ROLLUP_TRAILING_HOURS) || ROLLUP_TRAILING_HOURS;
      const result = await rollupSweep(trailing);
      logger.info('Analytics rollup complete', { ...result, trailingHours: trailing });
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    logger.error('Analytics rollup job failed', { jobId: job?.id, error: error.message });
  });

  logger.info('Analytics rollup worker started');
  return worker;
}
