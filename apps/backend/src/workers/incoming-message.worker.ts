import { Queue, Worker } from 'bullmq';
import { ChannelService } from '../modules/channels/channel.service';
import { prisma } from '../prisma';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import {
  getOrCreateActiveConversation,
  maybeSendKeywordAutoReply,
} from '../utils/conversation-session';
import { handleClientFeedback } from '../utils/client-feedback';
import { applyInboundConsentSignal } from '../utils/consent';
import { notifyNewMessage } from '../utils/notification-service';
import { getWorkingHoursConfig, maybeSendOutOfHoursReply } from '../utils/out-of-hours';
import { isWithinWorkingHours } from '../utils/working-hours';
import { resolveAutoReply } from '../utils/auto-reply';
import logger from '../lib/logger';
import { getTenantId, runAsOrganization } from '../lib/tenant-context';
import { recordMessageUsage } from '../modules/usage/usage.service';
import { scheduleConversationEscalation } from './escalation.worker';
import { autoAssignConversation } from '../modules/routing/assignment.service';
import { dispatchWorkflowEvent } from './workflow.worker';
import { coordinationKey, withFifoRedisLock } from '../lib/redis-coordination';

// Redis connection config (same as campaign worker)
const redisUrl = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  ...(redisUrl.password ? { password: redisUrl.password } : {}),
  maxRetriesPerRequest: null,
};

// Incoming message queue
export const incomingMessageQueue = new Queue('incoming-message', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: 100, // Keep failed messages for ops to retry manually
  },
});

/**
 * Queue an incoming message for async processing.
 * Returns immediately so webhook can respond 200 to OpenWA.
 */
export async function queueIncomingMessage(payload: {
  session: string;
  phone: string;
  contactName?: string;
  body: string;
  waMessageId?: string;
  hasMedia?: boolean;
  mediaUrl?: string;
  mediaType?: string;
  fromMe?: boolean;
  organizationId: string;
}) {
  try {
    await incomingMessageQueue.add('process', payload, {
      jobId: payload.waMessageId ? `${payload.organizationId}--${payload.waMessageId}` : undefined,
    });
  } catch (err) {
    logger.error('Failed to queue incoming message', { error: String(err), waMessageId: payload.waMessageId });
    // Don't throw — webhook already returned 200 to OpenWA
  }
}

/**
 * Process incoming 1:1 message: create contact, conversation, ticket if needed, send auto-reply.
 */
async function processInboundMessage(data: {
  session: string;
  phone: string;
  contactName?: string;
  body: string;
  waMessageId?: string;
  hasMedia?: boolean;
  mediaUrl?: string;
  mediaType?: string;
  fromMe?: boolean;
  organizationId: string;
}) {
  const {
    session,
    phone,
    contactName,
    body,
    waMessageId,
    hasMedia,
    mediaUrl,
    mediaType,
    fromMe,
  } = data;

  // Idempotency check
  const organizationId = getTenantId();
  if (waMessageId) {
    const exists = await prisma.message.findUnique({
      where: { organizationId_waMessageId: { organizationId, waMessageId } },
    });
    if (exists) return;
  }

  // Get session record
  const sessionRecord = await prisma.whatsappSession.findUnique({
    where: { organizationId_sessionName: { organizationId, sessionName: session } },
  });
  if (!sessionRecord) {
    throw new Error(`Session ${session} not found`);
  }

  // Normalize phone — strip WhatsApp suffixes so the same number never creates two contacts
  const normalizedPhone = phone
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/^(\+)/, '');   // strip leading + so +972... and 972... match the same row

  // Find or create contact
  const contact = await prisma.contact.upsert({
    where: { organizationId_phone: { organizationId, phone: normalizedPhone } },
    create: { organizationId, phone: normalizedPhone, ...(contactName ? { name: contactName } : {}) },
    update: { ...(contactName ? { name: contactName } : {}) },
  });

  // Get or create conversation
  const { conversation, isNewSession, reopenedFromResolved } =
    await getOrCreateActiveConversation(contact.id, sessionRecord.id, sessionRecord.teamId);

  // Build message text
  const messageBody =
    body?.trim() ||
    (hasMedia ? `[${mediaType === 'image' ? 'صورة' : mediaType === 'video' ? 'فيديو' : mediaType === 'audio' || mediaType === 'ptt' ? 'رسالة صوتية' : 'ملف'}]` : '');

  if (!messageBody && !hasMedia) {
    logger.debug('Empty message skipped', { phone, waMessageId });
    return;
  }

  // Create message
  const inboundMessage = await prisma.message.create({
    data: {
      organizationId,
      conversationId: conversation.id,
      waMessageId,
      direction: 'INBOUND',
      body: messageBody,
      mediaUrl: hasMedia ? mediaUrl : null,
      mediaType: hasMedia ? mediaType : null,
    },
  });
  try {
    await recordMessageUsage('INBOUND', contact.id, inboundMessage.id, inboundMessage.timestamp);
  } catch (error) {
    // Metering must never prevent or retry an otherwise durable inbound message.
    logger.error('Inbound message could not be metered', {
      error: String(error),
      organizationId,
      messageId: inboundMessage.id,
    });
  }

  // Update conversation timestamp
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Check if conversation is open for support
  const openNow = isWithinWorkingHours(await getWorkingHoursConfig());

  // Global auto-reply gate — admin can disable all auto-replies from settings
  const whConfig = await getWorkingHoursConfig();
  const autoReplyEnabled = whConfig.autoReplyEnabled !== false;

  // Send welcome message to brand-new customers — only if this organization
  // configured one. No fallback: an unconfigured welcome sends nothing.
  if (autoReplyEnabled && isNewSession && !fromMe) {
    const welcomeBody = await resolveAutoReply('WELCOME');
    if (welcomeBody) {
      await ChannelService.sendText(session, phone, welcomeBody).catch(() => {});
      await prisma.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          body: welcomeBody,
          isAuto: true,
          autoType: 'welcome',
        },
      });
    }
  }

  // Opt-out / opt-in keywords. Checked before anything else that could reply:
  // a customer who just typed STOP must not receive a keyword auto-reply in the
  // same breath. Meta enforces this on the official API; on our gateway this is
  // the only thing that does.
  const consentResult = await applyInboundConsentSignal({
    contactId: contact.id,
    body: messageBody,
  }).catch((error) => {
    logger.error('Consent signal handling failed', { error: String(error) });
    return { changed: false, consent: null as null };
  });

  if (consentResult.consent) {
    // Confirm only on an actual change. Repeating the unsubscribe confirmation
    // every time someone types STOP again is the noise opt-out exists to stop.
    if (consentResult.changed && autoReplyEnabled) {
      const kind = consentResult.consent === 'OPTED_OUT' ? 'OPT_OUT_CONFIRM' : 'OPT_IN_CONFIRM';
      const confirmBody = await resolveAutoReply(kind as never).catch(() => null);
      if (confirmBody) {
        await ChannelService.sendText(session, phone, confirmBody).catch(() => {});
        await prisma.message.create({
          data: {
            organizationId,
            conversationId: conversation.id,
            direction: 'OUTBOUND',
            body: confirmBody,
            isAuto: true,
            autoType: consentResult.consent === 'OPTED_OUT' ? 'opt_out' : 'opt_in',
          },
        });
      }
    }
    // Either way a consent keyword is not a support question, so stop here.
    return;
  }

  // Handle customer feedback (ratings, etc.)
  const feedbackHandled = autoReplyEnabled && await handleClientFeedback({
    session,
    phone,
    conversationId: conversation.id,
    body: messageBody,
    openNow,
  });

  // NOTE: the IT/Marketing/Finance department menu was removed. It was a single-tenant ISP
  // artifact that leaked hardcoded department names and a support phone number to customers.
  // Routing is now Team-based and configured per organization.

  // Auto-reply if not feedback & outside working hours
  if (autoReplyEnabled && !feedbackHandled) {
    if (!openNow) {
      await maybeSendOutOfHoursReply(session, phone, conversation.id);
    }

    // Send the keyword auto-reply the organization configured, if any
    await maybeSendKeywordAutoReply({
      session,
      phone,
      conversationId: conversation.id,
      body: messageBody,
      contactName: contact.name,
      isNewSession: isNewSession && !reopenedFromResolved,
      openNow,
    });
  }

  // Auto-assign to an available agent if the team is configured for it.
  // No-ops when already assigned, so a customer replying never bounces their
  // thread to a different agent.
  if (!fromMe) {
    await autoAssignConversation(conversation.id).catch((error) => {
      logger.error('Auto-assignment failed', { error: String(error), conversationId: conversation.id });
      return null;
    });
  }

  // Escalate to supervisors if nobody replies to this customer in time.
  // Re-scheduling uses a stable jobId, so the timer resets on each inbound message.
  if (!fromMe) {
    scheduleConversationEscalation(
      conversation.id,
      `#${conversation.displayId}`,
      new Date(),
    ).catch(() => {});
  }

  // Workflow triggers. Dispatched last so an automation that reassigns or tags
  // acts on the state the rest of the pipeline has already settled, and wrapped
  // so a workflow failure can never stop a customer's message being processed.
  if (!fromMe) {
    await dispatchWorkflowEvent({
      triggerType: 'CONVERSATION_CREATED',
      contactId: contact.id,
      conversationId: conversation.id,
      payload: { text: messageBody },
    });
    if (messageBody) {
      await dispatchWorkflowEvent({
        triggerType: 'KEYWORD_MATCHED',
        contactId: contact.id,
        conversationId: conversation.id,
        payload: { text: messageBody },
      });
    }
    if (!openNow) {
      await dispatchWorkflowEvent({
        triggerType: 'OUT_OF_HOURS',
        contactId: contact.id,
        conversationId: conversation.id,
        payload: { text: messageBody },
      });
    }
  }

  // Notify listeners
  const teamId = conversation.teamId || sessionRecord.teamId;
  const teamRoom = teamId ? socketRoom.team(organizationId, teamId) : socketRoom.organization(organizationId);
  if (isNewSession && !reopenedFromResolved) {
    getIO().to(teamRoom).emit(SocketEvents.NEW_CONVERSATION, {
      conversationId: conversation.id,
      contactPhone: phone,
    });
  }
  if (reopenedFromResolved) {
    getIO().to(teamRoom).emit(SocketEvents.UNREAD_UPDATE, {
      conversationId: conversation.id,
      reopened: true,
    });
  }

  const payload = { conversationId: conversation.id, session };
  getIO().to(socketRoom.conversation(organizationId, conversation.id)).emit(SocketEvents.NEW_MESSAGE, payload);
  getIO().to(teamRoom).emit(SocketEvents.NEW_MESSAGE, payload);
  getIO().to(teamRoom).emit(SocketEvents.UNREAD_UPDATE, payload);

  // Bell-icon notifications for assigned agent + supervisors
  notifyNewMessage(conversation.id, contactName).catch(() => {});
}

/**
 * Start the incoming message worker.
 * Processes queued messages asynchronously with retry logic.
 */
export function startIncomingMessageWorker() {
  const worker = new Worker('incoming-message', async (job) => {
    const data = job.data as any;

    try {
      await processIncomingMessageJob(data);
      logger.debug('Incoming message processed', { phone: data.phone, waMessageId: data.waMessageId });
    } catch (err) {
      logger.error('Incoming message processing failed', {
        error: String(err),
        attempt: job.attemptsMade,
        jobId: job.id,
        phone: data.phone,
      });

      // On final failure, alert ops
      if (job.attemptsMade >= (job.opts.attempts || 3)) {
        logger.error('INCOMING MESSAGE DROPPED — max retries exceeded', {
          phone: data.phone,
          waMessageId: data.waMessageId,
          body: data.body?.slice(0, 100),
        });
        // TODO: emit alert event to ops dashboard
      }

      throw err; // Re-throw so BullMQ marks job as failed
    }
  }, {
    connection,
    // Different tenants and contacts progress independently. The keyed Redis
    // lock below keeps one contact/session stream serialized across replicas.
    concurrency: Number(process.env.INCOMING_MESSAGE_CONCURRENCY || 8),
  });

  worker.on('failed', (job, err) => {
    logger.error('Job permanently failed', {
      jobId: job?.id,
      error: err.message,
      phone: job?.data?.phone,
    });
  });

  logger.info('Incoming message worker started');
  return worker;
}

export async function processIncomingMessageJob(data: any): Promise<void> {
  if (!data.organizationId) throw new Error('Incoming message job missing organizationId');
  const normalizedPhone = String(data.phone || '')
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/^\+/, '');
  const key = coordinationKey(
    'incoming-message',
    data.organizationId,
    String(data.session || ''),
    normalizedPhone,
  );
  await withFifoRedisLock(key, () =>
    runAsOrganization(data.organizationId, () => processInboundMessage(data))
  );
}
