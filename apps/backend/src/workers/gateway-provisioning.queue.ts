import { Queue } from 'bullmq';
import { GatewayAction } from '../modules/provisioning/gateway-provisioning.service';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
export const gatewayQueueConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

export const gatewayProvisioningQueue = new Queue('gateway-provisioning', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export async function queueGatewayAction(
  organizationId: string,
  action: GatewayAction,
  delay = 0,
): Promise<void> {
  const jobId = `${organizationId}--gateway--${action}`;
  const existing = await gatewayProvisioningQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') await existing.remove();
    else return;
  }
  await gatewayProvisioningQueue.add(
    action,
    { organizationId, action },
    { jobId, delay },
  );
}
