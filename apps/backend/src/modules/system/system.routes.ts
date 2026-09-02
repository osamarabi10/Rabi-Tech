import { Router } from 'express';
import logger from '../../lib/logger';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { OpenWAPairingProvider, OpenWAService } from '../whatsapp/openwa.service';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { isWithinWorkingHours } from '../../utils/working-hours';
import { requireAdmin, requirePermission, requireSupervisor } from '../../middleware/rbac.middleware';
import { KEYWORD_CATEGORIES, invalidateCustomKeywords } from '../../constants/keywords';
import { MAX_SNIPPET_FILES, MAX_SNIPPET_FILE_BYTES } from '../snippets/snippet-storage';
import { MAX_IMPORT_ROWS } from '../contacts/import.service';
import { MAX_MEDIA_BYTES } from '../channels/meta-media';
import { getWorkingHoursConfig } from '../../utils/out-of-hours';
import { reconcileSessionWebhook } from '../../utils/webhook-reconcile';
import {
  getOrganizationConfig,
  getPrimarySession,
  inboxConfig,
  invalidateOrganizationConfig,
} from '../../utils/whatsapp-sessions';
import {
  assertSeatAvailable,
  isSeatLimitError,
  seatLimitResponse,
} from '../usage/entitlements';
import { resolveTeamId } from '../../utils/teams';
import { auditLog } from '../../lib/audit';
import { getTenantId } from '../../lib/tenant-context';
import { issueUserInvitation } from './user-invitations.service';
import { resolveEntitlements } from '../billing/entitlements.resolver';
import { getEdition } from '../billing/editions.service';
import { channelGrantRefusal } from '../channels/channel-entitlement';
import { MAX_FILES_PER_MESSAGE } from '../conversations/message-limits';

const router = Router();
router.use(verifyToken);

const MIN_INACTIVITY_MINUTES = 5;
const MAX_INACTIVITY_MINUTES = 7 * 24 * 60;

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return value.length > 0 && value.length <= 100;
  } catch {
    return false;
  }
}

async function workspaceSettings(organizationId: string) {
  const [organization, config, users, recipients] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true },
    }),
    prisma.organizationConfig.findUnique({
      where: { organizationId },
      select: {
        timezone: true,
        userInactivityTimeoutMinutes: true,
        weeklyRecapEnabled: true,
        quietHoursEnabled: true,
        quietHoursStart: true,
        quietHoursEnd: true,
      },
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        avatarUrl: true,
        role: true,
        identity: { select: { email: true } },
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    prisma.weeklyRecapRecipient.findMany({
      select: { userId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  if (!organization) return null;
  return {
    name: organization.name,
    timezone: config?.timezone ?? 'Asia/Jerusalem',
    userInactivityTimeoutMinutes: config?.userInactivityTimeoutMinutes ?? 20,
    weeklyRecapEnabled: config?.weeklyRecapEnabled ?? false,
    quietHoursEnabled: config?.quietHoursEnabled ?? false,
    quietHoursStart: config?.quietHoursStart ?? '21:00',
    quietHoursEnd: config?.quietHoursEnd ?? '08:00',
    weeklyRecapRecipientIds: recipients.map((recipient) => recipient.userId),
    eligibleRecipients: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.identity.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
    })),
  };
}

async function findSessionByName(organizationId: string, sessionName: string) {
  return prisma.whatsappSession.findUnique({
    where: { organizationId_sessionName: { organizationId, sessionName } },
  });
}

async function syncUserSocketTeamRooms(organizationId: string, userId: string) {
  const [user, teams] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        role: true,
        primaryTeamId: true,
        teams: { select: { teamId: true } },
      },
    }),
    prisma.team.findMany({ select: { id: true } }),
  ]);
  const userSockets = getIO().in(socketRoom.user(organizationId, userId));

  for (const team of teams) {
    userSockets.socketsLeave(socketRoom.team(organizationId, team.id));
  }
  if (!user?.isActive) {
    userSockets.disconnectSockets(true);
    return;
  }

  const desiredTeamIds = user.role === 'ADMIN'
    ? teams.map((team) => team.id)
    : Array.from(new Set([
        user.primaryTeamId,
        ...user.teams.map((team) => team.teamId),
      ].filter(Boolean))) as string[];
  for (const teamId of desiredTeamIds) {
    userSockets.socketsJoin(socketRoom.team(organizationId, teamId));
  }
}

// GET /api/system/teams - organization teams
router.get('/teams', async (_req, res) => {
  try {
    const teams = await prisma.team.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { members: true, conversations: true, sessions: true } },
        members: { select: { userId: true } },
      },
    });
    res.json(teams.map(({ members, ...team }) => ({
      ...team,
      memberIds: members.map((member) => member.userId),
    })));
  } catch (error) {
    logger.error('Team list failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل تحميل الفرق' });
  }
});

// POST /api/system/teams - create team (admin only)
router.post('/teams', requireAdmin, async (req, res) => {
  try {
    const { name, slug, description, color, emoji, isDefault } = req.body;
    const normalizedName = String(name || '').trim();
    const normalizedSlug = String(slug || normalizedName)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!normalizedName || normalizedName.length > 80 || !normalizedSlug || normalizedSlug.length > 80) {
      return res.status(400).json({ error: 'اسم الفريق مطلوب' });
    }

    if (description?.trim().length > 500) {
      return res.status(400).json({ error: 'Team description cannot exceed 500 characters' });
    }
    if (color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(color))) {
      return res.status(400).json({ error: 'Team color must be a six-digit hex color' });
    }

    const team = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        // The `where` is not optional here, whatever Prisma's types say.
        //
        // Without it this cleared isDefault on every team in every organization
        // on the platform: the tenant extension only injected organizationId
        // into an updateMany that already had a where to augment, so a call
        // with none ran with no tenant predicate at all. One admin promoting
        // their own default team demoted everyone else's.
        //
        // The extension now creates the where when it is absent, so this is
        // belt and braces — kept explicit because a reader should be able to
        // see the tenant boundary at the call site rather than infer it.
        await tx.team.updateMany({
          where: { organizationId: req.user!.organizationId },
          data: { isDefault: false },
        });
      }
      return tx.team.create({
        data: {
          organizationId: req.user!.organizationId,
          name: normalizedName,
          slug: normalizedSlug,
          description: description?.trim() || null,
          color: color || '#6366F1',
          emoji: emoji?.trim() || null,
          isDefault: Boolean(isDefault),
        },
      });
    });

    await auditLog({
      userId: req.user!.id,
      action: 'team.created',
      resource: 'team',
      resourceId: team.id,
      changes: { after: team },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.status(201).json(team);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'رابط الفريق مستخدم' });
    logger.error('Team creation failed', { error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: 'فشل إنشاء الفريق' });
  }
});

// PATCH /api/system/teams/:id - update team (admin only)
router.patch('/teams/:id', requireAdmin, async (req, res) => {
  try {
    const { name, slug, description, color, emoji, isDefault,
            assignmentStrategy, maxConcurrentPerAgent } = req.body;
    const current = await prisma.team.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ error: 'Team not found' });

    const data: Record<string, unknown> = {};
    if (name !== undefined) {
      const normalizedName = String(name).trim();
      if (!normalizedName || normalizedName.length > 80) {
        return res.status(400).json({ error: 'Team name must be between 1 and 80 characters' });
      }
      data.name = normalizedName;
    }
    if (assignmentStrategy !== undefined) {
      const allowed = ['NONE', 'ROUND_ROBIN', 'LEAST_OPEN'];
      if (!allowed.includes(String(assignmentStrategy))) {
        return res.status(400).json({ error: 'استراتيجية توزيع غير معروفة' });
      }
      data.assignmentStrategy = String(assignmentStrategy);
    }
    if (maxConcurrentPerAgent !== undefined) {
      // null / empty means unlimited
      const raw = maxConcurrentPerAgent;
      if (raw === null || raw === '') {
        data.maxConcurrentPerAgent = null;
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'الحد الأقصى يجب أن يكون رقماً أكبر من صفر' });
        }
        data.maxConcurrentPerAgent = n;
      }
    }
    if (slug !== undefined) {
      const normalizedSlug = String(slug)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!normalizedSlug || normalizedSlug.length > 80) {
        return res.status(400).json({ error: 'Team slug must be between 1 and 80 characters' });
      }
      data.slug = normalizedSlug;
    }
    if (description !== undefined) {
      const normalizedDescription = description?.trim() || null;
      if (normalizedDescription && normalizedDescription.length > 500) {
        return res.status(400).json({ error: 'Team description cannot exceed 500 characters' });
      }
      data.description = normalizedDescription;
    }
    if (color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(String(color))) {
        return res.status(400).json({ error: 'Team color must be a six-digit hex color' });
      }
      data.color = color;
    }
    if (emoji !== undefined) data.emoji = emoji?.trim() || null;
    if (isDefault !== undefined) {
      if (current.isDefault && isDefault === false) {
        return res.status(400).json({ error: 'Choose another default team before changing this one' });
      }
      data.isDefault = Boolean(isDefault);
    }

    const team = await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.team.updateMany({
          where: { id: { not: req.params.id } },
          data: { isDefault: false },
        });
      }
      return tx.team.update({ where: { id: req.params.id }, data });
    });

    await auditLog({
      userId: req.user!.id,
      action: 'team.updated',
      resource: 'team',
      resourceId: team.id,
      changes: { before: current, after: team },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json(team);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'الفريق غير موجود' });
    if (err?.code === 'P2002') return res.status(409).json({ error: 'رابط الفريق مستخدم' });
    logger.error('Team update failed', { error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: 'فشل تحديث الفريق' });
  }
});

// PUT /api/system/teams/:id/members - replace a team's membership atomically
router.put('/teams/:id/members', requireAdmin, async (req, res) => {
  try {
    if (!Array.isArray(req.body?.userIds) || req.body.userIds.length > 500) {
      return res.status(400).json({ error: 'userIds must be an array with at most 500 entries' });
    }

    const userIds = Array.from(new Set(
      req.body.userIds.map((value: unknown) => String(value || '').trim()).filter(Boolean),
    )) as string[];
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const users = userIds.length
      ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true } })
      : [];
    if (users.length !== userIds.length) {
      return res.status(400).json({ error: 'One or more users do not belong to this workspace' });
    }

    const previous = await prisma.userTeam.findMany({
      where: { teamId: team.id },
      select: { userId: true },
    });
    const previousIds = previous.map((membership) => membership.userId);
    const requested = new Set(userIds);
    const removedIds = previousIds.filter((userId) => !requested.has(userId));

    await prisma.$transaction(async (tx) => {
      if (removedIds.length) {
        await tx.user.updateMany({
          where: { id: { in: removedIds }, primaryTeamId: team.id },
          data: { primaryTeamId: null },
        });
      }

      await tx.userTeam.deleteMany({
        where: {
          teamId: team.id,
          ...(userIds.length ? { userId: { notIn: userIds } } : {}),
        },
      });

      if (userIds.length) {
        await tx.userTeam.createMany({
          data: userIds.map((userId) => ({
            organizationId: req.user!.organizationId,
            teamId: team.id,
            userId,
          })),
          skipDuplicates: true,
        });
      }
    });

    const changedUserIds = Array.from(new Set([
      ...removedIds,
      ...userIds.filter((userId) => !previousIds.includes(userId)),
    ]));
    await Promise.all(changedUserIds.map((userId) =>
      syncUserSocketTeamRooms(req.user!.organizationId, userId),
    ));

    await auditLog({
      userId: req.user!.id,
      action: 'team.members.updated',
      resource: 'team',
      resourceId: team.id,
      changes: { before: previousIds, after: userIds },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.json({ teamId: team.id, memberIds: userIds });
  } catch (error) {
    logger.error('team membership update failed', { error: String(error), teamId: req.params.id });
    res.status(500).json({ error: 'Failed to update team members' });
  }
});

// DELETE /api/system/teams/:id - remove unused team (admin only)
router.delete('/teams/:id', requireAdmin, async (req, res) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: {
        _count: {
          select: {
            members: true,
            primaryUsers: true,
            conversations: true,
            sessions: true,
            templates: true,
            invitations: true,
          },
        },
      },
    });
    if (!team) return res.status(404).json({ error: 'الفريق غير موجود' });
    if (team.isDefault) return res.status(400).json({ error: 'لا يمكن حذف الفريق الافتراضي' });
    if (Object.values(team._count).some((count) => count > 0)) {
      return res.status(409).json({ error: 'الفريق مستخدم، انقل العناصر قبل الحذف' });
    }
    await prisma.team.delete({ where: { id: req.params.id } });
    await auditLog({
      userId: req.user!.id,
      action: 'team.deleted',
      resource: 'team',
      resourceId: team.id,
      changes: { before: team },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ ok: true });
  } catch (error) {
    logger.error('Team deletion failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل حذف الفريق' });
  }
});

// GET /api/system/stats — overview dashboard numbers
/**
 * GET /api/system/limits — the file and import limits, from the constants that
 * actually enforce them.
 *
 * Served rather than hardcoded in the client for one reason: a limits screen
 * that states a number nothing enforces is worse than no screen. An operator
 * reads "20 MB", uploads 19 MB, and is refused by a check that says something
 * else — and now they distrust every other number on the page.
 *
 * Each value below is imported from the module that rejects the request, so the
 * page cannot drift from the behaviour. Anything we do not actually enforce is
 * absent, not guessed at: we publish no per-media-type caps because we do not
 * impose any, and repeating WhatsApp's published table as though it were ours
 * would be stating a rule we do not apply.
 */
router.get('/limits', async (_req, res) => {
  res.json({
    files: [
      {
        key: 'snippetAttachment',
        bytes: MAX_SNIPPET_FILE_BYTES,
        count: MAX_SNIPPET_FILES,
      },
      { key: 'inboundMedia', bytes: MAX_MEDIA_BYTES },
      { key: 'brandingAsset', bytes: 2 * 1024 * 1024 },
    ],
    contactImport: { rows: MAX_IMPORT_ROWS },
    // Surfaced so the composer can prevent rather than refuse: an agent who is
    // told the limit while attaching does not discover it after writing the
    // message.
    filesPerMessage: MAX_FILES_PER_MESSAGE,
  });
});

router.get('/stats', async (_req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [openConversations, pendingConversations, resolvedToday, resolvedConversations, campaignsSent] =
      await Promise.all([
        prisma.conversation.count({ where: { status: 'OPEN' } }),
        prisma.conversation.count({ where: { status: 'PENDING' } }),
        prisma.conversation.count({ where: { status: 'RESOLVED', updatedAt: { gte: todayStart } } }),
        prisma.conversation.count({ where: { status: 'RESOLVED' } }),
        prisma.campaign.count({ where: { status: 'SENT' } }),
      ]);

    res.json({
      conversations: {
        open: openConversations,
        pending: pendingConversations,
        resolvedToday,
        resolved: resolvedConversations,
        campaignsSent,
      },
    });
  } catch (error) {
    logger.error('System stats failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/system/users?all=true - team members / user management
router.get('/users', async (req, res) => {
  try {
    const { all } = req.query;
    const [users, config, effective] = await Promise.all([prisma.user.findMany({
      where: {
        ...(all !== 'true' ? { isActive: true } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        primaryTeamId: true,
        primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
        teams: { include: { team: { select: { id: true, name: true, slug: true, color: true } } } },
        role: true,
        isActive: true,
        isAway: true,
        restrictContactVisibility: true,
        contactVisibilityScope: true,
        restrictCalls: true,
        restrictWorkflows: true,
        restrictDataExport: true,
        restrictContactDeletion: true,
        restrictWorkspaceSettings: true,
        restrictIntegrations: true,
        maskPhoneAndEmail: true,
        createdAt: true,
        authSessions: {
          where: { revokedAt: null },
          select: { lastSeenAt: true },
          orderBy: { lastSeenAt: 'desc' },
          take: 1,
        },
        identity: { select: { email: true } },
      },
      orderBy: { name: 'asc' },
    }), prisma.organizationConfig.findUnique({
      where: { organizationId: req.user!.organizationId },
      select: { userInactivityTimeoutMinutes: true },
    }), resolveEntitlements(req.user!.organizationId)]);
    const onlineThreshold = Date.now() - (config?.userInactivityTimeoutMinutes ?? 20) * 60_000;
    // Map identity.email to email field to maintain same API structure
    const mapped = users.map((u) => {
      const lastSeen = u.authSessions[0]?.lastSeenAt ?? null;
      return {
        ...u,
        email: u.identity.email,
        identity: undefined,
        authSessions: undefined,
        lastSeen,
        presence: !u.isActive ? 'INACTIVE' : u.isAway ? 'AWAY' : lastSeen && lastSeen.getTime() >= onlineThreshold ? 'ONLINE' : 'OFFLINE',
      };
    });
    res.json({
      users: mapped,
      capabilities: {
        canInvite: ['ADMIN', 'SUPERVISOR'].includes(req.user!.role || ''),
        canManage: req.user!.role === 'ADMIN',
        managerInviteRole: 'AGENT',
        maskPhoneAndEmail: getEdition(effective.plan).maskContactDetails,
        callsAvailable: false,
      },
    });
  } catch (error) {
    logger.error('User list failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/user-invitations', requirePermission('user:create'), async (_req, res) => {
  const invitations = await prisma.userInvitation.findMany({
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      primaryTeamId: true,
      invitedByName: true,
      expiresAt: true,
      createdAt: true,
      primaryTeam: { select: { id: true, name: true, color: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invitations);
});

router.post('/user-invitations', requirePermission('user:create'), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name || '').trim();
    const requestedRole = String(req.body?.role || 'AGENT').toUpperCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (req.user!.role === 'SUPERVISOR' && requestedRole !== 'AGENT') {
      return res.status(403).json({ error: 'Managers can invite Agents only' });
    }
    const allowedRoles = ['SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'] as const;
    if (!allowedRoles.includes(requestedRole as typeof allowedRoles[number])) {
      return res.status(400).json({ error: 'Invalid invitation access level' });
    }
    await assertSeatAvailable();
    const invitation = await issueUserInvitation({
      organizationId: req.user!.organizationId,
      email,
      name: name || null,
      role: requestedRole as typeof allowedRoles[number],
      primaryTeamId: req.body?.primaryTeamId ? String(req.body.primaryTeamId) : null,
      invitedByName: req.user!.name,
    });
    await auditLog({
      action: 'USER_INVITED',
      resource: 'user-invitation',
      resourceId: invitation.id,
      description: `${req.user!.name} invited ${email} as ${requestedRole}`,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.status(201).json(invitation);
  } catch (error) {
    if (isSeatLimitError(error)) return res.status(error.status).json(seatLimitResponse(error));
    const message = String((error as Error).message || error);
    res.status(message.includes('already') ? 409 : 400).json({ error: message });
  }
});

router.delete('/user-invitations/:id', requireAdmin, async (req, res) => {
  const result = await prisma.userInvitation.updateMany({
    where: { id: req.params.id, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (!result.count) return res.status(404).json({ error: 'Invitation not found' });
  await auditLog({
    action: 'USER_INVITATION_REVOKED',
    resource: 'user-invitation',
    resourceId: req.params.id,
    description: `${req.user!.name} revoked a user invitation`,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });
  return res.json({ ok: true });
});

// POST /api/system/users — create user (admin only)
router.post('/users', requireAdmin, requirePermission('user:create'), async (req, res) => {
  try {
    const { name, email, password, role, phone, primaryTeamId, teamIds } = req.body;
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return res.status(400).json({ error: 'الاسم والبريد والكلمة السرية والقسم مطلوبة' });
    }
    const emailLower = email.trim().toLowerCase();
    const workerRoles = ['SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'];
    if (role && !workerRoles.includes(role)) {
      return res.status(400).json({ error: 'يمكن إنشاء مستخدمي عمل فقط من هذه الصفحة' });
    }

    const existingIdentity = await prisma.identity.findUnique({ where: { email: emailLower } });
    if (existingIdentity) {
      return res.status(409).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
    }

    // Seats are a plan entitlement. Check before creating the Identity, or a
    // refused seat would leave an orphan login behind and block that email
    // from ever being added again.
    await assertSeatAvailable();

    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 10);
    const resolvedPrimaryTeamId = await resolveTeamId({
      teamId: primaryTeamId,
    });

    const user = await prisma.$transaction(async (tx) => {
      const identity = await tx.identity.create({
        data: { email: emailLower, passwordHash },
      });

      const created = await tx.user.create({
        data: {
          organizationId: req.user!.organizationId,
          identityId: identity.id,
          name: name.trim(),
          primaryTeamId: resolvedPrimaryTeamId,
          role: role || 'AGENT',
          phone: phone?.trim() || null,
        },
        select: {
          id: true,
          name: true,
          phone: true,
          primaryTeamId: true,
          primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
          teams: { include: { team: { select: { id: true, name: true, slug: true, color: true } } } },
          role: true,
          isActive: true,
          createdAt: true,
          identity: { select: { email: true } },
        },
      });

      const memberships = Array.from(
        new Set([resolvedPrimaryTeamId, ...(Array.isArray(teamIds) ? teamIds : [])].filter(Boolean)),
      ) as string[];
      if (memberships.length > 0) {
        await tx.userTeam.createMany({
          data: memberships.map((teamId) => ({
            organizationId: req.user!.organizationId,
            userId: created.id,
            teamId,
          })),
          skipDuplicates: true,
        });
      }

      return created;
    });

    res.json({
      ...user,
      email: user.identity.email,
      identity: undefined,
    });
  } catch (error) {
    if (isSeatLimitError(error)) {
      return res.status(error.status).json(seatLimitResponse(error));
    }
    logger.error('User creation failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل إنشاء المستخدم' });
  }
});

// PATCH /api/system/users/:id — update user (admin only)
router.patch('/users/:id', requireAdmin, requirePermission('user:update'), async (req, res) => {
  try {
    const {
      name, email, password, role, phone, isActive, primaryTeamId, teamIds,
      restrictContactVisibility, contactVisibilityScope, restrictCalls,
      restrictWorkflows, maskPhoneAndEmail,
      restrictDataExport, restrictContactDeletion, restrictWorkspaceSettings, restrictIntegrations,
    } = req.body;

    /*
      Nobody edits their own access.

      Without this, every restriction on this route is advisory: a restricted
      admin PATCHes themselves, clears the flag, and the restriction was never a
      control at all. It is the same self-referential hole as an admin granting
      themselves a role, and it is why respond.io states the rule outright —
      "A user cannot revoke or edit their own access."

      Scoped to the access fields rather than the whole route on purpose. An
      admin renaming themselves or changing their own phone number is ordinary;
      an admin lifting their own restriction is not, and refusing the first to
      prevent the second would be the kind of over-broad guard people work
      around.
    */
    const ACCESS_FIELDS = {
      role, isActive,
      restrictContactVisibility, contactVisibilityScope, restrictCalls,
      restrictWorkflows, maskPhoneAndEmail,
      restrictDataExport, restrictContactDeletion, restrictWorkspaceSettings, restrictIntegrations,
    };
    const editingOwnAccess = req.params.id === req.user!.id
      && Object.values(ACCESS_FIELDS).some((value) => value !== undefined);
    if (editingOwnAccess) {
      return res.status(403).json({
        error: 'ما بتقدر تعدّل صلاحياتك الخاصة. لازم مدير تاني يعملها.',
        code: 'CANNOT_EDIT_OWN_ACCESS',
      });
    }
    
    const userToUpdate = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { identityId: true, role: true },
    });
    if (!userToUpdate) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }
    if (userToUpdate.role === 'ADMIN') {
      return res.status(403).json({ error: 'لا يمكن تعديل مدير المؤسسة من إدارة المستخدمين' });
    }
    if (role === 'ADMIN') {
      return res.status(400).json({ error: 'لا يمكن ترقية مستخدم عمل إلى مدير المؤسسة' });
    }
    if (contactVisibilityScope !== undefined && !['TEAM', 'SELF'].includes(contactVisibilityScope)) {
      return res.status(400).json({ error: 'Contact visibility scope must be TEAM or SELF' });
    }
    if (maskPhoneAndEmail === true) {
      const effective = await resolveEntitlements(req.user!.organizationId);
      if (!getEdition(effective.plan).maskContactDetails) {
        return res.status(402).json({
          error: 'Masking contact phone numbers and email addresses requires Business or Enterprise',
          code: 'PLAN_UPGRADE_REQUIRED',
          requiredPlan: 'BUSINESS',
        });
      }
    }

    // Update Identity email or password if provided
    const identityData: Record<string, string> = {};
    if (email !== undefined) identityData.email = email.trim().toLowerCase();
    if (password?.trim()) {
      const bcrypt = await import('bcryptjs');
      identityData.passwordHash = await bcrypt.hash(password, 10);
    }
    if (Object.keys(identityData).length > 0) {
      await prisma.identity.update({
        where: { id: userToUpdate.identityId },
        data: identityData,
      });
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (primaryTeamId !== undefined) {
      data.primaryTeamId = await resolveTeamId({ teamId: primaryTeamId });
    }
    if (role !== undefined) data.role = role;
    if (phone !== undefined) data.phone = phone?.trim() || null;
    if (isActive !== undefined) {
      data.isActive = isActive;
      if (!isActive) data.tokenVersion = { increment: 1 };
    }
    if (restrictContactVisibility !== undefined) data.restrictContactVisibility = restrictContactVisibility === true;
    if (contactVisibilityScope !== undefined) data.contactVisibilityScope = contactVisibilityScope;
    if (restrictCalls !== undefined) data.restrictCalls = restrictCalls === true;
    if (restrictWorkflows !== undefined) data.restrictWorkflows = restrictWorkflows === true;
    if (maskPhoneAndEmail !== undefined) data.maskPhoneAndEmail = maskPhoneAndEmail === true;
    if (restrictDataExport !== undefined) data.restrictDataExport = restrictDataExport === true;
    if (restrictContactDeletion !== undefined) data.restrictContactDeletion = restrictContactDeletion === true;
    if (restrictWorkspaceSettings !== undefined) data.restrictWorkspaceSettings = restrictWorkspaceSettings === true;
    if (restrictIntegrations !== undefined) data.restrictIntegrations = restrictIntegrations === true;

    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.params.id },
        data,
        select: {
          id: true,
          name: true,
          phone: true,
          primaryTeamId: true,
          primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
          teams: { include: { team: { select: { id: true, name: true, slug: true, color: true } } } },
          role: true,
          isActive: true,
          isAway: true,
          restrictContactVisibility: true,
          contactVisibilityScope: true,
          restrictCalls: true,
          restrictWorkflows: true,
          maskPhoneAndEmail: true,
          createdAt: true,
          identity: { select: { email: true } },
        },
      });

      if (Array.isArray(teamIds)) {
        await tx.userTeam.deleteMany({ where: { userId: req.params.id } });
        const memberships = Array.from(new Set([updated.primaryTeamId, ...teamIds].filter(Boolean))) as string[];
        if (memberships.length > 0) {
          await tx.userTeam.createMany({
            data: memberships.map((teamId) => ({
              organizationId: req.user!.organizationId,
              userId: req.params.id,
              teamId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return updated;
    });

    if (role !== undefined || isActive !== undefined || primaryTeamId !== undefined || Array.isArray(teamIds)) {
      await syncUserSocketTeamRooms(req.user!.organizationId, req.params.id);
    }

    res.json({
      ...user,
      email: user.identity.email,
      identity: undefined,
    });
  } catch (error) {
    logger.error('User update failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل تحديث المستخدم' });
  }
});

// DELETE /api/system/users/:id — deactivate user (soft delete)
router.delete('/users/:id', requireAdmin, requirePermission('user:delete'), async (req, res) => {
  try {
    // Same rule as the update route, for the more final version of the act.
    // An admin deactivating themselves locks themselves out of the workspace
    // they administer, and there is no self-service way back in.
    if (req.params.id === req.user!.id) {
      return res.status(403).json({
        error: 'ما بتقدر تلغي حسابك انت. لازم مدير تاني يعملها.',
        code: 'CANNOT_DELETE_SELF',
      });
    }

    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { role: true },
    });
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (target.role === 'ADMIN') {
      return res.status(403).json({ error: 'لا يمكن تعطيل مدير المؤسسة' });
    }
    await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive: false, tokenVersion: { increment: 1 } },
    });
    getIO()
      .in(socketRoom.user(req.user!.organizationId, req.params.id))
      .disconnectSockets(true);
    res.json({ ok: true });
  } catch (error) {
    logger.error('User deactivation failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل تعطيل المستخدم' });
  }
});

// GET /api/system/inbox-config - team-owned WhatsApp sessions
router.get('/inbox-config', async (req, res) => {
  res.json(await inboxConfig(req.user!.organizationId));
});

router.get('/workspace-settings', requireAdmin, async (req, res) => {
  const settings = await workspaceSettings(req.user!.organizationId);
  if (!settings) return res.status(404).json({ error: 'Workspace not found' });
  res.json(settings);
});

router.patch('/workspace-settings', requireAdmin, async (req, res) => {
  const organizationId = req.user!.organizationId;
  const supplied = [
    'name', 'timezone', 'userInactivityTimeoutMinutes', 'weeklyRecapEnabled', 'weeklyRecapRecipientIds',
    'quietHoursEnabled', 'quietHoursStart', 'quietHoursEnd',
  ].some((field) => req.body?.[field] !== undefined);
  if (!supplied) return res.status(400).json({ error: 'No workspace settings supplied' });

  /*
    Quiet hours (M8.4). Validated here as well as by a CHECK constraint, and
    both are wanted: the constraint protects the worker, which reads these
    columns with nobody in front of it and would otherwise parse a malformed
    value to minute zero — a silently wrong window rather than a loud failure.
    This gives the admin a sentence instead of a 500.
  */
  const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  const quietEnabled = req.body.quietHoursEnabled === undefined ? undefined : req.body.quietHoursEnabled;
  if (quietEnabled !== undefined && typeof quietEnabled !== 'boolean') {
    return res.status(400).json({ error: 'quietHoursEnabled must be a boolean' });
  }
  const quietStart = req.body.quietHoursStart === undefined ? undefined : String(req.body.quietHoursStart).trim();
  const quietEnd = req.body.quietHoursEnd === undefined ? undefined : String(req.body.quietHoursEnd).trim();
  for (const [label, value] of [['start', quietStart], ['end', quietEnd]] as const) {
    if (value !== undefined && !timePattern.test(value)) {
      return res.status(400).json({ error: `Quiet hours ${label} must be a 24-hour time like 21:00` });
    }
  }
  // A zero-width window is refused rather than accepted and ignored. Saving
  // 21:00–21:00 and being told nothing would read as "quiet hours are on",
  // while the worker treats it as no window at all and sends through the night.
  if (quietStart !== undefined && quietEnd !== undefined && quietStart === quietEnd) {
    return res.status(400).json({ error: 'Quiet hours start and end cannot be the same time' });
  }

  const name = req.body.name === undefined ? undefined : String(req.body.name).trim();
  if (name !== undefined && (name.length < 2 || name.length > 120)) {
    return res.status(400).json({ error: 'Workspace name must be between 2 and 120 characters' });
  }

  const timezone = req.body.timezone === undefined ? undefined : String(req.body.timezone).trim();
  if (timezone !== undefined && !isIanaTimezone(timezone)) {
    return res.status(400).json({ error: 'A valid IANA timezone is required' });
  }

  const timeout = req.body.userInactivityTimeoutMinutes === undefined
    ? undefined
    : Number(req.body.userInactivityTimeoutMinutes);
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || timeout < MIN_INACTIVITY_MINUTES || timeout > MAX_INACTIVITY_MINUTES)
  ) {
    return res.status(400).json({ error: 'Inactivity timeout must be between 5 minutes and 7 days' });
  }

  const weeklyRecapEnabled = req.body.weeklyRecapEnabled === undefined
    ? undefined
    : req.body.weeklyRecapEnabled;
  if (weeklyRecapEnabled !== undefined && typeof weeklyRecapEnabled !== 'boolean') {
    return res.status(400).json({ error: 'weeklyRecapEnabled must be a boolean' });
  }

  let recipientIds: string[] | undefined;
  if (req.body.weeklyRecapRecipientIds !== undefined) {
    if (!Array.isArray(req.body.weeklyRecapRecipientIds)) {
      return res.status(400).json({ error: 'weeklyRecapRecipientIds must be an array' });
    }
    const normalizedRecipientIds = [...new Set<string>(
      (req.body.weeklyRecapRecipientIds as unknown[])
        .map((id) => String(id).trim())
        .filter((id): id is string => Boolean(id)),
    )];
    recipientIds = normalizedRecipientIds;
    if (normalizedRecipientIds.length > 100) {
      return res.status(400).json({ error: 'A weekly recap can have at most 100 recipients' });
    }
    const validUsers = await prisma.user.count({ where: { id: { in: normalizedRecipientIds }, isActive: true } });
    if (validUsers !== normalizedRecipientIds.length) {
      return res.status(400).json({ error: 'Every recap recipient must be an active workspace member' });
    }
  }

  await prisma.$transaction(async (tx) => {
    if (name !== undefined) {
      await tx.organization.update({ where: { id: organizationId }, data: { name } });
    }

    if (timezone !== undefined || timeout !== undefined || weeklyRecapEnabled !== undefined
        || quietEnabled !== undefined || quietStart !== undefined || quietEnd !== undefined) {
      await tx.organizationConfig.upsert({
        where: { organizationId },
        create: {
          organizationId,
          ...(timezone !== undefined ? { timezone } : {}),
          ...(timeout !== undefined ? { userInactivityTimeoutMinutes: timeout } : {}),
          ...(weeklyRecapEnabled !== undefined ? { weeklyRecapEnabled } : {}),
        },
        update: {
          ...(timezone !== undefined ? { timezone } : {}),
          ...(timeout !== undefined ? { userInactivityTimeoutMinutes: timeout } : {}),
          ...(weeklyRecapEnabled !== undefined ? { weeklyRecapEnabled } : {}),
        },
      });
    }

    if (recipientIds !== undefined) {
      await tx.weeklyRecapRecipient.deleteMany({ where: { organizationId } });
      if (recipientIds.length) {
        await tx.weeklyRecapRecipient.createMany({
          data: recipientIds.map((userId) => ({ organizationId, userId })),
        });
      }
    }
  });

  invalidateOrganizationConfig();
  await auditLog({
    action: 'WORKSPACE_SETTINGS_UPDATED',
    resource: 'organization',
    resourceId: organizationId,
    description: `Workspace settings updated by ${req.user!.email}`,
    userId: req.user!.id,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json(await workspaceSettings(organizationId));
});

router.get('/organization-config', requireAdmin, async (req, res) => {
  res.json(await getOrganizationConfig(req.user!.organizationId));
});

router.patch('/organization-config', requireAdmin, async (req, res) => {
  const allowed = [
  ] as const;
  const data: Record<string, string | null> = {};
  for (const field of allowed) {
    if (req.body[field] === undefined) continue;
    data[field] = String(req.body[field] || '').trim() || null;
  }
  if (!Object.keys(data).length) {
    return res.status(400).json({ error: 'No organization configuration fields supplied' });
  }
  const row = await prisma.organizationConfig.update({
    where: { organizationId: req.user!.organizationId },
    data,
  });
  invalidateOrganizationConfig();
  res.json(row);
});

// GET /api/system/sessions — WhatsApp session list + live connection state
router.get('/sessions', async (_req, res) => {
  try {
    const [sessions, channel] = await Promise.all([
      prisma.whatsappSession.findMany(),
      prisma.organizationChannel.findUnique({
        where: {
          organizationId_kind: {
            organizationId: getTenantId(),
            kind: 'OPENWA',
          },
        },
        select: { status: true },
      }),
    ]);
    // Organizations predating OrganizationChannel still resolve through
    // OpenWA, so a missing row is active for display just as it is for sends.
    const isActiveChannel = !channel || channel.status === 'ACTIVE';
    const withStatus = await Promise.all(
      sessions.map(async (s) => {
        let connected = false;
        let connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNAVAILABLE' = 'DISCONNECTED';
        let livePhone: string | null = null;
        try {
          const r = await OpenWAService.getStatus(s.sessionName);
          const st = (r.data?.status || r.data?.state || '').toLowerCase();
          connected =
            ['connected', 'authenticated', 'working', 'ready'].includes(st) ||
            r.data?.connected === true;
          connectionStatus = connected ? 'CONNECTED' : 'DISCONNECTED';
          livePhone = typeof r.data?.phone === 'string' ? r.data.phone : null;
        } catch {
          // Distinct from disconnected: the UI must explain why activation is
          // unavailable when the live readiness probe itself could not answer.
          connectionStatus = 'UNAVAILABLE';
        }

        if (connected) {
          // Webhook registration used to happen only during provisioning, so a
          // session linked any other way had none and every inbound message was
          // dropped silently. Reconcile here: this runs whenever an admin opens
          // Settings, which makes the failure self-healing instead of permanent.
          await reconcileSessionWebhook().catch((error) =>
            logger.warn('Webhook reconcile failed', { sessionName: s.sessionName, error: String(error) }),
          );

          // The stored number was written once at provisioning and never
          // refreshed, so the UI kept showing whichever number linked first.
          if (livePhone && livePhone !== s.phoneNumber) {
            await prisma.whatsappSession
              .update({ where: { id: s.id }, data: { phoneNumber: livePhone, isActive: true } })
              .then(() => { s.phoneNumber = livePhone; s.isActive = true; })
              .catch((error) =>
                logger.warn('Could not refresh linked number', { sessionName: s.sessionName, error: String(error) }),
              );
          }
        }
        return { ...s, connected, connectionStatus, isActiveChannel };
      })
    );
    res.json(withStatus);
  } catch (error) {
    logger.error('Session list failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

// WhatsApp group routes removed: RabiTech is a 1:1 conversation platform.

/**
 * POST /api/system/sessions/:name/disconnect — admin only.
 *
 * Signs the WhatsApp account out of this session so a different number can be
 * paired. Conversation history is untouched: it belongs to the organization, not
 * to the phone that was connected.
 *
 * Deliberately does not delete the session row — the same session name is reused
 * when the admin scans a new QR, which keeps every existing conversation attached.
 */
router.post('/sessions/:name/disconnect', requireAdmin, async (req, res) => {
  const { name } = req.params;
  try {
    const known = await prisma.whatsappSession.findUnique({
      where: {
        organizationId_sessionName: {
          organizationId: req.user!.organizationId,
          sessionName: name,
        },
      },
    });
    if (!known) return res.status(404).json({ error: 'Unknown session' });

    /*
      The edition has to permit OpenWA before a number can be paired to it.

      This endpoint is the front door and was unguarded. allowedChannels was
      enforced at /channels/meta/connect and /channels/active only, so a
      workspace on a Meta-only edition could not *switch* to OpenWA but could
      pair one here and send through it - resolveChannelKind() returns whichever
      row is ACTIVE and asks nothing about the edition. That is why trials
      worked while Meta was unconfigured. See D-27.

      Refused before any OpenWA call, including the createSession below: a
      session created for a workspace that may not use it is a resource nobody
      can pair and nothing will clean up.

      Grandfathered on an ACTIVE channel, so a live workspace on a Meta-only
      edition keeps its working number. The send path is deliberately still
      unguarded for the same reason - see channel-entitlement.ts.
    */
    const refused = await channelGrantRefusal(req.user!.organizationId, 'OPENWA');
    if (refused) {
      return res.status(402).json({
        error: refused.requiredPlan
          ? `باقة ${refused.planName} لا تشمل قناة واتساب عبر مسح QR. رقّي إلى ${refused.requiredPlan} لتفعيلها.`
          : `باقة ${refused.planName} لا تشمل قناة واتساب عبر مسح QR.`,
        code: 'PLAN_UPGRADE_REQUIRED',
        capability: 'OPENWA',
        requiredPlan: refused.requiredPlan,
      });
    }


    // Two modes:
    //   default  — stop only. WhatsApp keeps the pairing and the SAME number
    //              reconnects. Safe, reversible, no re-scan needed.
    //   unlink   — delete the gateway session, discarding saved credentials, so
    //              a DIFFERENT number can be paired. Requires a new QR scan.
    const unlink = req.body?.unlink === true;

    if (unlink) {
      await OpenWAPairingProvider.deleteSession(name).catch((error) => {
        logger.warn('Session delete returned an error', { sessionName: name, error: String(error) });
      });
      // Recreate immediately under the same name so the QR flow has something to
      // start, and so every existing conversation stays attached to this session.
      await OpenWAPairingProvider.createSession(name).catch((error) => {
        logger.error('Session recreate failed after unlink', { sessionName: name, error: String(error) });
      });
    } else {
      await OpenWAPairingProvider.stopSession(name).catch((error) => {
        // Already stopped, or the gateway never had it. Either way the desired
        // end state — not connected — is satisfied.
        logger.warn('Session stop returned an error', { sessionName: name, error: String(error) });
      });
    }

    await prisma.whatsappSession.update({
      where: { id: known.id },
      data: { isActive: false },
    });

    await auditLog({
      userId: req.user!.id,
      action: unlink ? 'session.unlinked' : 'session.disconnected',
      resource: 'whatsappSession',
      resourceId: known.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ ok: true, sessionName: name, unlinked: unlink });
  } catch (err) {
    logger.error('Session disconnect failed', { error: String(err), sessionName: name });
    res.status(500).json({ error: 'فشل تسجيل الخروج من واتساب' });
  }
});

/**
 * GET /api/system/sessions/:name/qr — admin only.
 *
 * Creates/starts the OpenWA session as needed; returns `{ connected }` once
 * linked, `{ qrCode }` while scannable, or `{ pending }` while the engine is
 * warming up. Entitlement-gated: see the block inside.
 */
router.get('/sessions/:name/qr', requireAdmin, async (req, res) => {
  const { name } = req.params;
  try {
    const known = await prisma.whatsappSession.findUnique({
      where: {
        organizationId_sessionName: {
          organizationId: req.user!.organizationId,
          sessionName: name,
        },
      },
    });
    if (!known) return res.status(404).json({ error: 'Unknown session' });

    /*
      The same entitlement gate the disconnect route carries, on the route that
      actually pairs a number.

      `channelGrantRefusal` was added to POST /sessions/:name/disconnect — which
      recreates a session — and not here, even though this is the endpoint an
      admin uses to pair one and it calls `createSession` below on the very next
      line. The guarded path was the rarer of the two.

      Refused before any OpenWA call, for the same reason as there: a session
      created for a workspace that may not use it is a resource nobody can pair
      and nothing will clean up.

      Grandfathered on an ACTIVE channel, so `ostudio` — ENTERPRISE, Meta-only
      by edition, running a working OpenWA number — keeps pairing. The send path
      stays deliberately unguarded for that same reason; see
      channel-entitlement.ts. That one is a commercial decision, not a gap.
    */
    const refused = await channelGrantRefusal(req.user!.organizationId, 'OPENWA');
    if (refused) {
      return res.status(402).json({
        error: refused.requiredPlan
          ? `باقة ${refused.planName} لا تشمل قناة واتساب عبر مسح QR. رقّي إلى ${refused.requiredPlan} لتفعيلها.`
          : `باقة ${refused.planName} لا تشمل قناة واتساب عبر مسح QR.`,
        code: 'PLAN_UPGRADE_REQUIRED',
        capability: 'OPENWA',
        requiredPlan: refused.requiredPlan,
      });
    }

    let status = '';
    try {
      const r = await OpenWAPairingProvider.getStatus(name);
      status = (r.data?.status || r.data?.state || '').toLowerCase();
    } catch {
      // Session doesn't exist in OpenWA yet — create it
      await OpenWAPairingProvider.createSession(name).catch(() => {});
    }

    if (['connected', 'authenticated', 'working', 'ready'].includes(status)) {
      return res.json({ connected: true });
    }

    // If stuck in authenticating and QR not available, stop → it will auto-reconnect via saved creds
    if (status === 'authenticating') {
      try {
        const qr = await OpenWAPairingProvider.getQR(name);
        if (qr.data?.qrCode) return res.json({ connected: false, qrCode: qr.data.qrCode });
      } catch {
        // QR not ready — stop the session so it can reconnect via saved credentials
        await OpenWAPairingProvider.stopSession(name).catch(() => {});
        await new Promise((r) => setTimeout(r, 2000));
        // Re-check — saved credentials often reconnect immediately
        try {
          const r2 = await OpenWAPairingProvider.getStatus(name);
          const s2 = (r2.data?.status || r2.data?.state || '').toLowerCase();
          if (['connected', 'authenticated', 'working', 'ready'].includes(s2)) {
            return res.json({ connected: true });
          }
        } catch {}
      }
      return res.json({ connected: false, pending: true });
    }

    if (!status || ['created', 'stopped', 'disconnected', 'failed'].includes(status)) {
      await OpenWAPairingProvider.startSession(name).catch(() => {});
    }

    try {
      const qr = await OpenWAPairingProvider.getQR(name);
      if (qr.data?.qrCode) return res.json({ connected: false, qrCode: qr.data.qrCode });
    } catch {
      // QR not ready yet — fall through to pending
    }

    // `initializing` means the gateway still holds saved credentials and is
    // reconnecting the SAME number — no QR will ever be offered in this state.
    // Reporting it distinctly stops the UI spinning on "preparing link code"
    // forever and lets it explain what is actually happening.
    res.json({
      connected: false,
      pending: true,
      state: status || 'unknown',
      reconnecting: status === 'initializing',
    });
  } catch (error) {
    logger.error('Session QR request failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

const WH_INCLUDE = { outOfHoursTemplate: true, welcomeTemplate: true } as const;

// GET /api/system/working-hours
router.get('/working-hours', async (_req, res) => {
  try {
    const row = await getWorkingHoursConfig();
    res.json({ ...row, isOpenNow: isWithinWorkingHours(row) });
  } catch (error) {
    logger.error('Working hours load failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/system/working-hours
router.patch('/working-hours', async (req, res) => {
  try {
    const { enabled, autoReplyEnabled, timezone, workDays, startTime, endTime, outOfHoursTemplateId, welcomeTemplateId } = req.body;
    await getWorkingHoursConfig();
    const row = await prisma.workingHours.update({
      where: { organizationId: req.user!.organizationId },
      data: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(autoReplyEnabled !== undefined ? { autoReplyEnabled } : {}),
        ...(timezone !== undefined ? { timezone } : {}),
        ...(workDays !== undefined ? { workDays } : {}),
        ...(startTime !== undefined ? { startTime } : {}),
        ...(endTime !== undefined ? { endTime } : {}),
        ...(outOfHoursTemplateId !== undefined
          ? { outOfHoursTemplateId: outOfHoursTemplateId || null }
          : {}),
        ...(welcomeTemplateId !== undefined
          ? { welcomeTemplateId: welcomeTemplateId || null }
          : {}),
      },
      include: WH_INCLUDE,
    });
    res.json({ ...row, isOpenNow: isWithinWorkingHours(row) });
  } catch (error) {
    logger.error('Working hours update failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/system/keywords — list custom keywords (grouped by category)
router.get('/keywords', async (_req, res) => {
  try {
    const rows = await prisma.keyword.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ categories: KEYWORD_CATEGORIES, keywords: rows });
  } catch (error) {
    logger.error('Keyword list failed', { error: error instanceof Error ? error.stack : String(error) });
    res.status(500).json({ error: 'فشل جلب الكلمات المفتاحية' });
  }
});

// POST /api/system/keywords — add a custom keyword
router.post('/keywords', requireSupervisor, async (req, res) => {
  const organizationId = req.user!.organizationId;
  const { category, phrase } = req.body as { category?: string; phrase?: string };
  if (!category || !phrase?.trim()) {
    return res.status(400).json({ error: 'الفئة والكلمة مطلوبتان' });
  }
  if (!(KEYWORD_CATEGORIES as readonly string[]).includes(category)) {
    return res.status(400).json({ error: 'فئة غير صالحة' });
  }
  try {
    const row = await prisma.keyword.create({
      data: { organizationId, category, phrase: phrase.trim(), createdBy: req.user!.id },
    });
    invalidateCustomKeywords();
    res.status(201).json(row);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'الكلمة موجودة بالفعل' });
    logger.error('Keyword creation failed', { error: err instanceof Error ? err.stack : String(err) });
    res.status(500).json({ error: 'فشل إضافة الكلمة' });
  }
});

// DELETE /api/system/keywords/:id — remove a custom keyword
router.delete('/keywords/:id', requireSupervisor, async (req, res) => {
  try {
    await prisma.keyword.delete({ where: { id: req.params.id } });
    invalidateCustomKeywords();
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'الكلمة غير موجودة' });
  }
});

export default router;
