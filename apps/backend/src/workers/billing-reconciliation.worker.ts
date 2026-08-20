import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import { reconcileBilling } from '../modules/billing/billing.service';

export const billingReconciliationQueue = new Queue('billing-reconciliation', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

let worker: Worker | null = null;

export async function scheduleBillingReconciliation(): Promise<void> {
  await billingReconciliationQueue.add(
    'reconcile',
    {},
    {
      jobId: 'platform--billing-reconciliation',
      repeat: { pattern: process.env.BILLING_RECONCILIATION_CRON || '*/30 * * * *' },
    },
  );
}

export function startBillingReconciliationWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(
    'billing-reconciliation',
    async () => {
      const result = await reconcileBilling();
      logger.info('Billing reconciliation complete', result);
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );
  worker.on('failed', (job, error) => {
    logger.error('Billing reconciliation failed', { jobId: job?.id, error: String(error) });
  });
  scheduleBillingReconciliation().catch((error) =>
    logger.error('Failed to schedule billing reconciliation', { error: String(error) }),
  );
  return worker;
}

