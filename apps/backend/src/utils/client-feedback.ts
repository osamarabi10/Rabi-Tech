import { prisma } from '../prisma';
import { ChannelService } from '../modules/channels/channel.service';
import { resolveAutoReply, renderAutoReply } from './auto-reply';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { getTenantId } from '../lib/tenant-context';

/** Called when a conversation is resolved — sends CSAT prompt and records the pending row. */
export async function sendCsatPrompt(conversationId: string): Promise<void> {
  const organizationId = getTenantId();
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, session: true },
  });
  if (!conv) return;

  // Don't send twice
  const existing = await prisma.csatSurveyResponse.findUnique({
    where: { conversationId_organizationId: { conversationId, organizationId } },
  });
  if (existing) return;

  // Only ask for a rating if this organization configured a CSAT prompt.
  const prompt = await resolveAutoReply('CSAT_PROMPT');
  if (!prompt) return;

  await ChannelService.sendText(conv.session.sessionName, conv.contact.phone, prompt).catch(() => {});
  
  await prisma.message.create({
    data: {
      organizationId,
      conversationId,
      direction: 'OUTBOUND',
      body: prompt,
      isAuto: true,
      autoType: 'csat',
      status: 'SENT',
    },
  });

  await prisma.csatSurveyResponse.create({
    data: {
      organizationId,
      conversationId,
      contactId: conv.contactId,
      assignedToId: conv.assignedToId ?? null,
    },
  });
}

const ARABIC_TO_LATIN: Record<string, string> = {
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
};

export type ClientFeedback =
  | { kind: 'rating'; score: number }
  | { kind: 'thanks' };

export function detectClientFeedback(body: string): ClientFeedback | null {
  const raw = body.trim();
  if (!raw) return null;

  const normalized = raw.replace(/[١٢٣٤٥]/g, (d) => ARABIC_TO_LATIN[d] || d).trim();

  if (/^[1-5]$/.test(normalized)) {
    return { kind: 'rating', score: parseInt(normalized, 10) };
  }

  const ratingWithWords = normalized.match(/(?:تقييم|نجوم?|star)?\s*([1-5])\s*(?:\/\s*5|من\s*5|نجوم?)?/i);
  if (ratingWithWords && raw.length < 40) {
    return { kind: 'rating', score: parseInt(ratingWithWords[1], 10) };
  }

  const thanksPatterns = [
    /شكر/i,
    /ممتاز/i,
    /رائع/i,
    /تمام/i,
    /يعطيك/i,
    /الله يبارك/i,
    /بارك الله/i,
    /احسن/i,
    /أحسن/i,
    /مشكور/i,
    /تسلم/i,
    /ممنون/i,
    /يسلمو/i,
    /الله يعطيك/i,
    /كفو/i,
    /legend/i,
    /^thanks?$/i,
    /^thx$/i,
    /^ok$/i,
    /^okay$/i,
    /👍|🙏|❤|⭐/,
  ];

  const looksLikeNewIssue = /واقف|انقطع|بطيء|مشكلة|عطل|ما في نت|ما يشتغل|تقني|فني/i.test(raw);

  if (!looksLikeNewIssue && thanksPatterns.some((p) => p.test(raw)) && raw.length < 160) {
    return { kind: 'thanks' };
  }

  return null;
}

/** True when we recently sent the resolved + rating prompt on this thread. */
export async function hadRecentResolvePrompt(conversationId: string): Promise<boolean> {
  const msg = await prisma.message.findFirst({
    where: { conversationId, direction: 'OUTBOUND', autoType: 'resolved' },
    orderBy: { timestamp: 'desc' },
  });
  if (!msg) return false;
  const hours = (Date.now() - msg.timestamp.getTime()) / 3_600_000;
  return hours < 72;
}

export async function handleClientFeedback(opts: {
  session: string;
  phone: string;
  conversationId: string;
  body: string;
  openNow: boolean;
}): Promise<boolean> {
  const feedback = detectClientFeedback(opts.body);
  if (!feedback) return false;

  const recentResolve = await hadRecentResolvePrompt(opts.conversationId);
  if (!recentResolve) return false;

  if (!opts.openNow) return true;

  let reply: string | null;
  if (feedback.kind === 'rating') {
    reply = await renderAutoReply('CSAT_THANKS', { score: feedback.score });

    // Persist rating into CsatSurveyResponse
    const organizationId = getTenantId();
    await prisma.csatSurveyResponse.upsert({
      where: {
        conversationId_organizationId: {
          conversationId: opts.conversationId,
          organizationId,
        },
      },
      create: {
        organizationId,
        conversationId: opts.conversationId,
        contactId: (await prisma.conversation.findUnique({ where: { id: opts.conversationId }, select: { contactId: true } }))!.contactId,
        rating: feedback.score,
        respondedAt: new Date(),
      },
      update: { rating: feedback.score, respondedAt: new Date() },
    });

  } else {
    reply = await resolveAutoReply('CSAT_THANKS');
  }

  // The rating is always recorded above. Acknowledging it back to the customer is
  // optional — only send if this organization configured a CSAT_THANKS reply.
  if (reply) {
    await ChannelService.sendText(opts.session, opts.phone, reply).catch(() => {});
    const orgIdForMsg = getTenantId();
    await prisma.message.create({
      data: {
        organizationId: orgIdForMsg,
        conversationId: opts.conversationId,
        direction: 'OUTBOUND',
        body: reply,
        isAuto: true,
        autoType: 'feedback',
      },
    });
  }

  await prisma.conversation.update({
    where: { id: opts.conversationId },
    data: { status: 'PENDING' },
  });

  return true;
}
