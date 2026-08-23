import { Request, Response, NextFunction } from 'express';
import { Role } from '@prisma/client';
import logger from '../lib/logger';

/**
 * Role-based access control matrix.
 * Maps operations to which roles are allowed.
 */
const ROLE_PERMISSIONS: Record<string, Set<Role>> = {
  // Conversation operations
  'conversation:resolve': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
  'conversation:assign': new Set(['ADMIN', 'SUPERVISOR']),
  'conversation:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
  'conversation:read': new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),

  // Ticket operations
  'ticket:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
  'ticket:update': new Set(['ADMIN', 'SUPERVISOR']),
  'ticket:resolve': new Set(['ADMIN', 'SUPERVISOR']),
  'ticket:read': new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),

  // Contact operations
  'contact:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
  'contact:update': new Set(['ADMIN', 'SUPERVISOR']),
  'contact:delete': new Set(['ADMIN']),
  'contact:read': new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),

  // Segments — saved contact filters. Org-wide once saved, so renaming and
  // deleting sit above the role that can create one: an agent must not be able
  // to delete a view the whole team relies on. Unlike contact:delete this is not
  // ADMIN-only, because deletion here is soft and reversible.
  'segment:view': new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),
  'segment:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
  'segment:rename': new Set(['ADMIN', 'SUPERVISOR']),
  'segment:delete': new Set(['ADMIN', 'SUPERVISOR']),
  // Saved views follow the same reasoning one step further. Anyone who can
  // read conversations may keep their own private views — they are a personal
  // arrangement of an inbox that agent already sees. Putting a view in front
  // of the whole workspace, or editing one that is already there, is a
  // different act: an agent must not rename or delete a view four colleagues
  // start their day in.
  'inbox-view:manage-shared': new Set(['ADMIN', 'SUPERVISOR']),
  // Automations act on customers without a human in the loop, so authoring one
  // sits with admins and supervisors while everyone who can read conversations
  // can see what fired and why.
  'workflow:view': new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),
  'workflow:manage': new Set(['ADMIN', 'SUPERVISOR']),

  // Campaign operations
  'campaign:create': new Set(['ADMIN', 'SUPERVISOR']),
  'campaign:send': new Set(['ADMIN', 'SUPERVISOR']),
  'campaign:read': new Set(['ADMIN', 'SUPERVISOR', 'FINANCE']),

  // Reporting/Analytics
  'analytics:read': new Set(['ADMIN', 'SUPERVISOR', 'FINANCE']),
  'audit-log:read': new Set(['ADMIN']),

  // User management
  'user:create': new Set(['ADMIN']),
  'user:update': new Set(['ADMIN']),
  'user:delete': new Set(['ADMIN']),
  'user:list': new Set(['ADMIN']),

  // System
  'system:config': new Set(['ADMIN']),
};

/**
 * Middleware to check if user has permission for an operation.
 * Usage: `app.post('/endpoint', requirePermission('conversation:resolve'), handler)`
 */
/**
 * Every operation a role is allowed, derived from the matrix above.
 *
 * For the client, which needs to know what to *offer* — a navigation entry
 * to a page the caller can never load is a dead end, and asking the user to
 * discover that by clicking it is poor manners.
 *
 * Derived rather than duplicated. A second copy of this matrix on the
 * frontend would drift the first time somebody grants a role one more
 * operation here and forgets the other file, and the failure would be silent
 * in the direction that matters: a page offered to someone the server then
 * refuses.
 *
 * This is a display aid and nothing more. Every route still calls
 * requirePermission; hiding a link has never been access control.
 */
export function permissionsForRole(role: string): string[] {
  return Object.entries(ROLE_PERMISSIONS)
    .filter(([, roles]) => roles.has(role as Role))
    .map(([operation]) => operation)
    .sort();
}

/**
 * Whether a role holds an operation, without the middleware wrapper.
 *
 * A few routes decide the permission from the request body rather than the
 * path: creating a *private* saved view is something every agent may do, and
 * creating a *shared* one is not, on the same endpoint. Those checks still go
 * through this table rather than comparing role strings inline — which is the
 * thing the table exists to stop.
 */
export function hasPermission(role: string | undefined, operation: string): boolean {
  // Fail closed on both halves: a request with no role, and an operation not
  // in the table, are both "no" rather than a crash or an accidental yes.
  if (!role) return false;
  return ROLE_PERMISSIONS[operation]?.has(role as Role) ?? false;
}

export function requirePermission(operation: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) {
      logger.warn('Permission check: no user', { operation, requestId: (req as any).id });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const allowedRoles = ROLE_PERMISSIONS[operation];
    if (!allowedRoles) {
      logger.warn('Permission check: unknown operation', { operation, requestId: (req as any).id });
      return res.status(500).json({ error: 'Invalid operation' });
    }

    if (!allowedRoles.has(user.role as Role)) {
      logger.warn('Permission denied', {
        operation,
        userRole: user.role,
        userId: user.id,
        requestId: (req as any).id,
      });
      return res.status(403).json({
        error: 'لا توجد صلاحية لهذه العملية',
        operation,
        requestId: (req as any).id,
      });
    }

    next();
  };
}

/**
 * Check if user is admin.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user || (user.role as Role) !== 'ADMIN') {
    logger.warn('Admin check failed', { userId: user?.id, role: user?.role, requestId: (req as any).id });
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Check if user is supervisor or admin.
 */
export function requireSupervisor(req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  const role = user?.role as Role;
  if (!user || !['ADMIN', 'SUPERVISOR'].includes(role)) {
    logger.warn('Supervisor check failed', { userId: user?.id, role: user?.role, requestId: (req as any).id });
    return res.status(403).json({ error: 'Supervisor access required' });
  }
  next();
}
