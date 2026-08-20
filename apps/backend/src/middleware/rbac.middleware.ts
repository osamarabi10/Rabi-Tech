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
