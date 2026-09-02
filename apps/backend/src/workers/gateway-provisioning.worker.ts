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

/**
 * How long a gateway may sit at AWAITING_QR before we stop asking.
 *
 * Pairing needs a human to scan a code. Until this bound existed, one who
 * never did left the workspace polling forever: `on('completed')` re-queued a
 * monitor job every 15 seconds for as long as the process lived, and
 * reconcileProvisioning queued another every 30 on top. Silent, unbounded, and
 * one loop per unpaired workspace.
 *
 * Two hours rather than minutes or days. A QR screen left open over a lunch
 * break should still work, so minutes is too short; a week of 15-second polls
 * is 40,000 jobs to learn something the first hour already told us, so days is
 * too long. Two hours is roughly one working session, after which nobody is
 * coming back to that screen and a fresh code is wanted anyway.
 *
 * Overridable because the right number is deployment-shaped, not universal.
 */
const PAIRING_WINDOW_MS = Number(process.env.GATEWAY_PAIRING_WINDOW_MS || 2 * 60 * 60 * 1000);

/**
 * Retire gateways nobody ever paired, and report why.
 *
 * FAILED rather than a new state: it already means "this gateway is not going
 * to work without intervention", reconcileProvisioning does not re-queue it, so
 * both loops stop, and maybeProvisionGateway explicitly permits re-provisioning
 * from FAILED — so an admin who comes back tomorrow can start it again and get
 * a fresh window. failureStep records AWAIT_CONNECTION, which distinguishes
 * "nobody scanned" from a gateway that fell over while starting.
 *
 * Anchored on provisionedAt, the moment the gateway became ready to pair.
 * updatedAt is the fallback and deliberately second: any unrelated write to the
 * row would push it forward and keep the window open indefinitely, which is the
 * bug this function exists to end.
 */
async function expireUnpairedGateways(now: Date): Promise<Set<string>> {
  const cutoff = new Date(now.getTime() - PAIRING_WINDOW_MS);
  const stale = await runAsPlatform('gateway-provisioning:expire-unpaired', () =>
    prisma.organizationChannel.findMany({
      where: {
        managedByProvisioner: true,
        provisioningState: 'AWAITING_QR',
        deletionRequestedAt: null,
        OR: [
          { provisionedAt: { not: null, lt: cutoff } },
          { provisionedAt: null, updatedAt: { lt: cutoff } },
        ],
      },
      select: { id: true, organizationId: true, provisionedAt: true, updatedAt: true },
    }),
  );
  if (stale.length === 0) return new Set();

  await runAsPlatform('gateway-provisioning:expire-unpaired-write', async () => {
    for (const channel of stale) {
      await prisma.organizationChannel.update({
        where: { id: channel.id },
        data: {
          provisioningState: 'FAILED',
          failureStep: 'AWAIT_CONNECTION',
          failureReason:
            'The WhatsApp QR code was never scanned, so this gateway was never connected. Start provisioning again to get a fresh code.',
        },
      });
      logger.warn('Gateway retired: QR was never scanned', {
        organizationId: channel.organizationId,
        readyAt: (channel.provisionedAt ?? channel.updatedAt).toISOString(),
        windowMs: PAIRING_WINDOW_MS,
      });
    }
  });
  return new Set(stale.map((channel) => channel.organizationId));
}

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
  // Retired first, so a gateway past its window is not queued for one more
  // monitor pass on the way out.
  const retired = await expireUnpairedGateways(new Date());
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

  await Promise.all(channels.filter((channel) => !retired.has(channel.organizationId)).map((channel) => {
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
        /*
          Re-read the state before asking again.

          This timer is the other half of the unbounded loop: it re-queued a
          monitor every 15 seconds regardless of what had happened to the
          channel in between. Once expireUnpairedGateways retires a gateway to
          FAILED, reconcile stops queueing it but this timer would not, so a
          retired gateway would keep being monitored by a job scheduled before
          it was retired.
        */
        runAsPlatform('gateway-provisioning:monitor-recheck', () =>
          prisma.organizationChannel.findFirst({
            where: { organizationId, managedByProvisioner: true },
            select: { provisioningState: true },
          }),
        )
          .then((channel) => {
            // Both in-progress states, not AWAITING_QR alone: a provision job can
            // complete while the channel is still PROVISIONING, and narrowing to
            // AWAITING_QR would strand it until the next 30s reconcile.
            if (!channel || !['PROVISIONING', 'AWAITING_QR'].includes(channel.provisioningState)) {
              return undefined;
            }
            return queueGatewayAction(organizationId, 'monitor');
          })
          .catch((error) =>
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
