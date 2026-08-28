import { Queue, Worker } from 'bullmq';
import { prisma } from '../prisma';
import { createNotification } from '../utils/notification-service';
import logger from '../lib/logger';
import { getTenantId, runAsOrganization } from '../lib/tenant-context';

const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

export const escalationQueue = new Queue('ticket-escalation', {
  connection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

const ESCALATION_DELAY_MS =
  Number(process.env.TICKET_ESCALATION_MINUTES || 30) * 60 * 1000;

/**
 * Schedule an escalation check for a conversation.
 * If no agent replies within the delay, supervisors and admins are notified.
 */
export async function scheduleConversationEscalation(
  conversationId: string,
  conversationLabel: string,
  since: Date,
) {
  try {
    const organizationId = getTenantId();
    await escalationQueue.add(
      'check',
      { organizationId, conversationId, conversationLabel, since: since.toISOString() },
      {
        delay: ESCALATION_DELAY_MS,
        jobId: `${organizationId}--esc-${conversationId}`,
        // Override any previously scheduled job for this conversation
      },
    );
  } catch (err) {
    logger.warn('Failed to schedule escalation', { conversationId, error: String(err) });
  }
}

async function checkAndEscalate(data: {
  organizationId: string;
  conversationId: string;
  conversationLabel: string;
  since: string;
}) {
  const { conversationId, conversationLabel } = data;
  const since = new Date(data.since);

  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });

  // Skip if already resolved or no longer open
  if (!conv || conv.status === 'RESOLVED') return;

  // Any non-auto agent reply since the trigger point clears the escalation
  const agentReply = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: 'OUTBOUND',
      isAuto: false,
      isInternal: false,
      timestamp: { gt: since },
    },
  });

  if (agentReply) return; // Agent already responded — no escalation needed

  // No agent response → notify all supervisors and admins
  const recipients = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPERVISOR'] }, isActive: true },
    select: { id: true },
  });

  const contactName = conv.contact.name || conv.contact.phone;
  const title = `⚠️ محادثة بحاجة لمتابعة — `;
  const body = `لم يتم الرد على العميل ${contactName} منذ ${Math.round(ESCALATION_DELAY_MS / 60000)} دقيقة`;

  for (const user of recipients) {
    await createNotification({
      userId: user.id,
      type: 'NEW_MESSAGE',
      conversationId,
      title,
      body,
      category: 'ESCALATION',
    }).catch(() => {});
  }

  logger.info('Conversation escalated', { conversationId, conversationLabel });
}

export async function processEscalationJob(data: any): Promise<void> {
  if (!data.organizationId) throw new Error('Escalation job missing organizationId');
  await runAsOrganization(data.organizationId, () => checkAndEscalate(data));
}

export function startEscalationWorker() {
  const worker = new Worker(
    'ticket-escalation',
    async (job) => processEscalationJob(job.data),
    { connection },
  );

  worker.on('failed', (job, err) => {
    logger.error('Escalation job failed', { jobId: job?.id, error: String(err) });
  });

  logger.info('Escalation worker started');
  return worker;
}
