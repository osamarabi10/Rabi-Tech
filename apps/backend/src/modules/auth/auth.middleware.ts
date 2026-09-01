import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';

export interface JwtPayload {
  scope?: 'ORGANIZATION';
  id: string;
  email: string;
  primaryTeamId?: string | null;
  teamIds?: string[];
  name: string;
  role?: 'ADMIN' | 'SUPERVISOR' | 'AGENT' | 'VIEWER' | 'FINANCE';
  organizationId: string;
  tokenVersion?: number;
  sessionId?: string;
  restrictContactVisibility?: boolean;
  contactVisibilityScope?: 'TEAM' | 'SELF';
  restrictCalls?: boolean;
  restrictWorkflows?: boolean;
  restrictDataExport?: boolean;
  restrictContactDeletion?: boolean;
  restrictWorkspaceSettings?: boolean;
  maskPhoneAndEmail?: boolean;
}

export interface PlatformJwtPayload {
  scope: 'PLATFORM';
  id: string;
  email: string;
  platformRole: 'OWNER' | 'SUPPORT';
  /**
   * What a SUPPORT advisor may do.
   *
   * Read from the database on every request rather than trusted from the
   * token: revoking a permission has to take effect now, not when a
   * seven-day token happens to expire. The field on the payload is
   * informational — `verifyPlatformToken` overwrites it with the stored
   * value before any handler sees it.
   */
  platformPermissions?: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
      platformUser?: PlatformJwtPayload;
    }
  }
}

/** Header a platform user sets to read one subscriber's data. */
export const VIEW_AS_ORG_HEADER = 'x-organization-id';

/**
 * Lets the RabiTech platform owner read a subscriber's tenant data.
 *
 * Deliberately read-only. The owner is not a member of the tenant, so any write
 * would land in the subscriber's workspace under a synthetic identity — and a
 * mutation on a messaging product can reach that subscriber's own customers over
 * WhatsApp. Viewing is what the console needs; acting stays with the tenant.
 *
 * Access is opt-in per request (the header must be present), so the owner is
 * never silently operating inside someone else's org, and every entry is
 * audited against the subscriber being viewed.
 */
async function handlePlatformViewingTenant(
  decoded: PlatformJwtPayload,
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const targetOrgId = String(req.headers[VIEW_AS_ORG_HEADER] || '').trim();
  if (!targetOrgId) {
    return res.status(403).json({
      error: 'Organization access required',
      hint: `Platform users must name the subscriber to view via the ${VIEW_AS_ORG_HEADER} header.`,
    });
  }

  if (!['OWNER', 'SUPPORT'].includes(decoded.platformRole)) {
    return res.status(403).json({ error: 'Platform access required' });
  }

  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({
      error: 'العرض كمشترك للقراءة فقط',
      detail: 'Platform users can view subscriber data but cannot modify it. Ask an admin in that organization to make the change.',
    });
  }

  const org = await runAsPlatform(`view-as-tenant:${targetOrgId}`, () =>
    prisma.organization.findUnique({
      where: { id: targetOrgId },
      select: { id: true, name: true, status: true },
    })
  );
  if (!org) return res.status(404).json({ error: 'Subscriber not found' });
  if (org.status === 'SUSPENDED') return res.status(403).json({ error: 'Subscriber is suspended' });

  return runAsOrganization(org.id, async () => {
    const { auditLog } = await import('../../lib/audit');
    await auditLog({
      action: 'PLATFORM_VIEW',
      resource: 'organization',
      resourceId: org.id,
      description: `${decoded.email} (${decoded.platformRole}) viewed ${req.method} ${req.originalUrl}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Synthetic membership: never persisted as a real User row. ADMIN grants the
    // read permissions a support view needs (reports, settings, sessions); the
    // GET/HEAD gate above is what actually prevents writes, not this role.
    req.user = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.email,
      role: 'ADMIN',
      organizationId: org.id,
    };
    req.platformUser = decoded;
    next();
  });
}

export async function verifyToken(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload | PlatformJwtPayload;

    if (decoded.scope === 'PLATFORM') {
      return handlePlatformViewingTenant(decoded as PlatformJwtPayload, req, res, next);
    }

    if (!decoded.organizationId) {
      return res.status(401).json({ error: 'Invalid token: missing organizationId' });
    }

    return runAsOrganization(decoded.organizationId, async () => {
      const session = decoded.sessionId
        ? await prisma.authSession.findUnique({
            where: { id: decoded.sessionId },
            select: {
              userId: true,
              lastSeenAt: true,
              revokedAt: true,
              user: {
                select: {
                  tokenVersion: true,
                  isActive: true,
                  role: true,
                  primaryTeamId: true,
                  teams: { select: { teamId: true } },
                  restrictContactVisibility: true,
                  contactVisibilityScope: true,
                  restrictCalls: true,
                  restrictWorkflows: true,
                  restrictDataExport: true,
                  restrictContactDeletion: true,
                  restrictWorkspaceSettings: true,
                  maskPhoneAndEmail: true,
                  organization: {
                    select: {
                      configuration: {
                        select: { userInactivityTimeoutMinutes: true },
                      },
                    },
                  },
                },
              },
            },
          })
        : null;

      if (decoded.sessionId && (!session || session.userId !== decoded.id || session.revokedAt)) {
        return res.status(401).json({ error: 'Session is no longer active', code: 'SESSION_REVOKED' });
      }

      // Tokens issued before the session migration remain valid until their
      // normal expiry. Every new login carries a sessionId and is subject to
      // the workspace policy below, avoiding a forced logout at deployment.
      const user = session?.user ?? await prisma.user.findUnique({
        where: { id: decoded.id },
        select: {
          tokenVersion: true,
          isActive: true,
          role: true,
          primaryTeamId: true,
          teams: { select: { teamId: true } },
          restrictContactVisibility: true,
          contactVisibilityScope: true,
          restrictCalls: true,
          restrictWorkflows: true,
          restrictDataExport: true,
          restrictContactDeletion: true,
          restrictWorkspaceSettings: true,
          maskPhoneAndEmail: true,
        },
      });

      if (!user) {
        return res.status(401).json({ error: 'Invalid token user' });
      }
      if (!user.isActive) {
        return res.status(403).json({ error: 'User is inactive' });
      }

      if (
        decoded.tokenVersion !== undefined &&
        user.tokenVersion !== decoded.tokenVersion
      ) {
        return res.status(401).json({ error: 'Token has been revoked' });
      }

      if (session && decoded.sessionId) {
        const timeoutMinutes = session.user.organization.configuration?.userInactivityTimeoutMinutes ?? 20;
        const idleForMs = Date.now() - session.lastSeenAt.getTime();
        if (idleForMs > timeoutMinutes * 60_000) {
          await prisma.authSession.update({
            where: { id: decoded.sessionId },
            data: { revokedAt: new Date() },
          });
          return res.status(401).json({
            error: 'Session expired due to inactivity',
            code: 'SESSION_IDLE_TIMEOUT',
          });
        }

        // One write per minute at most, regardless of request volume.
        if (idleForMs >= 60_000) {
          await prisma.authSession.update({
            where: { id: decoded.sessionId },
            data: { lastSeenAt: new Date() },
          });
        }
      }

      req.user = {
        ...decoded,
        role: user.role,
        primaryTeamId: user.primaryTeamId,
        teamIds: user.teams.map((team) => team.teamId),
        restrictContactVisibility: user.restrictContactVisibility,
        contactVisibilityScope: user.contactVisibilityScope,
        restrictCalls: user.restrictCalls,
        restrictWorkflows: user.restrictWorkflows,
        restrictDataExport: user.restrictDataExport,
        restrictContactDeletion: user.restrictContactDeletion,
        restrictWorkspaceSettings: user.restrictWorkspaceSettings,
        maskPhoneAndEmail: user.maskPhoneAndEmail,
      };
      next();
    });
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export async function verifyPlatformToken(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = auth.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as PlatformJwtPayload;
    if (decoded.scope !== 'PLATFORM' || !decoded.id) {
      return res.status(403).json({ error: 'Platform access required' });
    }

    const identity = await runAsPlatform('verify-platform-token', () =>
      prisma.identity.findUnique({
        where: { id: decoded.id },
        select: {
          id: true,
          email: true,
          platformRole: true,
          platformPermissions: true,
          platformDisabledAt: true,
        },
      })
    );
    if (!identity || !['OWNER', 'SUPPORT'].includes(identity.platformRole)) {
      return res.status(403).json({ error: 'Platform access required' });
    }
    /*
     * A disabled advisor is refused here, not only at login.
     *
     * Tokens last seven days. Switching somebody off at login alone leaves
     * whatever token they are holding working for the rest of the week —
     * which is precisely the week you switched them off for.
     */
    if (identity.platformDisabledAt) {
      return res.status(403).json({ error: 'This staff account is disabled' });
    }

    req.platformUser = {
      scope: 'PLATFORM',
      id: identity.id,
      email: identity.email,
      platformRole: identity.platformRole as 'OWNER' | 'SUPPORT',
      // From the database, never from the token: a revoked permission must
      // stop working immediately.
      platformPermissions: identity.platformPermissions,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
