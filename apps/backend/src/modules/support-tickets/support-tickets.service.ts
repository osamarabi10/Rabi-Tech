import crypto from 'crypto';
import {
  Prisma,
  SupportTicketMessageVisibility,
  SupportTicketPriority,
  SupportTicketStatus,
} from '@prisma/client';
import { auditPlatformScope } from '../../lib/audit';
import { prisma } from '../../prisma';
import { getSubscriberDiagnostics } from '../platform/subscriber-diagnostics.service';

export const SUPPORT_DIAGNOSTIC_SNAPSHOT_VERSION = 1;
export const ACTIVE_SUPPORT_TICKET_STATUSES: SupportTicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_CUSTOMER',
];

const SUPPORT_REFERENCE_PATTERN = /^SUP-[0-9]{6,}$/;
const MAX_REFERENCE_LENGTH = 32;
const MAX_LIST_LIMIT = 50;

const TICKET_SUMMARY_INCLUDE = {
  organization: { select: { id: true, name: true, slug: true, status: true } },
  assignee: {
    select: {
      id: true,
      email: true,
      platformRole: true,
      platformDisabledAt: true,
    },
  },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketInclude;

const CUSTOMER_DETAIL_INCLUDE = {
  assignee: { select: { id: true } },
  messages: {
    where: { visibility: 'PUBLIC' as const },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      visibility: true,
      authorType: true,
      authorName: true,
      body: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SupportTicketInclude;

const PLATFORM_DETAIL_INCLUDE = {
  organization: { select: { id: true, name: true, slug: true, status: true } },
  assignee: {
    select: {
      id: true,
      email: true,
      platformRole: true,
      platformDisabledAt: true,
    },
  },
  messages: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    select: {
      id: true,
      visibility: true,
      authorType: true,
      authorUserId: true,
      authorIdentityId: true,
      authorName: true,
      authorEmail: true,
      body: true,
      emailOutboxId: true,
      createdAt: true,
    },
  },
} satisfies Prisma.SupportTicketInclude;

type TicketSummaryRow = Prisma.SupportTicketGetPayload<{
  include: typeof TICKET_SUMMARY_INCLUDE;
}>;
type CustomerDetailRow = Prisma.SupportTicketGetPayload<{
  include: typeof CUSTOMER_DETAIL_INCLUDE;
}>;
type PlatformDetailRow = Prisma.SupportTicketGetPayload<{
  include: typeof PLATFORM_DETAIL_INCLUDE;
}>;

export class SupportTicketError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SupportTicketError';
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizedSingleLine(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

function requiredText(
  raw: unknown,
  field: string,
  minimum: number,
  maximum: number,
  preserveLines = false,
): string {
  const value = preserveLines ? String(raw ?? '').trim() : normalizedSingleLine(raw);
  const length = codePointLength(value);
  if (length < minimum || length > maximum) {
    throw new SupportTicketError(
      400,
      'INVALID_TICKET_INPUT',
      `${field} must be between ${minimum} and ${maximum} characters`,
    );
  }
  return value;
}

export function canonicalSupportTicketReference(raw: unknown): string {
  const reference = normalizedSingleLine(raw).toUpperCase();
  if (codePointLength(reference) > MAX_REFERENCE_LENGTH || !SUPPORT_REFERENCE_PATTERN.test(reference)) {
    throw new SupportTicketError(
      400,
      'INVALID_TICKET_REFERENCE',
      'Ticket reference must use the SUP-000001 format',
    );
  }
  return reference;
}

function parsePriority(raw: unknown, fallback: SupportTicketPriority = 'NORMAL'): SupportTicketPriority {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const priority = normalizedSingleLine(raw).toUpperCase() as SupportTicketPriority;
  if (!['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(priority)) {
    throw new SupportTicketError(400, 'INVALID_TICKET_PRIORITY', 'Unknown ticket priority');
  }
  return priority;
}

function parseStatus(raw: unknown): SupportTicketStatus {
  const status = normalizedSingleLine(raw).toUpperCase() as SupportTicketStatus;
  if (!['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED'].includes(status)) {
    throw new SupportTicketError(400, 'INVALID_TICKET_STATUS', 'Unknown ticket status');
  }
  return status;
}

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 25;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new SupportTicketError(400, 'INVALID_TICKET_LIMIT', `limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  return limit;
}

function parseCursor(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return requiredText(raw, 'cursor', 1, 100);
}

function ticketSummary(row: TicketSummaryRow) {
  return {
    id: row.id,
    reference: row.reference,
    organization: row.organization,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    requester: {
      userId: row.requesterUserId,
      name: row.requesterName,
      email: row.requesterEmail,
    },
    assignee: row.assignee,
    messageCount: row._count.messages,
    diagnosticSnapshotVersion: row.diagnosticSnapshotVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function customerDetail(row: CustomerDetailRow) {
  return {
    id: row.id,
    reference: row.reference,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    assigned: row.assignee !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages: row.messages.map((message) => ({
      ...message,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

function platformDetail(row: PlatformDetailRow) {
  return {
    id: row.id,
    reference: row.reference,
    organization: row.organization,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    requester: {
      userId: row.requesterUserId,
      name: row.requesterName,
      email: row.requesterEmail,
    },
    assignee: row.assignee,
    diagnosticSnapshotVersion: row.diagnosticSnapshotVersion,
    diagnosticSnapshot: row.diagnosticSnapshot,
    contentAccessVersion: row.contentAccessVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages: row.messages.map((message) => ({
      id: message.id,
      visibility: message.visibility,
      authorType: message.authorType,
      authorUserId: message.authorUserId,
      authorIdentityId: message.authorIdentityId,
      authorName: message.authorName,
      authorEmail: message.authorEmail,
      body: message.body,
      mailState: message.emailOutboxId ? 'queued' as const : null,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}

async function allocateReference(tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ value: bigint }>>`
    SELECT nextval('"SupportTicket_reference_seq"') AS value
  `;
  const value = rows[0]?.value;
  if (value === undefined) throw new Error('Support ticket reference sequence returned no value');
  return `SUP-${value.toString().padStart(6, '0')}`;
}

async function readRequester(userId: string) {
  const requester = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      isActive: true,
      identity: { select: { email: true } },
    },
  });
  if (!requester || !requester.isActive) {
    throw new SupportTicketError(403, 'TICKET_REQUESTER_UNAVAILABLE', 'Active customer account required');
  }
  return {
    id: requester.id,
    name: requester.name,
    email: requester.identity.email,
  };
}

function jsonSnapshot(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function createCustomerTicket(input: {
  organizationId: string;
  userId: string;
  subject: unknown;
  message: unknown;
  priority?: unknown;
}) {
  const subject = requiredText(input.subject, 'subject', 4, 160);
  const body = requiredText(input.message, 'message', 1, 10000, true);
  const priority = parsePriority(input.priority);
  const [requester, diagnostics] = await Promise.all([
    readRequester(input.userId),
    getSubscriberDiagnostics(input.organizationId),
  ]);
  if (!diagnostics) {
    throw new SupportTicketError(404, 'TICKET_ORGANIZATION_NOT_FOUND', 'Organization not found');
  }
  const diagnosticSnapshot = jsonSnapshot(diagnostics);

  const row = await prisma.$transaction(async (tx) => {
    const reference = await allocateReference(tx);
    const ticket = await tx.supportTicket.create({
      data: {
        reference,
        organizationId: input.organizationId,
        subject,
        priority,
        requesterUserId: requester.id,
        requesterName: requester.name,
        requesterEmail: requester.email,
        diagnosticSnapshotVersion: SUPPORT_DIAGNOSTIC_SNAPSHOT_VERSION,
        diagnosticSnapshot,
      },
      select: { id: true },
    });
    await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        organizationId: input.organizationId,
        visibility: 'PUBLIC',
        authorType: 'CUSTOMER',
        authorUserId: requester.id,
        authorName: requester.name,
        authorEmail: requester.email,
        body,
      },
    });
    return tx.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: CUSTOMER_DETAIL_INCLUDE,
    });
  });
  return customerDetail(row);
}

export async function listCustomerTickets(input: { limit?: unknown; cursor?: unknown }) {
  const limit = parseLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const rows = await prisma.supportTicket.findMany({
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: TICKET_SUMMARY_INCLUDE,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    tickets: page.map(ticketSummary),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

export async function getCustomerTicket(rawReference: unknown) {
  const reference = canonicalSupportTicketReference(rawReference);
  const row = await prisma.supportTicket.findUnique({
    where: { reference },
    include: CUSTOMER_DETAIL_INCLUDE,
  });
  return row ? customerDetail(row) : null;
}

export async function addCustomerTicketReply(input: {
  reference: unknown;
  userId: string;
  message: unknown;
}) {
  const reference = canonicalSupportTicketReference(input.reference);
  const body = requiredText(input.message, 'message', 1, 10000, true);
  const requester = await readRequester(input.userId);

  const row = await prisma.$transaction(async (tx) => {
    const ticket = await tx.supportTicket.findUnique({
      where: { reference },
      select: { id: true, organizationId: true, status: true },
    });
    if (!ticket) throw new SupportTicketError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
    if (!ACTIVE_SUPPORT_TICKET_STATUSES.includes(ticket.status)) {
      throw new SupportTicketError(409, 'TICKET_CLOSED', 'Closed tickets cannot receive replies');
    }

    await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        visibility: 'PUBLIC',
        authorType: 'CUSTOMER',
        authorUserId: requester.id,
        authorName: requester.name,
        authorEmail: requester.email,
        body,
      },
    });
    return tx.supportTicket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
      include: CUSTOMER_DETAIL_INCLUDE,
    });
  });
  return customerDetail(row);
}

export type PlatformTicketActor = {
  id: string;
  email: string;
};

export async function listPlatformTickets(input: {
  limit?: unknown;
  cursor?: unknown;
  status?: unknown;
  priority?: unknown;
  organizationId?: unknown;
  assigneeIdentityId?: unknown;
  q?: unknown;
}) {
  const limit = parseLimit(input.limit);
  const cursor = parseCursor(input.cursor);
  const status = input.status ? parseStatus(input.status) : null;
  const priority = input.priority ? parsePriority(input.priority) : null;
  const organizationId = input.organizationId
    ? requiredText(input.organizationId, 'organizationId', 1, 100)
    : null;
  const assigneeInput = input.assigneeIdentityId
    ? requiredText(input.assigneeIdentityId, 'assigneeIdentityId', 1, 100)
    : null;
  const query = input.q ? requiredText(input.q, 'q', 2, 80) : null;

  const rows = await prisma.supportTicket.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(organizationId ? { organizationId } : {}),
      ...(assigneeInput === 'unassigned'
        ? { assigneeIdentityId: null }
        : assigneeInput
          ? { assigneeIdentityId: assigneeInput }
          : {}),
      ...(query
        ? {
            OR: [
              { reference: { contains: query.toUpperCase() } },
              { subject: { contains: query, mode: 'insensitive' as const } },
              { requesterName: { contains: query, mode: 'insensitive' as const } },
              { requesterEmail: { contains: query, mode: 'insensitive' as const } },
              { organization: { name: { contains: query, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: TICKET_SUMMARY_INCLUDE,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    tickets: page.map(ticketSummary),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

export async function getPlatformTicket(rawReference: unknown) {
  const reference = canonicalSupportTicketReference(rawReference);
  const row = await prisma.supportTicket.findUnique({
    where: { reference },
    include: PLATFORM_DETAIL_INCLUDE,
  });
  return row ? platformDetail(row) : null;
}

type TicketReader = Pick<Prisma.TransactionClient, 'supportTicket'>;

export async function requireActiveSupportTicket(
  rawReference: unknown,
  organizationId: string,
  reader: TicketReader = prisma,
) {
  const reference = canonicalSupportTicketReference(rawReference);
  const ticket = await reader.supportTicket.findFirst({
    where: {
      reference,
      organizationId,
      status: { in: ACTIVE_SUPPORT_TICKET_STATUSES },
    },
    select: {
      id: true,
      reference: true,
      organizationId: true,
      status: true,
      contentAccessVersion: true,
    },
  });
  if (!ticket) {
    throw new SupportTicketError(
      403,
      'ACTIVE_TICKET_REQUIRED',
      'An active support ticket for this subscriber is required',
    );
  }
  return ticket;
}

async function requiredPlatformTicket(tx: Prisma.TransactionClient, rawReference: unknown) {
  const reference = canonicalSupportTicketReference(rawReference);
  const ticket = await tx.supportTicket.findUnique({
    where: { reference },
    include: TICKET_SUMMARY_INCLUDE,
  });
  if (!ticket) throw new SupportTicketError(404, 'TICKET_NOT_FOUND', 'Ticket not found');
  return ticket;
}

function auditTicketAction(
  tx: Prisma.TransactionClient,
  actor: PlatformTicketActor,
  ticket: TicketSummaryRow,
  input: {
    action: string;
    reason: string;
    beforeState?: unknown;
    afterState?: unknown;
    ipAddress?: string;
  },
) {
  return auditPlatformScope(input.reason, {
    action: input.action,
    actorIdentityId: actor.id,
    actorEmail: actor.email,
    targetOrgId: ticket.organizationId,
    targetOrgName: ticket.organization.name,
    supportTicketId: ticket.id,
    ticketReference: ticket.reference,
    ticketAccessVersion: ticket.contentAccessVersion,
    beforeState: input.beforeState,
    afterState: input.afterState,
    ipAddress: input.ipAddress,
  }, tx);
}

export async function addPlatformTicketMessage(input: {
  reference: unknown;
  visibility: SupportTicketMessageVisibility;
  message: unknown;
  actor: PlatformTicketActor;
  ipAddress?: string;
}) {
  const body = requiredText(input.message, 'message', 1, 10000, true);

  return prisma.$transaction(async (tx) => {
    const ticket = await requiredPlatformTicket(tx, input.reference);
    if (!ACTIVE_SUPPORT_TICKET_STATUSES.includes(ticket.status)) {
      throw new SupportTicketError(409, 'TICKET_CLOSED', 'Closed tickets cannot receive messages');
    }

    const messageId = crypto.randomUUID();
    let emailOutboxId: string | null = null;
    if (input.visibility === 'PUBLIC') {
      const outbox = await tx.emailOutbox.create({
        data: {
          organizationId: ticket.organizationId,
          toEmail: ticket.requesterEmail,
          kind: 'support.ticket.public-reply',
          subject: `[${ticket.reference}] ${ticket.subject}`,
          body,
          dedupeKey: `support-ticket-message:${messageId}`,
        },
        select: { id: true },
      });
      emailOutboxId = outbox.id;
    }

    const message = await tx.supportTicketMessage.create({
      data: {
        id: messageId,
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        visibility: input.visibility,
        authorType: 'PLATFORM',
        authorIdentityId: input.actor.id,
        authorName: input.visibility === 'PUBLIC' ? 'RabiTech Support' : input.actor.email,
        authorEmail: input.visibility === 'PUBLIC' ? null : input.actor.email,
        body,
        emailOutboxId,
      },
      select: {
        id: true,
        visibility: true,
        authorType: true,
        authorIdentityId: true,
        authorName: true,
        authorEmail: true,
        body: true,
        emailOutboxId: true,
        createdAt: true,
      },
    });
    const updated = await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { updatedAt: new Date() },
      include: TICKET_SUMMARY_INCLUDE,
    });

    await auditTicketAction(tx, input.actor, updated, {
      action: input.visibility === 'PUBLIC'
        ? 'platform.support-ticket.public-reply.queued'
        : 'platform.support-ticket.internal-note.created',
      reason: input.visibility === 'PUBLIC'
        ? `Public reply queued for ${ticket.reference}`
        : `Internal note recorded for ${ticket.reference}`,
      afterState: {
        messageId: message.id,
        visibility: message.visibility,
        mailState: emailOutboxId ? 'queued' : null,
      },
      ipAddress: input.ipAddress,
    });

    const { emailOutboxId: _emailOutboxId, ...publicMessage } = message;
    return {
      ticket: ticketSummary(updated),
      message: {
        ...publicMessage,
        mailState: emailOutboxId ? 'queued' as const : null,
        createdAt: message.createdAt.toISOString(),
      },
    };
  });
}

export async function setPlatformTicketStatus(input: {
  reference: unknown;
  status: unknown;
  actor: PlatformTicketActor;
  ipAddress?: string;
}) {
  const status = parseStatus(input.status);
  return prisma.$transaction(async (tx) => {
    const before = await requiredPlatformTicket(tx, input.reference);
    if (before.status === status) return ticketSummary(before);
    const after = await tx.supportTicket.update({
      where: { id: before.id },
      data: { status },
      include: TICKET_SUMMARY_INCLUDE,
    });
    await auditTicketAction(tx, input.actor, after, {
      action: 'platform.support-ticket.status.changed',
      reason: `${after.reference} status changed from ${before.status} to ${after.status}`,
      beforeState: { status: before.status, contentAccessVersion: before.contentAccessVersion },
      afterState: { status: after.status, contentAccessVersion: after.contentAccessVersion },
      ipAddress: input.ipAddress,
    });
    return ticketSummary(after);
  });
}

export async function setPlatformTicketPriority(input: {
  reference: unknown;
  priority: unknown;
  actor: PlatformTicketActor;
  ipAddress?: string;
}) {
  const priority = parsePriority(input.priority);
  return prisma.$transaction(async (tx) => {
    const before = await requiredPlatformTicket(tx, input.reference);
    if (before.priority === priority) return ticketSummary(before);
    const after = await tx.supportTicket.update({
      where: { id: before.id },
      data: { priority },
      include: TICKET_SUMMARY_INCLUDE,
    });
    await auditTicketAction(tx, input.actor, after, {
      action: 'platform.support-ticket.priority.changed',
      reason: `${after.reference} priority changed from ${before.priority} to ${after.priority}`,
      beforeState: { priority: before.priority },
      afterState: { priority: after.priority },
      ipAddress: input.ipAddress,
    });
    return ticketSummary(after);
  });
}

export async function setPlatformTicketAssignee(input: {
  reference: unknown;
  assigneeIdentityId: unknown;
  actor: PlatformTicketActor;
  ipAddress?: string;
}) {
  const assigneeIdentityId = input.assigneeIdentityId === null || input.assigneeIdentityId === ''
    ? null
    : requiredText(input.assigneeIdentityId, 'assigneeIdentityId', 1, 100);

  return prisma.$transaction(async (tx) => {
    const before = await requiredPlatformTicket(tx, input.reference);
    if (assigneeIdentityId) {
      const assignee = await tx.identity.findUnique({
        where: { id: assigneeIdentityId },
        select: { platformRole: true, platformDisabledAt: true },
      });
      if (!assignee || !['OWNER', 'SUPPORT'].includes(assignee.platformRole) || assignee.platformDisabledAt) {
        throw new SupportTicketError(400, 'INVALID_TICKET_ASSIGNEE', 'Assignee must be active platform staff');
      }
    }
    if (before.assigneeIdentityId === assigneeIdentityId) return ticketSummary(before);

    const after = await tx.supportTicket.update({
      where: { id: before.id },
      data: { assigneeIdentityId },
      include: TICKET_SUMMARY_INCLUDE,
    });
    await auditTicketAction(tx, input.actor, after, {
      action: 'platform.support-ticket.assignment.changed',
      reason: assigneeIdentityId
        ? `${after.reference} assigned to platform staff`
        : `${after.reference} returned to the unassigned queue`,
      beforeState: { assigneeIdentityId: before.assigneeIdentityId },
      afterState: { assigneeIdentityId: after.assigneeIdentityId },
      ipAddress: input.ipAddress,
    });
    return ticketSummary(after);
  });
}
