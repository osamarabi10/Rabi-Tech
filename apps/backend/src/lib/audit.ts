import { prisma } from '../prisma';
import logger from './logger';
import { getTenantId } from './tenant-context';

export interface AuditOptions {
  userId?: string;
  action: string; // e.g., "conversation.opened", "ticket.created"
  resource: string; // e.g., "conversation", "ticket"
  resourceId: string;
  changes?: { before?: any; after?: any };
  description?: string;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Details for a platform-owner action, beyond the bare scope-entry record.
 *
 * Every field is optional: this function is called on *every* platform-scope
 * entry with nothing but a reason, and those callers must keep working.
 */
export interface PlatformAuditDetail {
  /** Dotted action name, e.g. "platform.commercials.updated". */
  action?: string;
  /** Identity.id — a platform owner has no User row in the target org. */
  actorIdentityId?: string;
  actorEmail?: string;
  /** The organization acted on, plus a name snapshot that outlives it. */
  targetOrgId?: string;
  targetOrgName?: string;
  /**
   * The edition acted on, for catalogue changes.
   *
   * Separate from targetOrgId rather than reusing it: a catalogue change acts
   * on the offer, not on a subscriber, and borrowing the per-org column would
   * make that trail claim a workspace was touched when none was.
   */
  targetEditionCode?: string;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string;
}

/**
 * Durable, fail-closed record written before any platform-scope operation.
 *
 * Deliberately **not** wrapped in try/catch, unlike auditLog() below: a
 * commercial exception that exists with no record of who granted it or why is
 * exactly what this table is for. If the audit write fails, the action must
 * fail with it.
 */
export async function auditPlatformScope(
  reason: string,
  detail: PlatformAuditDetail = {},
): Promise<void> {
  await prisma.platformAuditLog.create({
    data: {
      reason,
      action: detail.action,
      actorIdentityId: detail.actorIdentityId,
      actorEmail: detail.actorEmail,
      targetOrgId: detail.targetOrgId,
      targetOrgName: detail.targetOrgName,
      targetEditionCode: detail.targetEditionCode,
      beforeState: (detail.beforeState ?? undefined) as never,
      afterState: (detail.afterState ?? undefined) as never,
      ipAddress: detail.ipAddress,
    },
  });
}

/**
 * Log an action to the audit log. Errors are logged but don't throw.
 */
export async function auditLog(opts: AuditOptions): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        organizationId: getTenantId(),
        userId: opts.userId,
        action: opts.action,
        resource: opts.resource,
        resourceId: opts.resourceId,
        changes: opts.changes ? (opts.changes as any) : undefined,
        description: opts.description,
        ipAddress: opts.ipAddress,
        userAgent: opts.userAgent,
      },
    });

  } catch (err) {
    logger.error('Failed to write audit log', { error: String(err), opts });
  }
}

/**
 * Audit conversation state change (opened, assigned, closed, etc.).
 */
export async function auditConversation(
  userId: string | undefined,
  conversationId: string,
  action:
    | 'opened'
    | 'assigned'
    | 'resolved'
    | 'reopened'
    | 'pending'
    | 'updated'
    // A resend of a message that failed. Worth its own entry: it is the one
    // conversation action that can put the same text in front of a customer
    // twice, so "who pressed retry, and when" has to be answerable.
    | 'message-retried'
    // Snoozing hides a thread from the queue. Worth a trail: "nobody has
    // looked at this" and "somebody decided it waits until Tuesday" look the
    // same from outside.
    | 'snoozed'
    | 'unsnoozed'
    // Who else can act on this thread, and who let them. Worth a trail for the
    // same reason assignment is: a collaborator can do everything the assignee
    // can, so "how did this person get access to my conversation" has to be
    // answerable after the fact.
    | 'collaborator-added'
    | 'collaborator-removed',
  ipAddress?: string,
  userAgent?: string
) {
  return auditLog({
    userId,
    action: `conversation.${action}`,
    resource: 'conversation',
    resourceId: conversationId,
    ipAddress,
    userAgent,
  });
}

/**
 * Audit message actions (sent, deleted).
 */
export async function auditMessage(
  userId: string | undefined,
  messageId: string,
  action: 'sent' | 'deleted',
  conversationId: string,
  ipAddress?: string,
  userAgent?: string
) {
  return auditLog({
    userId,
    action: `message.${action}`,
    resource: 'message',
    resourceId: messageId,
    description: `In conversation ${conversationId}`,
    ipAddress,
    userAgent,
  });
}

/**
 * Audit contact modifications.
 */
export async function auditContact(
  userId: string | undefined,
  contactId: string,
  action: 'created' | 'updated' | 'archived',
  before?: any,
  after?: any,
  ipAddress?: string,
  userAgent?: string
) {
  return auditLog({
    userId,
    action: `contact.${action}`,
    resource: 'contact',
    resourceId: contactId,
    changes: { before, after },
    ipAddress,
    userAgent,
  });
}
