import { Router, Request, Response } from 'express';
import { prisma } from '../prisma';
import { OpenWAService, sessionNameById } from '../modules/whatsapp/openwa.service';
import { getIO, SocketEvents } from '../socket';
import { socketRoom } from '../socket/rooms';
import { queueIncomingMessage } from '../workers/incoming-message.worker';
import logger from '../lib/logger';

import { getTenantId, runAsOrganization, runAsPlatform } from '../lib/tenant-context';
import { recordMessageUsage } from '../modules/usage/usage.service';
import { queueGatewayAction } from '../workers/gateway-provisioning.queue';
import { recordDelivery } from '../modules/webhooks/webhook-log.service';

/**
 * What an inbound receipt records about its payload.
 *
 * Deliberately NOT the payload. Every inbound webhook carries a customer
 * message, and copying that text into a delivery log would duplicate the
 * entire conversation history into a second table with its own retention and
 * its own set of readers — a real privacy expansion that answers no question
 * the health view asks. Shape and size are enough to tell a healthy delivery
 * from a malformed one.
 */
function inboundSummary(body: any): Record<string, unknown> {
  const data = body?.data || {};
  const message = data?.message || data || {};
  return {
    event: body?.event ?? null,
    session: body?.session ?? body?.sessionName ?? data?.session ?? null,
    messageType: message?.type ?? data?.type ?? null,
    hasBody: Boolean(message?.body ?? message?.text ?? data?.body ?? data?.text),
    hasMedia: Boolean(message?.hasMedia ?? data?.hasMedia),
    fromMe: Boolean(message?.fromMe ?? data?.fromMe),
    payloadBytes: (() => {
      try {
        return JSON.stringify(body ?? {}).length;
      } catch {
        return null;
      }
    })(),
  };
}

const router = Router();

router.post('/webhooks/openwa/:webhookToken', async (req, res, next) => {
  const channel = await runAsPlatform('webhook-channel-lookup', () =>
    prisma.organizationChannel.findUnique({
      where: { webhookToken: req.params.webhookToken },
      select: { organizationId: true, status: true },
    }),
  );
  if (!channel || channel.status !== 'ACTIVE') {
    return res.status(404).json({ error: 'Webhook not found' });
  }
  return runAsOrganization(channel.organizationId, () => next()).catch((error) => {
    logger.error('Failed to establish webhook tenant scope', { error: String(error) });
    res.sendStatus(500);
  });
}, async (req: Request, res: Response) => {

  const receivedAt = Date.now();
  const { event, data } = req.body;
  let session = req.body.session || req.body.sessionName || data?.sessionName || data?.session;
  const sessionId = req.body.sessionId || data?.sessionId;
  if (!session && sessionId) {
    session = await sessionNameById(sessionId);
  }

  console.log(`[webhook] event=${event} session=${session ?? sessionId ?? '?'}`);

  try {
    if (event === 'message' || event === 'message.received' || event === 'message.sent') {
      const organizationId = getTenantId();

      const msg = data?.message || data || {};
      const rawBody =
        msg.body ??
        msg.text ??
        msg.content ??
        msg._data?.body ??
        data?.body ??
        data?.text ??
        '';
      const hasMedia =
        msg.hasMedia === true ||
        data?.hasMedia === true ||
        ['image', 'video', 'audio', 'document', 'ptt', 'sticker'].includes(
          String(msg.type || data?.type || '').toLowerCase()
        );
      const caption = msg.caption ?? data?.caption ?? (typeof rawBody === 'string' ? rawBody : '');
      const from = msg.from || data?.from;

      if (from && String(from).includes('status@broadcast')) return res.sendStatus(200);

      let resolvedFrom = from;
      let lidContactName: string | undefined;
      if (from && String(from).includes('@lid') && session) {
        try {
          const contactInfo = await OpenWAService.getContact(session, from);
          if (contactInfo?.id) {
            const realPhone = contactInfo.id.replace(/@c\.us$/i, '').replace(/@.+$/, '');
            if (realPhone && /^\d{6,15}$/.test(realPhone)) {
              resolvedFrom = realPhone;
              lidContactName = contactInfo.name || contactInfo.pushName || undefined;
              logger.info('LID resolved', { lid: from, realPhone, name: lidContactName });
            }
          }
        } catch (e) {
          logger.warn('Failed to resolve @lid; falling back to stripped id', { from, error: String(e) });
        }
      }

      const payload = {
        body: caption,
        id:
          typeof msg.id === 'object'
            ? msg.id?._serialized
            : msg.id || msg.messageId || data?.id || data?.messageId,
        contactName:
          lidContactName ||
          msg.contact?.pushName ||
          msg.contact?.name ||
          msg.author ||
          data?.contact?.pushName ||
          data?.contact?.name ||
          data?.author,
        fromMe: msg.fromMe === true || data?.fromMe === true,
        hasMedia,
        mediaUrl: msg.mediaUrl || data?.mediaUrl || data?.media?.url,
        mediaType: msg.mediaType || msg.type || data?.type,
        senderId: from && !from.includes('@g.us') ? from : data?.participant || data?.senderId,
      };

      // Group messages are not supported: RabiTech is a 1:1 conversation platform.
      const isGroupChat = String(from || data?.chatId || '').includes('@g.us');
      if (isGroupChat) {
        logger.debug('group message ignored', { session });
      } else if (payload.fromMe) {
        await runAsOrganization(organizationId, () =>
          handleOutboundFromOtherDevice(session || '', {
            from: from || '',
            body: payload.body,
            waMessageId: payload.id,
            hasMedia: payload.hasMedia,
            mediaUrl: payload.mediaUrl,
            mediaType: payload.mediaType,
          })
        );
      } else {
        await queueIncomingMessage({
          organizationId,
          session: session || '',
          phone: normalizePhone(resolvedFrom || msg.chatId || data?.chatId || ''),
          contactName: payload.contactName,
          body: payload.body || '',
          waMessageId: payload.id,
          hasMedia: payload.hasMedia,
          mediaUrl: toProxyMediaUrl(payload.mediaUrl, session || '', payload.id, payload.mediaType) ?? undefined,
          mediaType: payload.mediaType,
          fromMe: payload.fromMe,
        });
      }
    } else if (event === 'message.ack' || event === 'message_ack') {
      const msgId = data?.id?._serialized || data?.id || data?.messageId;
      const ack: number = data?.ack ?? data?.status ?? -99;
      const organizationId = getTenantId();
      if (msgId && ack !== -99) {
        const statusMap: Record<number, string> = {
          0: 'PENDING',
          1: 'SENT',
          2: 'DELIVERED',
          3: 'READ',
          '-1': 'FAILED',
        };
        const newStatus = statusMap[ack];
        if (newStatus) {
          await runAsOrganization(organizationId, async () => {
            const msg = await prisma.message.findUnique({
              where: { organizationId_waMessageId: { organizationId, waMessageId: msgId } },
              select: { id: true, conversationId: true },
            });
            if (msg) {
              await prisma.message.update({
                where: { id: msg.id },
                data: { status: newStatus as any, ...(ack === 3 ? { isRead: true } : {}) },
              });
              getIO().to(socketRoom.conversation(organizationId, msg.conversationId)).emit(SocketEvents.MESSAGE_ACK, {
                messageId: msg.id,
                waMessageId: msgId,
                status: newStatus,
              });
            }

            // A campaign send is not necessarily a Message row, so this is a
            // separate lookup rather than a branch of the one above.
            await advanceCampaignRecipient(organizationId, msgId, ack);
          });
        }
      }
    } else if (
      event === 'session_status' ||
      event === 'session.status' ||
      event === 'session.authenticated' ||
      event === 'session.disconnected'
    ) {
      const organizationId = getTenantId();
      getIO().to(socketRoom.organization(organizationId)).emit(SocketEvents.SESSION_STATUS, {
        session,
        state: data?.state || data?.status || event.split('.')[1],
      });
      if (event === 'session.authenticated' || ['connected', 'authenticated', 'working', 'ready'].includes(
        String(data?.state || data?.status || '').toLowerCase(),
      )) {
        await queueGatewayAction(organizationId, 'monitor');
      }
    }
    await recordDelivery({
      direction: 'INBOUND',
      // The gateway is one endpoint per organization, so its identity is fixed.
      webhookId: 'gateway--openwa',
      eventType: String(event || 'unknown'),
      statusCode: 200,
      ok: true,
      requestPayload: inboundSummary(req.body),
      durationMs: Date.now() - receivedAt,
    });
    res.sendStatus(200);
  } catch (err) {
    logger.error('Webhook error', { error: String(err) });
    // Still a 200 — the gateway must not retry, and a retry storm during an
    // incident is its own outage. But the delivery is recorded as FAILED,
    // because the status we return says nothing about whether we processed it.
    // Inbound health that read only the response code would show a flawless
    // 100% while every message was being dropped.
    await recordDelivery({
      direction: 'INBOUND',
      webhookId: 'gateway--openwa',
      eventType: String(event || 'unknown'),
      statusCode: 200,
      ok: false,
      errorMessage: String(err),
      requestPayload: inboundSummary(req.body),
      durationMs: Date.now() - receivedAt,
    });
    res.sendStatus(200);
  }
});

/** Ack codes that move a campaign recipient forward, in order of progress. */
const CAMPAIGN_ACK_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
};

/**
 * Advances a campaign recipient on a delivery/read ack.
 *
 * WhatsApp acks are not ordered — a `read` can land before the matching
 * `delivered`, and both can be redelivered. Only ever move forward, so a late
 * duplicate cannot walk a recipient's status backwards and corrupt the report.
 */
async function advanceCampaignRecipient(
  organizationId: string,
  waMessageId: string,
  ack: number,
): Promise<void> {
  if (ack < 2) return; // 0/1 add nothing beyond what the send already recorded

  const next = ack === 3 ? 'read' : 'delivered';

  const recipient = await prisma.campaignRecipient.findFirst({
    where: { organizationId, waMessageId },
    select: { id: true, status: true },
  });
  if (!recipient) return;

  const currentRank = CAMPAIGN_ACK_RANK[recipient.status] ?? 0;
  if (currentRank >= CAMPAIGN_ACK_RANK[next]) return;

  const now = new Date();
  await prisma.campaignRecipient.update({
    where: { id: recipient.id },
    data: {
      status: next,
      ...(next === 'delivered' ? { deliveredAt: now } : { readAt: now, deliveredAt: now }),
    },
  });
}

function toProxyMediaUrl(mediaUrl?: string | null, session?: string, msgId?: string, mediaType?: string): string | null {
  const typeSuffix = mediaType ? `&type=${encodeURIComponent(mediaType)}` : '';
  if (mediaUrl) {
    try {
      const h = new URL(mediaUrl).hostname;
      if (['localhost', '127.0.0.1', 'openwa', 'waha'].some((x) => h === x || h.endsWith(`.${x}`))) {
        return `/media-proxy?url=${encodeURIComponent(mediaUrl)}${typeSuffix}`;
      }
    } catch {}
    return mediaUrl;
  }
  if (session && msgId) {
    return `/media-proxy/message?session=${encodeURIComponent(session)}&msgId=${encodeURIComponent(msgId)}${typeSuffix}`;
  }
  return null;
}

function normalizePhone(chatId: string): string {
  return chatId
    .replace(/@c\.us$/i, '')
    .replace(/@s\.whatsapp\.net$/i, '')
    .replace(/@lid$/i, '')
    .replace(/^(\+)/, '');
}

async function handleOutboundFromOtherDevice(
  session: string,
  data: {
    from: string;
    body?: string;
    waMessageId?: string;
    hasMedia?: boolean;
    mediaUrl?: string;
    mediaType?: string;
  }
) {
  const { from, body, waMessageId, hasMedia, mediaUrl, mediaType } = data;
  const organizationId = getTenantId();

  if (waMessageId) {
    const exists = await prisma.message.findUnique({
      where: { organizationId_waMessageId: { organizationId, waMessageId } },
    });
    if (exists) return;
  }

  const phone = normalizePhone(from);
  if (!phone) return;

  const sessionRecord = await prisma.whatsappSession.findUnique({
    where: { organizationId_sessionName: { organizationId, sessionName: session } },
  });
  if (!sessionRecord) return;

  const contact = await prisma.contact.findUnique({
    where: { organizationId_phone: { organizationId, phone } },
  });
  if (!contact) return;

  const conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, sessionId: sessionRecord.id },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) return;

  const messageBody = body?.trim() || (hasMedia ? mediaLabel(mediaType) : '');
  if (!messageBody && !hasMedia) return;

  const alreadyMetered = waMessageId
    ? await prisma.usageEvent.findFirst({
        where: { metric: 'messages_outbound', subjectId: waMessageId },
        select: { id: true },
      })
    : null;

  const savedMessage = await prisma.message.create({
    data: {
      organizationId,
      conversationId: conversation.id,
      waMessageId,
      direction: 'OUTBOUND',
      body: messageBody,
      mediaUrl: hasMedia ? toProxyMediaUrl(mediaUrl, session, waMessageId, mediaType) : null,
      mediaType: hasMedia ? mediaType : null,
      isAuto: false,
    },
  });

  if (!alreadyMetered) {
    await recordMessageUsage('OUTBOUND', contact.id, waMessageId || savedMessage.id).catch((error) => {
      logger.error('Linked-device outbound message could not be metered', {
        error: String(error),
        organizationId,
        messageId: savedMessage.id,
      });
    });
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  const teamId = conversation.teamId || sessionRecord.teamId;
  const teamRoom = teamId ? socketRoom.team(organizationId, teamId) : socketRoom.organization(organizationId);
  const payload = { conversationId: conversation.id, session };
  getIO().to(socketRoom.conversation(organizationId, conversation.id)).emit(SocketEvents.NEW_MESSAGE, payload);
  getIO().to(teamRoom).emit(SocketEvents.NEW_MESSAGE, payload);
}

function mediaLabel(mediaType?: string): string {
  const t = String(mediaType || '').toLowerCase();
  if (t === 'image') return '[image]';
  if (t === 'video') return '[video]';
  if (t === 'audio' || t === 'ptt') return '[voice]';
  if (t === 'sticker') return '[sticker]';
  return '[file]';
}


export default router;
