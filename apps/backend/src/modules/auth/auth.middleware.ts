import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { setScopeWorkspaceId, runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import logger from '../../lib/logger';
import { readPlatformViewGrant } from '../../lib/audit';
import { hasPlatformPermission } from '../platform/platform-permissions';
import {
  PLATFORM_VIEW_TOKEN_HEADER,
  parsePlatformViewRequest,
  verifyPlatformViewToken,
} from '../platform/platform-view-access';
import { ACTIVE_SUPPORT_TICKET_STATUSES } from '../support-tickets/support-tickets.service';

export interface JwtPayload {
  scope?: 'ORGANIZATION';
  id: string;
  email: string;
  primaryTeamId?: string | null;
  teamIds?: string[];
  name: string;
  role?: 'ADMIN' | 'SUPERVISOR' | 'AGENT' | 'VIEWER' | 'FINANCE';
  organizationId: string;
  /**
   * The active workspace, and the only thing that selects one.
   *
   * Optional because a token minted before workspaces existed does not carry
   * it, and those sessions must keep working — an unclaimed token falls back to
   * the organization's default workspace, which is where all of its data
   * already is. That fallback is not a hole: it resolves within the token's own
   * organization and cannot name somebody else's workspace.
   */
  workspaceId?: string;
  tokenVersion?: number;
  sessionId?: string;
  restrictContactVisibility?: boolean;
  contactVisibilityScope?: 'TEAM' | 'SELF';
  restrictCalls?: boolean;
  restrictWorkflows?: boolean;
  restrictDataExport?: boolean;
  restrictContactDeletion?: boolean;
  restrictWorkspaceSettings?: boolean;
  restrictIntegrations?: boolean;
  maskPhoneAndEmail?: boolean;
}

export interface PlatformJwtPayload {
  scope: 'PLATFORM';
  id: string;
  email: string;
  platformRole: 'OWNER' | 'SUPPORT';
  /**
   * The exact platform operations a SUPPORT advisor may perform.
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
      platformViewAccess?: {
        organizationId: string;
        auditLogId: string;
        supportTicketId: string;
        ticketReference: string;
        expiresAt: number;
      };
    }
  }
}

/** Header a platform user sets to read one subscriber's data. */
export const VIEW_AS_ORG_HEADER = 'x-organization-id';

const PLATFORM_IDENTITY_SELECT = {
  id: true,
  email: true,
  platformRole: true,
  platformPermissions: true,
  platformDisabledAt: true,
} as const;

async function readCurrentPlatformIdentity(identityId: string, reason: string) {
  return runAsPlatform(reason, () =>
    prisma.identity.findUnique({
      where: { id: identityId },
      select: PLATFORM_IDENTITY_SELECT,
    })
  );
}

function platformUserFrom(identity: NonNullable<Awaited<ReturnType<typeof readCurrentPlatformIdentity>>>): PlatformJwtPayload {
  return {
    scope: 'PLATFORM',
    id: identity.id,
    email: identity.email,
    platformRole: identity.platformRole as 'OWNER' | 'SUPPORT',
    platformPermissions: identity.platformPermissions,
  };
}

/**
 * Lets an explicitly authorised platform identity read subscriber tenant data.
 *
 * Deliberately read-only. The owner is not a member of the tenant, so any write
 * would land in the subscriber's workspace under a synthetic identity — and a
 * mutation on a messaging product can reach that subscriber's own customers over
 * WhatsApp. Viewing is what the console needs; acting stays with the tenant.
 *
 * A signed grant proves that a detailed PlatformAuditLog row was durably
 * written before entry. The grant expires after 15 minutes. Re-entering or
 * renewing obtains another grant and therefore another audit row.
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

  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(403).json({
      error: 'العرض كمشترك للقراءة فقط',
      detail: 'Platform users can view subscriber data but cannot modify it. Ask an admin in that organization to make the change.',
    });
  }

  const encodedGrant = String(req.headers[PLATFORM_VIEW_TOKEN_HEADER] || '').trim();
  if (!encodedGrant) {
    return res.status(403).json({
      error: 'Timed platform view access is required',
      code: 'PLATFORM_VIEW_REQUIRED',
    });
  }

  let grant;
  try {
    grant = verifyPlatformViewToken(encodedGrant);
  } catch (error) {
    const expired = error instanceof jwt.TokenExpiredError;
    return res.status(403).json({
      error: expired ? 'Platform view access expired' : 'Invalid platform view access',
      code: expired ? 'PLATFORM_VIEW_EXPIRED' : 'PLATFORM_VIEW_INVALID',
    });
  }

  if (grant.actorIdentityId !== decoded.id || grant.organizationId !== targetOrgId) {
    return res.status(403).json({ error: 'Platform view access does not match this request', code: 'PLATFORM_VIEW_INVALID' });
  }

  let state;
  try {
    state = await runAsPlatform(`verify-view-as:${decoded.id}:${targetOrgId}`, async () => {
      const [identity, org, audit, ticket] = await Promise.all([
        prisma.identity.findUnique({ where: { id: decoded.id }, select: PLATFORM_IDENTITY_SELECT }),
        prisma.organization.findUnique({
          where: { id: targetOrgId },
          select: { id: true, name: true, status: true },
        }),
        readPlatformViewGrant({
          auditLogId: grant.auditLogId,
          actorIdentityId: decoded.id,
          targetOrgId,
          supportTicketId: grant.supportTicketId,
        }),
        prisma.supportTicket.findFirst({
          where: {
            id: grant.supportTicketId,
            organizationId: targetOrgId,
            status: { in: ACTIVE_SUPPORT_TICKET_STATUSES },
            contentAccessVersion: grant.ticketAccessVersion,
          },
          select: {
            id: true,
            reference: true,
            contentAccessVersion: true,
          },
        }),
      ]);
      return { identity, org, audit, ticket };
    });
  } catch (error) {
    logger.error('Platform view authorization could not verify its durable audit', {
      error: String(error),
      actorIdentityId: decoded.id,
      targetOrgId,
    });
    return res.status(503).json({ error: 'Platform audit is unavailable', code: 'PLATFORM_AUDIT_UNAVAILABLE' });
  }

  const { identity, org, audit, ticket } = state;
  if (!identity || !['OWNER', 'SUPPORT'].includes(identity.platformRole)) {
    return res.status(403).json({ error: 'Platform access required' });
  }
  if (identity.platformDisabledAt) {
    return res.status(403).json({ error: 'This staff account is disabled' });
  }
  const platformUser = platformUserFrom(identity);
  for (const permission of ['subscriber:view-as', 'subscriber:content:read'] as const) {
    if (!hasPlatformPermission(platformUser, permission)) {
      return res.status(403).json({ error: 'This action is not part of your access', permission });
    }
  }

  if (!org) return res.status(404).json({ error: 'Subscriber not found' });
  if (org.status === 'SUSPENDED') return res.status(403).json({ error: 'Subscriber is suspended' });
  try {
    if (!audit?.route) throw new Error('missing route');
    parsePlatformViewRequest({ reason: audit.reason, ticketReference: audit.ticketReference });
    if (
      !ticket
      || audit.supportTicketId !== ticket.id
      || audit.ticketReference !== ticket.reference
      || audit.ticketAccessVersion !== ticket.contentAccessVersion
      || grant.ticketAccessVersion !== ticket.contentAccessVersion
    ) {
      return res.status(403).json({
        error: 'The support ticket for this access grant is no longer active',
        code: 'PLATFORM_VIEW_TICKET_INACTIVE',
      });
    }
  } catch {
    return res.status(403).json({ error: 'Platform view audit is missing', code: 'PLATFORM_VIEW_AUDIT_MISSING' });
  }

  return runAsOrganization(org.id, async () => {
    // Synthetic membership: never persisted as a real User row. ADMIN grants the
    // read permissions a support view needs. The signed grant plus the GET/HEAD
    // gate are what authorise this request; this role alone authorises nothing.
    req.user = {
      id: identity.id,
      email: identity.email,
      name: identity.email,
      role: 'ADMIN',
      organizationId: org.id,
    };
    req.platformUser = platformUser;
    req.platformViewAccess = {
      organizationId: org.id,
      auditLogId: grant.auditLogId,
      supportTicketId: ticket.id,
      ticketReference: ticket.reference,
      expiresAt: grant.exp! * 1000,
    };
    next();
  });
}

export async function verifyToken(req: Request, res: Response, next: NextFunction) {
  // Tenant routers repeat verifyToken after the global /api boundary. Only a
  // successful first pass can set this server-side marker, so the second pass
  // preserves the same scoped request without issuing or checking twice.
  if (req.platformViewAccess) return next();

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
      /*
        Re-validate the workspace claim on EVERY request.

        Checking it once at mint time would be checking it at the wrong moment:
        a token lives for days, and a membership revoked an hour after it was
        signed would keep working until the token expired. So the claim is
        treated as an assertion to be verified, not as a fact already
        established — the same standard organizationId is held to.

        Two refusals, and they are different failures:

        - A workspace id from ANOTHER organization resolves to nothing, because
          this lookup runs inside the organization scope opened above. It is
          refused as not found rather than as forbidden: confirming that another
          tenant's workspace exists is itself a disclosure.
        - A workspace in this organization that the user is not a member of is
          refused as forbidden, because they can be told that much.

        An absent claim is not a refusal. It resolves to the default workspace
        further down the stack, which is where a pre-workspaces session's data
        already lives.
      */
      let activeWorkspaceId: string | undefined;
      if (decoded.workspaceId) {
        const workspace = await prisma.workspace.findFirst({
          where: { id: decoded.workspaceId },
          select: { id: true },
        });
        if (!workspace) {
          return res.status(401).json({ error: 'Invalid token: unknown workspace' });
        }
        const membership = await prisma.workspaceMember.findFirst({
          where: { workspaceId: decoded.workspaceId, userId: decoded.id },
          select: { id: true },
        });
        if (!membership) {
          return res.status(403).json({ error: 'You are no longer a member of that workspace' });
        }
        activeWorkspaceId = workspace.id;
        setScopeWorkspaceId(workspace.id);
        (req as any).activeWorkspaceId = workspace.id;
      }
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
                  restrictIntegrations: true,
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
          restrictIntegrations: true,
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
        restrictIntegrations: user.restrictIntegrations,
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

  let decoded: PlatformJwtPayload;
  try {
    const token = auth.split(' ')[1];
    decoded = jwt.verify(token, process.env.JWT_SECRET!) as PlatformJwtPayload;
    if (decoded.scope !== 'PLATFORM' || !decoded.id) {
      return res.status(403).json({ error: 'Platform access required' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const identity = await readCurrentPlatformIdentity(decoded.id, 'verify-platform-token');
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

    // From the database, never from the token: a revoked permission must stop
    // working immediately on platform routes and tenant view-as alike.
    req.platformUser = platformUserFrom(identity);
    next();
  } catch (error) {
    logger.error('Platform identity verification failed', { error: String(error), identityId: decoded.id });
    return res.status(503).json({ error: 'Platform authorization is unavailable' });
  }
}
