import 'dotenv/config';
import { Job, Worker } from 'bullmq';
import logger from '../lib/logger';
import { runAsPlatform } from '../lib/tenant-context';
import {
  GatewayAction,
  markGatewayFailed,
  processGatewayAction,
} from '../modules/provisioning/gateway-provisioning.service';
import { DockerComposeGatewayRuntime } from '../modules/provisioning/gateway-runtime';
import { prisma } from '../prisma';
import {
  gatewayProvisioningQueue,
  gatewayQueueConnection,
  queueGatewayAction,
} from './gateway-provisioning.queue';

const runtime = new DockerComposeGatewayRuntime();
const organizationLocks = new Map<string, Promise<unknown>>();

async function serialized<T>(organizationId: string, operation: () => Promise<T>): Promise<T> {
  const previous = organizationLocks.get(organizationId) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const current = previous.catch(() => undefined).then(() => gate);
  organizationLocks.set(organizationId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (organizationLocks.get(organizationId) === current) organizationLocks.delete(organizationId);
  }
}

async function processJob(job: Job): Promise<{ connected?: boolean }> {
  const { organizationId, action } = job.data as {
    organizationId?: string;
    action?: GatewayAction;
  };
  if (!organizationId || !action) throw new Error('Gateway job is missing organizationId or action');

  try {
    return await serialized(organizationId, () =>
      processGatewayAction(organizationId, action, runtime),
    );
  } catch (error) {
    const attempts = Number(job.opts.attempts || 1);
    if (job.attemptsMade + 1 >= attempts) {
      await markGatewayFailed(organizationId, String((error as Error)?.message || error));
    }
    throw error;
  }
}

async function reconcileProvisioning(): Promise<void> {
  const channels = await runAsPlatform('gateway-provisioning:reconcile', () =>
    prisma.organizationChannel.findMany({
      where: {
        managedByProvisioner: true,
        OR: [
          { provisioningState: { in: ['PENDING', 'PROVISIONING', 'AWAITING_QR'] } },
          { provisioningState: 'SUSPENDED', provisioningStep: 'SUSPEND_GATEWAY' },
        ],
      },
      select: {
        organizationId: true,
        provisioningState: true,
        provisioningStep: true,
        deletionRequestedAt: true,
      },
    }),
  );

  await Promise.all(channels.map((channel) => {
    let action: GatewayAction = 'provision';
    if (channel.deletionRequestedAt || channel.provisioningStep === 'DESTROY_GATEWAY') action = 'destroy';
    else if (channel.provisioningState === 'AWAITING_QR') action = 'monitor';
    else if (channel.provisioningState === 'SUSPENDED') action = 'suspend';
    return queueGatewayAction(channel.organizationId, action);
  }));
}

export function startGatewayProvisioningWorker(): Worker {
  const worker = new Worker('gateway-provisioning', processJob, {
    connection: gatewayQueueConnection,
    concurrency: Number(process.env.GATEWAY_WORKER_CONCURRENCY || 4),
  });

  worker.on('completed', (job, result: { connected?: boolean }) => {
    const { organizationId, action } = job.data as { organizationId?: string; action?: GatewayAction };
    if (!organizationId) return;
    logger.info('Gateway provisioning job completed', { jobId: job.id, organizationId, action });
    if ((action === 'provision' || action === 'resume' || action === 'restart' || action === 'monitor') && !result?.connected) {
      setTimeout(() => {
        queueGatewayAction(organizationId, 'monitor').catch((error) =>
          logger.error('Failed to schedule gateway connection check', {
            organizationId,
            error: String(error),
          }),
        );
      }, Number(process.env.GATEWAY_MONITOR_INTERVAL_MS || 15_000));
    }
  });
  worker.on('failed', (job, error) => {
    logger.error('Gateway provisioning job failed', {
      jobId: job?.id,
      organizationId: job?.data?.organizationId,
      error: error.message,
    });
  });

  reconcileProvisioning().catch((error) =>
    logger.error('Initial gateway reconciliation failed', { error: String(error) }),
  );
  const reconcileTimer = setInterval(() => {
    reconcileProvisioning().catch((error) =>
      logger.error('Gateway reconciliation failed', { error: String(error) }),
    );
  }, Number(process.env.GATEWAY_RECONCILE_INTERVAL_MS || 30_000));
  reconcileTimer.unref();

  logger.info('Gateway provisioning host worker started');
  return worker;
}

if (require.main === module) {
  const worker = startGatewayProvisioningWorker();
  const shutdown = async () => {
    await worker.close();
    await gatewayProvisioningQueue.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
