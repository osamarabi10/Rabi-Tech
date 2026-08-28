import { Worker } from 'bullmq';
import { prisma } from '../prisma';
import { runAsOrganization, runAsPlatform } from '../lib/tenant-context';
import logger from '../lib/logger';
import { closeConversation } from '../modules/conversations/conversation-lifecycle.service';
import {
  autoCloseConnection,
  conversationAutoCloseQueue,
  scheduleConversationAutoClose,
} from './auto-close.queue';

type AutoCloseJob = {
  organizationId: string;
  conversationId: string;
  expectedAt: string;
};

export async function processAutoCloseJob(data: AutoCloseJob): Promise<boolean> {
  if (!data.organizationId) throw new Error('Auto-close job missing organizationId');
  return runAsOrganization(data.organizationId, async () => {
    const expectedAt = new Date(data.expectedAt);
    if (Number.isNaN(expectedAt.getTime())) return false;

    const [conversation, config] = await Promise.all([
      prisma.conversation.findUnique({ where: { id: data.conversationId } }),
      prisma.organizationConfig.findUnique({
        where: { organizationId: data.organizationId },
        select: { autoCloseEnabled: true },
      }),
    ]);
    if (
      !conversation
      || conversation.status === 'RESOLVED'
      || !config?.autoCloseEnabled
      || !conversation.autoCloseEligible
      || !conversation.autoCloseAt
      || conversation.autoCloseAt.getTime() !== expectedAt.getTime()
      || conversation.autoCloseAt.getTime() > Date.now()
    ) return false;

    const result = await closeConversation({
      conversationId: conversation.id,
      source: 'AUTO_CLOSE',
      sendClosingReply: false,
    });
    return result.changed;
  });
}

export async function recoverConversationAutoCloseJobs(): Promise<number> {
  const rows = await runAsPlatform('recover-conversation-auto-close-jobs', () =>
    prisma.conversation.findMany({
      where: { autoCloseAt: { not: null }, status: { not: 'RESOLVED' } },
      select: { id: true, organizationId: true, autoCloseAt: true },
    }),
  );

  for (const row of rows) {
    if (!row.autoCloseAt) continue;
    await runAsOrganization(row.organizationId, () =>
      scheduleConversationAutoClose(row.id, row.autoCloseAt!),
    );
  }
  return rows.length;
}

export function startAutoCloseWorker() {
  const worker = new Worker(
    'conversation-auto-close',
    async (job) => processAutoCloseJob(job.data as AutoCloseJob),
    { connection: autoCloseConnection },
  );
  worker.on('failed', (job, error) => {
    logger.error('Conversation auto-close job failed', { jobId: job?.id, error: String(error) });
  });
  logger.info('Conversation auto-close worker started');
  return worker;
}

export { conversationAutoCloseQueue };
