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
  'contact:export': new Set(['ADMIN', 'SUPERVISOR']),

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
  'user:create': new Set(['ADMIN', 'SUPERVISOR']),
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
 * Per-user restrictions, as data rather than as a growing chain of `if`s.
 *
 * A role says what a *kind* of person may do. A restriction narrows one
 * individual below their role — "this supervisor may not export contacts" —
 * without inventing a sixth role for every combination somebody asks for.
 *
 * Each entry maps a flag to the operations it withdraws. Adding a restriction
 * is a row here plus a column; it is deliberately not a new branch in the
 * middleware, because the previous shape (`if (operation.startsWith('workflow:')
 * && user.restrictWorkflows)`) does not survive four more of itself — and the
 * fourth copy is where one of them gets the check backwards.
 *
 * **Exact operation names, not prefixes.** A prefix would silently capture
 * operations added later, and — worse — a prefix that matches nothing looks
 * identical to one that works. Naming each operation means a restriction that
 * gates nothing is visible here as an empty list rather than as a checkbox
 * nobody has tested.
 */
const USER_RESTRICTIONS = [
  { flag: 'restrictWorkflows', operations: ['workflow:manage', 'workflow:view'], code: 'USER_WORKFLOW_RESTRICTED', message: 'Workflow access is restricted for this user' },
  { flag: 'restrictDataExport', operations: ['contact:export'], code: 'USER_EXPORT_RESTRICTED', message: 'Exporting data is restricted for this user' },
  { flag: 'restrictContactDeletion', operations: ['contact:delete'], code: 'USER_CONTACT_DELETE_RESTRICTED', message: 'Deleting contacts is restricted for this user' },
  /*
    Workspace settings is `system:config` plus the four user-management
    operations, because "who is in this workspace" is a workspace setting in
    every product this resembles, and an admin restricted from settings who can
    still create admins has not been restricted from anything.
  */
  { flag: 'restrictWorkspaceSettings', operations: ['system:config', 'user:create', 'user:update', 'user:delete', 'user:list'], code: 'USER_SETTINGS_RESTRICTED', message: 'Workspace settings are restricted for this user' },
] as const;

/*
  Integration settings — channels, gateways, webhooks — has NO restriction here,
  and that is a finding rather than an omission.

  There is no `channel:`, `webhook:` or `integration:` operation in the table
  above. Those routes guard with `requireAdmin` directly rather than through
  `requirePermission`, so a restriction keyed on an operation name would match
  nothing and gate nothing — declared and unenforced, which is the exact shape
  this codebase has now hit four times (autoProvisionGateway, allowedChannels on
  the QR path, the Keyword model, and very nearly this).

  Shipping `restrictIntegrationSettings` as a column and a checkbox that quietly
  did nothing would have been worse than not shipping it. Closing it properly
  means moving those routes onto named operations first, which is its own piece
  of work and is recorded in TODO.md rather than half-done here.
*/

export type UserRestrictions = Partial<Record<(typeof USER_RESTRICTIONS)[number]['flag'], boolean>>;

/** The first restriction that withdraws this operation, or null. */
function restrictionFor(operation: string, restrictions: UserRestrictions | undefined) {
  if (!restrictions) return null;
  return USER_RESTRICTIONS.find(
    (rule) => restrictions[rule.flag] && (rule.operations as readonly string[]).includes(operation),
  ) ?? null;
}

/**
 * What this user may actually do, role minus their own restrictions.
 *
 * Returned by `/auth/me` and used by the sidebar, so a restricted user is not
 * offered a destination that will refuse them. The server enforces the same
 * table, so the two cannot disagree — a mirrored list on the client would drift
 * the first time a restriction gained a prefix, and it would drift toward
 * offering more than the server allows.
 */
export function permissionsForUser(
  role: string,
  restrictions?: UserRestrictions,
): string[] {
  return permissionsForRole(role).filter((permission) => !restrictionFor(permission, restrictions));
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


    /*
      Restrictions are checked after the role, and the order matters.

      A user who lacks the permission entirely gets the plain 403; only somebody
      whose *role* grants it and whose *restriction* withdraws it sees the
      restriction message. Checking restrictions first would tell an agent that
      "exporting is restricted for this user" when the truth is that no agent
      may export at all — a message that sends them to an admin to have a
      restriction lifted that was never applied.
    */
    const restriction = restrictionFor(operation, user as UserRestrictions);
    if (restriction) {
      logger.warn('Permission denied by user restriction', {
        operation,
        restriction: restriction.flag,
        userId: user.id,
        requestId: (req as any).id,
      });
      return res.status(403).json({
        error: restriction.message,
        code: restriction.code,
        operation,
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
