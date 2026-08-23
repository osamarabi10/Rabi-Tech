import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { gatewayQueueConnection } from './gateway-provisioning.queue';
import { reconcileBilling } from '../modules/billing/billing.service';
import { runDunning } from '../modules/billing/dunning.service';

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

      /*
       * Dunning rides the same half-hourly pass.
       *
       * A second scheduler would be a second thing to notice had stopped,
       * and the two are the same job in different words: reconcile what the
       * provider says, then act on what the ledger says.
       *
       * Its failure is caught separately. A provider outage must not stop
       * the deadline clock, and an error in the deadline clock must not make
       * reconciliation look broken.
       */
      let dunning = null;
      try {
        dunning = await runDunning();
        if (dunning.warned || dunning.suspended || dunning.cleared) {
          logger.info('Dunning pass acted', dunning);
        }
      } catch (error) {
        logger.error('Dunning pass failed', { error: String(error) });
      }

      return { ...result, dunning };
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

