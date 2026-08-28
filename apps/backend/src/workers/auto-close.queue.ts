import { Queue } from 'bullmq';
import { getTenantId } from '../lib/tenant-context';
import logger from '../lib/logger';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
export const autoCloseConnection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

export const conversationAutoCloseQueue = new Queue('conversation-auto-close', {
  connection: autoCloseConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 100,
  },
});

export async function scheduleConversationAutoClose(
  conversationId: string,
  autoCloseAt: Date,
): Promise<void> {
  const organizationId = getTenantId();
  const expectedAt = autoCloseAt.toISOString();
  try {
    await conversationAutoCloseQueue.add(
      'close-if-current',
      { organizationId, conversationId, expectedAt },
      {
        delay: Math.max(0, autoCloseAt.getTime() - Date.now()),
        // A deadline is part of the identity. Old jobs are harmless no-ops and
        // cannot delete or replace a newer timer for the same conversation.
        jobId: `${organizationId}--auto-close-${conversationId}-${autoCloseAt.getTime()}`,
      },
    );
  } catch (error) {
    logger.warn('Failed to schedule conversation auto-close', {
      organizationId,
      conversationId,
      expectedAt,
      error: String(error),
    });
  }
}
