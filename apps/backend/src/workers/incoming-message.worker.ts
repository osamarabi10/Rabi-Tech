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
import { resumeAwaitingWorkflows } from '../modules/workflows/answer-resume.service';
import { coordinationKey, withFifoRedisLock } from '../lib/redis-coordination';
import { emitWebhook } from '../modules/webhooks/webhook-dispatch.service';
import { extractClickTokens } from '../modules/growth-widgets/widget-token';

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
  mediaFileName?: string;
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
  mediaFileName?: string;
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
    mediaFileName,
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

  /*
    Growth-widget attribution, resolved before the upsert because a new contact
    has to be created carrying it — there is no second chance to stamp it.

    The claim is a **table lookup**, never a pattern match. `extractClickTokens`
    only produces candidates that have the shape of a marker; whether any of
    them means anything is decided here, by finding an unclaimed row. Trusting
    the body would let a customer type `#gw_` and ten characters to assign
    themselves to whichever campaign they liked.

    `claimedByContactId: null` in the where clause is what makes a token
    single-use. A marker forwarded to a friend, or pasted into a second chat,
    finds nothing.
  */
  const claimableClick = await (async () => {
    const candidates = extractClickTokens(body || '');
    if (candidates.length === 0) return null;
    return prisma.widgetClick.findFirst({
      where: { clickToken: { in: candidates }, claimedByContactId: null },
      select: { id: true, widgetId: true, utmCampaign: true },
    });
  })();

  // Find or create contact
  const contact = await prisma.contact.upsert({
    where: { organizationId_phone: { organizationId, phone: normalizedPhone } },
    create: {
      organizationId,
      phone: normalizedPhone,
      ...(contactName ? { name: contactName } : {}),
      /*
        First-touch, and deliberately only in `create`.

        Putting any of this in `update` would do two damaging things: overwrite
        the acquisition of a contact who came back through a second link, and
        break the `createdAt === updatedAt` detector below, which is how this
        worker knows a contact is new without spending a second query on every
        inbound message.

        DIRECT and UNKNOWN are different facts and must not merge. DIRECT means
        we looked for a marker and there was none. UNKNOWN, the column default,
        means the row predates attribution entirely.
      */
      ...(claimableClick
        ? {
          acquisitionSource: 'GROWTH_WIDGET' as const,
          acquisitionWidgetId: claimableClick.widgetId,
          acquisitionUtmCampaign: claimableClick.utmCampaign,
          acquisitionAt: new Date(),
        }
        : { acquisitionSource: 'DIRECT' as const, acquisitionAt: new Date() }),
    },
    update: { ...(contactName ? { name: contactName } : {}) },
  });

  /*
    Claim the click whether or not the contact was new.

    If they were already a contact, first-touch above is untouched — acquisition
    happens once — but the click still led to this conversation and the funnel
    should say so. Recording it is how "this widget produced traffic from people
    who already knew us" stays visible instead of looking like nothing happened.
  */
  if (claimableClick) {
    await prisma.widgetClick.update({
      where: { id: claimableClick.id },
      data: { claimedByContactId: contact.id, claimedAt: new Date() },
    });
  }

  /*
    A brand new contact, and the most common way one appears: a stranger writes
    in. `createdAt === updatedAt` is how an upsert reports which branch it took
    — Prisma does not say, and a second read to find out would cost a query on
    every inbound message to answer a question only the first one needs.
  */
  if (contact.createdAt.getTime() === contact.updatedAt.getTime()) {
    void emitWebhook('contact.created', {
      contactId: contact.id,
      phone: contact.phone,
      name: contact.name,
      source: 'whatsapp',
    }, organizationId);
  }

  /*
    Blocked contacts stop here — before a conversation exists.

    The position is the whole feature. Everything below this line has a side
    effect a blocked person should not be able to cause: opening or reopening a
    thread, firing an auto-reply or an out-of-hours reply, consuming the
    subscriber's metered quota, waking an agent's inbox over Socket.io, and
    triggering round-robin assignment. Dropping the message at the route, or
    filtering blocked contacts out of the inbox query, would leave every one of
    those still happening — invisibly, which is worse than not blocking at all,
    because the operator believes it stopped.

    The contact row is still upserted above, deliberately. The name may have
    changed, and a blocked person's record should stay current: an operator
    reviewing a block needs to see who it is, not a stale snapshot from the day
    they blocked them.

    Logged at info, not debug. This is a moderation control doing something on a
    real person's message, and "did the block actually work?" must be answerable
    from the logs without turning debug on first.
  */
  if (contact.blockedAt) {
    logger.info('Inbound dropped: contact is blocked', {
      organizationId,
      contactId: contact.id,
      blockedAt: contact.blockedAt,
      session,
      waMessageId,
    });
    return;
  }

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
      mediaFileName: hasMedia ? mediaFileName : null,
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

  void emitWebhook('message.received', {
    messageId: inboundMessage.id,
    conversationId: conversation.id,
    contactId: contact.id,
    body: inboundMessage.body,
    hasMedia,
    timestamp: inboundMessage.timestamp,
  }, organizationId);

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
      const result = await ChannelService.sendText(session, phone, welcomeBody).catch(() => null);
      await prisma.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: 'OUTBOUND',
          body: welcomeBody,
          isAuto: true,
          autoType: 'welcome',
          status: result ? 'SENT' : 'FAILED',
          ...(result ? { waMessageId: result.providerMessageId } : {}),
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
        const result = await ChannelService.sendText(session, phone, confirmBody).catch(() => null);
        await prisma.message.create({
          data: {
            organizationId,
            conversationId: conversation.id,
            direction: 'OUTBOUND',
            body: confirmBody,
            isAuto: true,
            autoType: consentResult.consent === 'OPTED_OUT' ? 'opt_out' : 'opt_in',
            status: result ? 'SENT' : 'FAILED',
            ...(result ? { waMessageId: result.providerMessageId } : {}),
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

  /*
    An answer to a question a workflow already asked.

    Checked before the triggers below, and separately from them, because it is
    not a trigger: it continues an existing run from the step after the
    question, carrying that run's log and depth. Dispatching it as a trigger
    would start a second run and let a workflow answer its own question.

    Never allowed to break the pipeline. A customer's message has to be stored,
    routed and shown whatever the automation does — the same rule the triggers
    below already follow.
  */
  if (!fromMe && messageBody) {
    await resumeAwaitingWorkflows({
      organizationId,
      contactId: contact.id,
      body: messageBody,
    }).catch((error) =>
      logger.error('Workflow answer resume failed', {
        contactId: contact.id,
        error: String(error),
      }),
    );
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
