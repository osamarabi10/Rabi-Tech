import { Conversation } from '@prisma/client';
import { prisma } from '../prisma';
import { detectPriority } from '../constants/keywords';
import { resolveAutoReply } from './auto-reply';
import { OpenWAService } from '../modules/whatsapp/openwa.service';
import { getTenantId } from '../lib/tenant-context';
import { nextOrgSequence } from './org-sequence';

export type ActiveConversation = {
  conversation: Conversation;
  /** True only for a brand-new contact thread (never chatted before). */
  isNewSession: boolean;
  /** Customer messaged again on a previously resolved thread — same chat reopened. */
  reopenedFromResolved: boolean;
};

async function mergeConversationInto(primaryId: string, dupId: string) {
  const dupMessages = await prisma.message.findMany({ where: { conversationId: dupId } });
  const organizationId = getTenantId();
  for (const m of dupMessages) {
    if (m.waMessageId) {
      const clash = await prisma.message.findUnique({
        where: {
          organizationId_waMessageId: {
            organizationId,
            waMessageId: m.waMessageId,
          },
        },
      });
      if (clash) {
        await prisma.message.delete({ where: { id: m.id } });
        continue;
      }
    }
    await prisma.message.update({ where: { id: m.id }, data: { conversationId: primaryId } });
  }

  await prisma.conversation.delete({ where: { id: dupId } });
}

/** One thread per contact: merge stray duplicates (incl. post-resolve orphans) into the main chat. */
export async function consolidateContactThreads(contactId: string, sessionId: string) {
  const all = await prisma.conversation.findMany({
    where: { contactId, sessionId, isArchived: false },
    orderBy: { createdAt: 'asc' },
    include: {

      _count: { select: { messages: true } },
    },
  });
  if (all.length === 0) return null;
  if (all.length === 1) return all[0];

  const hadOpenDup = all.some((c) => c.status !== 'RESOLVED');
  const primary =
    all.reduce((best, c) => (c._count.messages > best._count.messages ? c : best));

  for (const dup of all) {
    if (dup.id === primary.id) continue;
    await mergeConversationInto(primary.id, dup.id);
  }

  const latest = await prisma.message.findFirst({
    where: { conversationId: primary.id },
    orderBy: { timestamp: 'desc' },
  });

  return prisma.conversation.update({
    where: { id: primary.id },
    data: {
      ...(latest ? { lastMessageAt: latest.timestamp } : {}),
      // Reopening clears the resolution stamp along with the status. Leaving it
      // set would report the thread as resolved at a moment it is demonstrably
      // still open, and inflate the resolved count for that hour.
      ...(hadOpenDup && primary.status === 'RESOLVED'
        ? { status: 'OPEN' as const, resolvedAt: null }
        : {}),
    },
  });
}

/** Merge duplicate threads for every contact that has more than one conversation. */
export async function consolidateAllDuplicateThreads(): Promise<number> {
  const groups = await prisma.conversation.groupBy({
    by: ['contactId', 'sessionId'],
    where: { isArchived: false },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });

  for (const g of groups) {
    await consolidateContactThreads(g.contactId, g.sessionId);
  }

  return groups.length;
}

/**
 * One chat per customer per session: reuse open thread, or reopen the last resolved one.
 * Only creates a new conversation row when there has never been a thread before.
 */
export async function getOrCreateActiveConversation(
  contactId: string,
  sessionId: string,
  teamId?: string | null
): Promise<ActiveConversation> {
  const existing = await consolidateContactThreads(contactId, sessionId);
  if (existing) {
    if (teamId && !existing.teamId) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { teamId },
      });
      existing.teamId = teamId;
    }
    if (existing.status === 'RESOLVED') {
      const reopened = await prisma.conversation.update({
        where: { id: existing.id },
        // Snooze cleared along with the resolution: see below.
        data: {
          status: 'OPEN',
          resolvedAt: null,
          snoozedUntil: null,
          snoozedByName: null,
          lastMessageAt: new Date(),
          ...(teamId ? { teamId } : {}),
        },
      });
      return {
        conversation: reopened,
        isNewSession: false,
        reopenedFromResolved: true,
      };
    }

    /*
     * A customer reply cancels a snooze.
     *
     * Snoozing says "nothing is expected here until Tuesday". A message from
     * the customer is precisely the thing that makes that untrue, and a
     * product whose entire purpose is that customer messages get answered
     * must not hide the one thread where they just wrote.
     *
     * The alternative — honouring the snooze until it expires — is defensible
     * for an internal task tracker and wrong here.
     */
    if (existing.snoozedUntil) {
      const woken = await prisma.conversation.update({
        where: { id: existing.id },
        data: { snoozedUntil: null, snoozedByName: null },
      });
      return { conversation: woken, isNewSession: false, reopenedFromResolved: false };
    }

    return { conversation: existing, isNewSession: false, reopenedFromResolved: false };
  }

  const organizationId = getTenantId();
  const { anyPrior, conversation } = await prisma.$transaction(async (tx) => {
    const anyPrior = await tx.conversation.count({ where: { contactId, sessionId } });
    const sequence = await nextOrgSequence(tx, organizationId, 'conversationDisplayId');
    const conversation = await tx.conversation.create({
      data: {
        organizationId,
        displayId: 1000 + Number(sequence),
        contactId,
        sessionId,
        status: 'OPEN',
        lastMessageAt: new Date(),
        ...(teamId ? { teamId } : {}),
      },
    });
    return { anyPrior, conversation };
  });

  return {
    conversation,
    isNewSession: anyPrior === 0,
    reopenedFromResolved: false,
  };
}


/**
 * Sends the organization's configured keyword auto-reply, if any.
 *
 * Tickets were removed with the ISP domain: a conversation carries its own
 * status, assignee, tags and closing category, which is what Respond.io does
 * and what this product needs. Keyword detection now only decides WHICH
 * auto-reply to send — and sends nothing when the organization configured none.
 */
export async function maybeSendKeywordAutoReply(opts: {
  session: string;
  phone: string;
  conversationId: string;
  body: string;
  contactName?: string | null;
  isNewSession: boolean;
  openNow: boolean;
}): Promise<void> {
  const { session, phone, conversationId, body, openNow } = opts;
  if (!body?.trim() || !openNow) return;

  const detected = await detectPriority(body);
  const priority = detected.priority;
  if (!priority) return;

  const kind = `KEYWORD_${priority}` as
    | 'KEYWORD_CRITICAL' | 'KEYWORD_HIGH' | 'KEYWORD_MEDIUM' | 'KEYWORD_LOW';
  const reply = await resolveAutoReply(kind);
  if (!reply) return;

  await OpenWAService.sendText(session, phone, reply).catch(() => {});
  await prisma.message.create({
    data: {
      organizationId: getTenantId(),
      conversationId,
      direction: 'OUTBOUND',
      body: reply,
      isAuto: true,
      autoType: 'keyword',
    },
  });
}

/** Sends the organization's configured closing message, if any. */
export async function closeConversationWithReply(conversationId: string): Promise<void> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, session: true },
  });
  if (!conv) return;

  const reply = await resolveAutoReply('CONVERSATION_CLOSED');
  if (!reply) return;

  await OpenWAService.sendText(conv.session.sessionName, conv.contact.phone, reply).catch(() => {});
  await prisma.message.create({
    data: {
      organizationId: getTenantId(),
      conversationId: conv.id,
      direction: 'OUTBOUND',
      body: reply,
      isAuto: true,
      autoType: 'resolved',
    },
  });
}
