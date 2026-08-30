import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { syncAllMetaTemplates } from '../modules/meta-templates/meta-templates.service';
import { gatewayQueueConnection } from './gateway-provisioning.queue';

const QUEUE = 'meta-template-sync';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const metaTemplateSyncQueue = new Queue(QUEUE, {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

let worker: Worker | null = null;

/** Webhooks are primary; this paginated sweep repairs missed provider events. */
export async function scheduleMetaTemplateSync(): Promise<void> {
  if (process.env.DISABLE_META_TEMPLATE_SYNC_WORKER === '1') return;
  const every = Number(process.env.META_TEMPLATE_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  await metaTemplateSyncQueue.upsertJobScheduler(
    'platform:meta-template-sync',
    { every: Math.max(60_000, every) },
    { name: 'poll', data: {} },
  );
}

export function startMetaTemplateSyncWorker(): Worker | null {
  if (process.env.DISABLE_META_TEMPLATE_SYNC_WORKER === '1') return null;
  if (worker) return worker;

  worker = new Worker(
    QUEUE,
    async () => syncAllMetaTemplates(),
    { connection: gatewayQueueConnection, concurrency: 1 },
  );
  worker.on('completed', (_job, result) => logger.info('Meta template polling completed', result as object));
  worker.on('failed', (job, error) => logger.error('Meta template polling failed', {
    jobId: job?.id,
    error: String(error),
  }));
  logger.info('Meta template sync worker started');
  return worker;
}
