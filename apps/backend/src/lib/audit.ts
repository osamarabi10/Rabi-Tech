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

/** Durable, fail-closed record written before any platform-scope operation. */
export async function auditPlatformScope(reason: string): Promise<void> {
  await prisma.platformAuditLog.create({ data: { reason } });
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
  action: 'opened' | 'assigned' | 'resolved' | 'reopened' | 'pending' | 'updated',
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
