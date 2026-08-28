import {
  ClosingNoteMode,
  ConversationClosingSource,
  ConversationStatus,
} from '@prisma/client';
import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import { auditLog } from '../../lib/audit';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { sendConversationClosingReply } from '../../utils/conversation-closing-reply';
import { scheduleConversationAutoClose } from '../../workers/auto-close.queue';

export const MIN_AUTO_CLOSE_MINUTES = 30;
export const MAX_AUTO_CLOSE_MINUTES = 14 * 24 * 60;

export class ConversationLifecycleError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'CONVERSATION_LIFECYCLE_INVALID',
  ) {
    super(message);
  }
}

type ActorSnapshot = {
  id?: string | null;
  name?: string | null;
  ipAddress?: string;
  userAgent?: string;
};

export type CloseConversationInput = {
  conversationId: string;
  source: ConversationClosingSource;
  categoryId?: string | null;
  summary?: string | null;
  actor?: ActorSnapshot;
  enforceManualPolicy?: boolean;
  sendClosingReply?: boolean;
};

function normalizeSummary(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length > 2_000) {
    throw new ConversationLifecycleError('Closing summary must be 2,000 characters or fewer');
  }
  return normalized || null;
}

function assertManualClosingPolicy(
  enabled: boolean,
  mode: ClosingNoteMode,
  categoryId: string | null,
  summary: string | null,
): void {
  if (!enabled) return;
  if (
    (mode === 'CATEGORY_REQUIRED' || mode === 'CATEGORY_AND_SUMMARY_REQUIRED')
    && !categoryId
  ) {
    throw new ConversationLifecycleError(
      'A closing category is required',
      400,
      'CLOSING_CATEGORY_REQUIRED',
    );
  }
  if (mode === 'CATEGORY_AND_SUMMARY_REQUIRED' && !summary) {
    throw new ConversationLifecycleError(
      'A closing summary is required',
      400,
      'CLOSING_SUMMARY_REQUIRED',
    );
  }
}

export async function closeConversation(input: CloseConversationInput) {
  const organizationId = getTenantId();
  const summary = normalizeSummary(input.summary);
  const categoryId = input.categoryId?.trim() || null;

  const [conversation, config, category] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: input.conversationId } }),
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: { manualClosingNotesEnabled: true, manualClosingNoteMode: true },
    }),
    categoryId
      ? prisma.conversationCategory.findUnique({ where: { id: categoryId } })
      : Promise.resolve(null),
  ]);

  if (!conversation) {
    throw new ConversationLifecycleError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  }
  if (categoryId && !category) {
    throw new ConversationLifecycleError('Closing category not found', 404, 'CLOSING_CATEGORY_NOT_FOUND');
  }
  if (input.enforceManualPolicy || input.source === 'MANUAL') {
    assertManualClosingPolicy(
      config?.manualClosingNotesEnabled ?? false,
      config?.manualClosingNoteMode ?? 'OPTIONAL',
      categoryId,
      summary,
    );
  }

  if (conversation.status === 'RESOLVED') {
    const existingClosure = await prisma.conversationClosure.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { closedAt: 'desc' },
    });
    return { conversation, closure: existingClosure, changed: false };
  }

  const closedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    // The predicate makes concurrent close requests idempotent. Only the
    // request that actually changes the state may append a closure episode.
    const changed = await tx.conversation.updateMany({
      where: { id: conversation.id, status: { not: 'RESOLVED' } },
      data: {
        status: 'RESOLVED',
        resolvedAt: closedAt,
        autoCloseAt: null,
        snoozedUntil: null,
        snoozedByName: null,
      },
    });

    if (changed.count === 0) {
      const latest = await tx.conversation.findUnique({ where: { id: conversation.id } });
      return { conversation: latest!, closure: null, changed: false };
    }

    const closure = await tx.conversationClosure.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        categoryId,
        categoryName: category?.name ?? null,
        summary,
        source: input.source,
        closedById: input.actor?.id ?? null,
        closedByName: input.actor?.name ?? null,
        openedAt: conversation.openedAt,
        closedAt,
      },
    });
    const updated = await tx.conversation.findUnique({ where: { id: conversation.id } });
    return { conversation: updated!, closure, changed: true };
  });

  if (!result.changed) return result;

  await auditLog({
    userId: input.actor?.id ?? undefined,
    action: `conversation.closed.${input.source.toLowerCase()}`,
    resource: 'conversation',
    resourceId: conversation.id,
    description: [category?.name, summary].filter(Boolean).join(': ') || undefined,
    changes: {
      before: { status: conversation.status, openedAt: conversation.openedAt },
      after: { status: 'RESOLVED', source: input.source, categoryId, summary },
    },
    ipAddress: input.actor?.ipAddress,
    userAgent: input.actor?.userAgent,
  });

  if (input.sendClosingReply) {
    await sendConversationClosingReply(conversation.id);
  }

  try {
    getIO()
      .to(socketRoom.organization(organizationId))
      .emit(SocketEvents.CONVERSATION_RESOLVED, { conversationId: conversation.id });
  } catch {
    // Worker-only processes do not initialize Socket.io; the persisted close
    // is authoritative and must not be rolled back for a missing UI channel.
  }

  return result;
}

export async function reopenConversation(
  conversationId: string,
  actor?: ActorSnapshot,
) {
  const organizationId = getTenantId();
  const [conversation, config] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: { autoCloseEnabled: true },
    }),
  ]);
  if (!conversation) {
    throw new ConversationLifecycleError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
  }
  if (conversation.status !== 'RESOLVED') return { conversation, changed: false };

  const openedAt = new Date();
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      status: 'OPEN',
      resolvedAt: null,
      openedAt,
      firstResponseAt: null,
      autoCloseEligible: config?.autoCloseEnabled ?? false,
      lastHumanOutboundAt: null,
      autoCloseAt: null,
      snoozedUntil: null,
      snoozedByName: null,
    },
  });

  await auditLog({
    userId: actor?.id ?? undefined,
    action: 'conversation.reopened',
    resource: 'conversation',
    resourceId: conversation.id,
    changes: { before: { status: 'RESOLVED' }, after: { status: 'OPEN', openedAt } },
    ipAddress: actor?.ipAddress,
    userAgent: actor?.userAgent,
  });
  return { conversation: updated, changed: true };
}

function deadlineAfter(base: Date, durationMinutes: number): Date {
  return new Date(base.getTime() + durationMinutes * 60_000);
}

export async function markSuccessfulHumanOutbound(
  conversationId: string,
  sentAt = new Date(),
): Promise<Date | null> {
  const organizationId = getTenantId();
  const [conversation, config] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: { autoCloseEnabled: true, autoCloseDurationMinutes: true },
    }),
  ]);
  if (
    !conversation
    || conversation.status === 'RESOLVED'
    || !conversation.autoCloseEligible
    || !config?.autoCloseEnabled
  ) return null;

  const base = conversation.snoozedUntil && conversation.snoozedUntil > sentAt
    ? conversation.snoozedUntil
    : sentAt;
  const autoCloseAt = deadlineAfter(base, config.autoCloseDurationMinutes);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastHumanOutboundAt: sentAt, autoCloseAt },
  });
  await scheduleConversationAutoClose(conversation.id, autoCloseAt);
  return autoCloseAt;
}

export async function cancelConversationAutoClose(conversationId: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: { id: conversationId, autoCloseAt: { not: null } },
    data: { autoCloseAt: null },
  });
}

export async function rescheduleConversationAutoClose(
  conversationId: string,
  wakeAt?: Date | null,
): Promise<Date | null> {
  const organizationId = getTenantId();
  const [conversation, config] = await Promise.all([
    prisma.conversation.findUnique({ where: { id: conversationId } }),
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: { autoCloseEnabled: true, autoCloseDurationMinutes: true },
    }),
  ]);
  if (
    !conversation
    || conversation.status === 'RESOLVED'
    || !conversation.autoCloseEligible
    || !conversation.lastHumanOutboundAt
    || !config?.autoCloseEnabled
  ) {
    await cancelConversationAutoClose(conversationId);
    return null;
  }

  const base = wakeAt && wakeAt > new Date() ? wakeAt : new Date();
  const autoCloseAt = deadlineAfter(base, config.autoCloseDurationMinutes);
  await prisma.conversation.update({ where: { id: conversationId }, data: { autoCloseAt } });
  await scheduleConversationAutoClose(conversationId, autoCloseAt);
  return autoCloseAt;
}

export function isConversationStatus(value: unknown): value is ConversationStatus {
  return typeof value === 'string'
    && ['OPEN', 'PENDING', 'RESOLVED', 'AWAITING_CLIENT'].includes(value);
}
