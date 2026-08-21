import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import {
  runHealthChecks,
  sweepHealthChecks,
  type HealthProbe,
} from '../modules/gateway/health-monitor';

/**
 * Scheduled gateway health probes (H1).
 *
 * Two repeatable jobs on one queue, at very different cadences:
 *
 * - `status`   — cheap HTTP poll. This is the one that finds outages.
 * - `selfSend` — an INTERNAL PROBE that sends a real WhatsApp message to the
 *                channel's own number. Rare on purpose: a real message costs
 *                something, and frequent identical automated messages are how a
 *                number gets banned on an unofficial gateway.
 *
 * Job ids use `--`, never `:`. Colons are BullMQ's own key separator and have
 * silently broken both inbound processing and campaign sends in this codebase
 * before.
 */

export const gatewayHealthQueue = new Queue('gateway-health', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    // No retries. A failed probe IS the signal — retrying would paper over the
    // outage this job exists to notice, and the next cycle is minutes away.
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

let worker: Worker | null = null;

export async function scheduleGatewayHealthChecks(): Promise<void> {
  if (process.env.DISABLE_GATEWAY_HEALTH_WORKER === '1') return;

  await gatewayHealthQueue.add(
    'probe',
    { probe: 'status' as HealthProbe },
    {
      jobId: 'platform--gateway-health-status',
      repeat: { pattern: process.env.GATEWAY_HEALTH_STATUS_CRON || '*/15 * * * *' },
    },
  );

  await gatewayHealthQueue.add(
    'probe',
    { probe: 'selfSend' as HealthProbe },
    {
      jobId: 'platform--gateway-health-selfsend',
      repeat: { pattern: process.env.GATEWAY_HEALTH_SELFSEND_CRON || '0 */6 * * *' },
    },
  );

  await gatewayHealthQueue.add(
    'sweep',
    {},
    {
      jobId: 'platform--gateway-health-sweep',
      repeat: { pattern: process.env.GATEWAY_HEALTH_SWEEP_CRON || '30 3 * * *' },
    },
  );
}

export function startGatewayHealthWorker(): Worker | null {
  if (process.env.DISABLE_GATEWAY_HEALTH_WORKER === '1') return null;
  if (worker) return worker;

  worker = new Worker(
    'gateway-health',
    async (job) => {
      if (job.name === 'sweep') {
        const removed = await sweepHealthChecks();
        logger.info('Gateway health sweep complete', { removed });
        return { removed };
      }
      const probe = (job.data?.probe as HealthProbe) || 'status';
      const result = await runHealthChecks(probe);
      // Logged at info even when clean: "the monitor ran and found nothing" is
      // the evidence that silence means healthy rather than stopped.
      logger.info('Gateway health cycle complete', { probe, ...result });
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    logger.error('Gateway health job failed', {
      jobId: job?.id,
      probe: job?.data?.probe,
      error: error.message,
    });
  });

  logger.info('Gateway health worker started');
  return worker;
}
