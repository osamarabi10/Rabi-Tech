import { Queue, Worker } from 'bullmq';
import logger from '../lib/logger';
import { runAsOrganization, runAsPlatform } from '../lib/tenant-context';
import { prisma } from '../prisma';
import { queueMail } from '../modules/mail/mail.service';
import { gatewayQueueConnection } from './gateway-provisioning.queue';

type RecapStats = {
  newContacts: number;
  newConversations: number;
  resolvedConversations: number;
  inboundMessages: number;
  outboundMessages: number;
};

export const weeklyRecapQueue = new Queue('weekly-recap', {
  connection: gatewayQueueConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: true,
    removeOnFail: 50,
  },
});

function localScheduleParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || '';
  return {
    weekday: value('weekday'),
    hour: Number(value('hour')),
    dateKey: `${value('year')}-${value('month')}-${value('day')}`,
  };
}

async function recapStats(organizationId: string, now: Date): Promise<RecapStats> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  return runAsOrganization(organizationId, async () => {
    const [newContacts, newConversations, resolvedConversations, inboundMessages, outboundMessages] = await Promise.all([
      prisma.contact.count({ where: { createdAt: { gte: since, lt: now } } }),
      prisma.conversation.count({ where: { createdAt: { gte: since, lt: now } } }),
      prisma.conversation.count({ where: { resolvedAt: { gte: since, lt: now } } }),
      prisma.message.count({ where: { direction: 'INBOUND', timestamp: { gte: since, lt: now } } }),
      prisma.message.count({ where: { direction: 'OUTBOUND', timestamp: { gte: since, lt: now } } }),
    ]);
    return { newContacts, newConversations, resolvedConversations, inboundMessages, outboundMessages };
  });
}

function recapCopy(locale: string, workspace: string, stats: RecapStats) {
  if (locale === 'he') {
    return {
      subject: `הסיכום השבועי של ${workspace}`,
      body: [
        `הנה סיכום הפעילות של ${workspace} בשבעת הימים האחרונים:`,
        '',
        `אנשי קשר חדשים: ${stats.newContacts}`,
        `שיחות חדשות: ${stats.newConversations}`,
        `שיחות שנפתרו: ${stats.resolvedConversations}`,
        `הודעות נכנסות: ${stats.inboundMessages}`,
        `הודעות יוצאות: ${stats.outboundMessages}`,
      ].join('\n'),
    };
  }
  if (locale === 'en') {
    return {
      subject: `${workspace} weekly recap`,
      body: [
        `Here is ${workspace}'s activity for the last seven days:`,
        '',
        `New contacts: ${stats.newContacts}`,
        `New conversations: ${stats.newConversations}`,
        `Resolved conversations: ${stats.resolvedConversations}`,
        `Inbound messages: ${stats.inboundMessages}`,
        `Outbound messages: ${stats.outboundMessages}`,
      ].join('\n'),
    };
  }
  return {
    subject: `ملخّص ${workspace} الأسبوعي`,
    body: [
      `هاي خلاصة شغل ${workspace} بآخر سبع أيام:`,
      '',
      `جهات اتصال جديدة: ${stats.newContacts}`,
      `محادثات جديدة: ${stats.newConversations}`,
      `محادثات انحلّت: ${stats.resolvedConversations}`,
      `رسائل واردة: ${stats.inboundMessages}`,
      `رسائل صادرة: ${stats.outboundMessages}`,
    ].join('\n'),
  };
}

/** Queue Monday recaps at 08:00 in each workspace's own timezone. */
export async function queueDueWeeklyRecaps(now = new Date()): Promise<{ workspaces: number; emails: number }> {
  const workspaces = await runAsPlatform('weekly-recap:eligible-workspaces', () =>
    prisma.organization.findMany({
      where: { status: 'ACTIVE', configuration: { weeklyRecapEnabled: true } },
      select: {
        id: true,
        name: true,
        configuration: { select: { timezone: true } },
        weeklyRecapRecipients: {
          where: { user: { isActive: true } },
          select: {
            userId: true,
            user: {
              select: {
                locale: true,
                identity: { select: { email: true } },
              },
            },
          },
        },
      },
    }),
  );

  let dueWorkspaces = 0;
  let emails = 0;
  for (const workspace of workspaces) {
    const timezone = workspace.configuration?.timezone || 'Asia/Jerusalem';
    const local = localScheduleParts(now, timezone);
    // Four hours of catch-up after an outage. The outbox dedupe key still
    // guarantees one message per recipient and local Monday.
    if (local.weekday !== 'Mon' || local.hour < 8 || local.hour > 11) continue;
    if (!workspace.weeklyRecapRecipients.length) continue;

    dueWorkspaces += 1;
    const stats = await recapStats(workspace.id, now);
    for (const recipient of workspace.weeklyRecapRecipients) {
      const copy = recapCopy(recipient.user.locale, workspace.name, stats);
      const queued = await queueMail({
        organizationId: workspace.id,
        to: recipient.user.identity.email,
        kind: 'WEEKLY_RECAP',
        subject: copy.subject,
        body: copy.body,
        dedupeKey: `weekly-recap:${workspace.id}:${recipient.userId}:${local.dateKey}`,
      });
      if (queued) emails += 1;
    }
  }
  return { workspaces: dueWorkspaces, emails };
}

let worker: Worker | null = null;

export function startWeeklyRecapWorker(): Worker | null {
  if (process.env.DISABLE_WEEKLY_RECAP_WORKER === '1') return null;
  if (worker) return worker;

  weeklyRecapQueue.upsertJobScheduler(
    'platform--weekly-recap-hourly',
    { pattern: process.env.WEEKLY_RECAP_CRON || '10 * * * *' },
    { name: 'sweep', data: {} },
  ).catch((error) => logger.error('Failed to schedule weekly recaps', { error: String(error) }));

  worker = new Worker(
    'weekly-recap',
    async () => {
      const result = await queueDueWeeklyRecaps();
      logger.info('Weekly recap sweep complete', result);
      return result;
    },
    { connection: gatewayQueueConnection, concurrency: 1 },
  );
  worker.on('failed', (job, error) => {
    logger.error('Weekly recap job failed', { jobId: job?.id, error: error.message });
  });
  logger.info('Weekly recap worker started');
  return worker;
}
