import { currentWorkspaceId } from '../../lib/current-workspace';
import { ChannelService } from '../channels/channel.service';
import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import logger from '../../lib/logger';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { stampFirstResponse } from '../analytics/response-time';
import { describeSendFailure } from '../../utils/send-failure';
import { renderDynamicVariables } from '../../utils/template';
import { gatewayReachableAssetUrl } from '../snippets/snippet-storage';
import { markSuccessfulHumanOutbound } from './conversation-lifecycle.service';
import { emitWebhook } from '../webhooks/webhook-dispatch.service';

/**
 * One outbound path, for every caller that sends a customer a message.
 *
 * ## Why this exists
 *
 * Sending is not a database write with a network call bolted on. It has to
 * persist **before** it sends, stamp response-time analytics, reschedule
 * auto-close, update the thread's activity clock, and reach the agent's inbox
 * live over a socket — and it has to do all of that identically no matter who
 * asked. When the public API needed to send, the choice was to lift this out of
 * the console's reply route or to write a second one beside it. A second one
 * drifts: the next fix to retry behaviour, or to failure text, or to the
 * auto-close clock, lands in one path and not the other, and the divergence is
 * invisible until a customer reports that messages sent by their integration
 * never close their threads.
 *
 * ## Persist first, then send
 *
 * The order is load-bearing and was a real defect. The gateway call used to run
 * before `message.create`, so a transport error *after* successful delivery
 * returned 503 and discarded the message: the customer received it, the agent
 * saw nothing, and re-sending delivered it twice. A failed send is recorded as
 * a `FAILED` row with a reason, never as an absent one.
 *
 * ## What this deliberately does not decide
 *
 * Consent, blocking, permissions and audit are the *caller's* business, because
 * the answer differs by caller: an agent replying in the inbox is a human
 * exercising judgement, and a script is not. Those checks live at each entry
 * point, where the context to make them exists. This function sends.
 */

export type OutboundSender =
  /** An agent in the console. `id` is a real User and lands on `sentById`. */
  | { kind: 'user'; id: string }
  /** The public API. There is no user, so `sentById` stays null by design. */
  | { kind: 'api'; tokenId: string };

export type OutboundInput = {
  conversation: {
    id: string;
    contact: { phone: string; [key: string]: any };
    session: { sessionName: string } | null;
    assignee?: { id: string; name: string } | null;
  };
  body?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
  mediaFileName?: string | null;
  /** An internal note is never sent to WhatsApp and never starts a clock. */
  isInternal?: boolean;
  sender: OutboundSender;
  /** Marks the row as automation, so reporting can tell it from a human reply. */
  isAuto?: boolean;
  autoType?: string | null;
};

export type OutboundResult = {
  message: any;
  /** Non-null when the gateway refused. The message row still exists. */
  sendError: unknown | null;
};

export class OutboundSendError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Render `$contact.*` and `$system.*` placeholders.
 *
 * The timezone read is conditional because it is only needed for `$system.`
 * variables, and an extra query on every single message to support a feature
 * most messages do not use is a cost paid on the hot path.
 */
async function render(body: string, conversation: OutboundInput['conversation']): Promise<string> {
  const text = String(body || '').trim();
  if (!text) return '';

  const timezone = text.includes('$system.')
    ? (await prisma.organizationConfig.findUnique({
        where: { organizationId: getTenantId() },
        select: { timezone: true },
      }))?.timezone
    : undefined;

  const customFieldValues = (conversation.contact as any).customFieldValues || [];
  return renderDynamicVariables(text, {
    contact: {
      ...conversation.contact,
      customFields: Object.fromEntries(
        customFieldValues
          .filter((entry: any) => entry?.fieldDefinition)
          .map((entry: any) => [entry.fieldDefinition.slug, entry.value]),
      ),
    },
    assignee: conversation.assignee ?? null,
    timezone,
  } as any);
}

export async function sendOutboundMessage(input: OutboundInput): Promise<OutboundResult> {
  const organizationId = getTenantId();
  const isInternal = !!input.isInternal;

  if (!String(input.body || '').trim() && !input.mediaUrl) {
    throw new OutboundSendError(400, 'EMPTY_MESSAGE', 'A message needs text or media.');
  }
  // An internal note is stored, not transmitted, so it needs no gateway. A
  // customer-facing message with no session has nowhere to go, and saying so is
  // better than persisting a row that can never be sent.
  if (!isInternal && !input.conversation.session) {
    throw new OutboundSendError(409, 'NO_CHANNEL', 'This conversation has no connected WhatsApp channel.');
  }

  const renderedBody = await render(input.body || '', input.conversation);

  const message = await prisma.message.create({
    data: {
      workspaceId: await currentWorkspaceId(),
      organizationId,
      conversationId: input.conversation.id,
      direction: 'OUTBOUND',
      body: renderedBody || null,
      // Media on an internal note would be sent nowhere and rendered as though
      // it had been delivered.
      mediaUrl: isInternal ? null : input.mediaUrl ?? null,
      mediaType: isInternal ? null : input.mediaType ?? null,
      mediaFileName: isInternal ? null : input.mediaFileName ?? null,
      sentById: input.sender.kind === 'user' ? input.sender.id : null,
      status: isInternal ? 'SENT' : 'PENDING',
      isInternal,
      isAuto: !!input.isAuto,
      autoType: input.autoType ?? null,
    },
  });

  // An internal note is not a response to the customer, so it must not stop the
  // response clock. Fire-and-forget: reporting metadata never delays a send.
  if (!isInternal) {
    stampFirstResponse(input.conversation.id, message.timestamp).catch(() => {});
  }

  let sendError: unknown = null;

  if (!isInternal) {
    try {
      const result = input.mediaUrl
        ? await ChannelService.sendMedia(
            input.conversation.session!.sessionName,
            input.conversation.contact.phone,
            gatewayReachableAssetUrl(input.mediaUrl),
            renderedBody || undefined,
            { mediaType: input.mediaType ?? undefined, fileName: input.mediaFileName ?? undefined },
          )
        : await ChannelService.sendText(
            input.conversation.session!.sessionName,
            input.conversation.contact.phone,
            renderedBody,
          );

      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'SENT', waMessageId: result.providerMessageId },
      });
      message.status = 'SENT';

      /*
        Only a *human* customer-facing send restarts the auto-close clock.
        An API send counts as human here on purpose: it is a deliberate act by
        the subscriber's own software on the subscriber's behalf, and a thread
        that keeps receiving replies from an integration is not idle. Automatic
        replies and broadcasts pass `isAuto` and are excluded by the caller.
      */
      if (!input.isAuto) {
        await markSuccessfulHumanOutbound(input.conversation.id, message.timestamp);
      }
    } catch (error) {
      sendError = error;
      const failure = describeSendFailure(error);
      logger.error('Outbound send failed', {
        error: String(error),
        code: failure.code,
        messageId: message.id,
        sender: input.sender.kind,
        sessionName: input.conversation.session?.sessionName,
      });
      await prisma.message.update({
        where: { id: message.id },
        data: { status: 'FAILED', failureReason: failure.reason },
      });
      message.status = 'FAILED';
      (message as any).failureReason = failure.reason;
    }
  }

  await prisma.conversation.update({
    where: { id: input.conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // The agent watching this thread sees the message appear whether it came from
  // the console beside them or from the subscriber's own software. An
  // integration whose messages are invisible in the inbox is how an agent ends
  // up answering a customer who was already answered.
  try {
    getIO()
      .to(socketRoom.conversation(organizationId, input.conversation.id))
      .emit(SocketEvents.NEW_MESSAGE, { conversationId: input.conversation.id, message });
  } catch {
    // No socket server in a worker or a script. Never fail a delivered message
    // because nobody was listening.
  }

  /*
    Notify subscribers, after the work is done and never before it.

    Fire-and-forget: a webhook is a notification *about* a send, and must not be
    able to fail one. An internal note is excluded — it was never sent to the
    customer, and a receiver told "message.sent" about an agent's private note
    would relay it onward as though it had been.
  */
  if (!isInternal && !sendError) {
    void emitWebhook('message.sent', {
      messageId: message.id,
      conversationId: input.conversation.id,
      contactId: (input.conversation.contact as any).id ?? null,
      body: message.body,
      sentBy: input.sender.kind,
      timestamp: message.timestamp,
    }, organizationId);
  }

  return { message, sendError };
}
