import { Router } from 'express';
import { prisma } from '../../prisma';
import { verifyToken } from '../auth/auth.middleware';
import { OpenWAPairingProvider, OpenWAService } from '../whatsapp/openwa.service';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { isWithinWorkingHours } from '../../utils/working-hours';
import { requireAdmin, requireSupervisor } from '../../middleware/rbac.middleware';
import { KEYWORD_CATEGORIES, invalidateCustomKeywords } from '../../constants/keywords';
import { getWorkingHoursConfig } from '../../utils/out-of-hours';
import { reconcileSessionWebhook } from '../../utils/webhook-reconcile';
import {
  getOrganizationConfig,
  getPrimarySession,
  inboxConfig,
  invalidateOrganizationConfig,
} from '../../utils/whatsapp-sessions';
import {
  isQuotaExceededError,
  quotaErrorResponse,
  assertSeatAvailable,
  isSeatLimitError,
  seatLimitResponse,
} from '../usage/entitlements';
import { resolveTeamId } from '../../utils/teams';
import logger from '../../lib/logger';
import { auditLog } from '../../lib/audit';

const router = Router();
router.use(verifyToken);

async function findSessionByName(organizationId: string, sessionName: string) {
  return prisma.whatsappSession.findUnique({
    where: { organizationId_sessionName: { organizationId, sessionName } },
  });
}

// GET /api/system/teams - organization teams
router.get('/teams', async (_req, res) => {
  try {
    const teams = await prisma.team.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        _count: { select: { members: true, conversations: true, sessions: true } },
      },
    });
    res.json(teams);
  } catch {
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

    if (!normalizedName || !normalizedSlug) {
      return res.status(400).json({ error: 'اسم الفريق مطلوب' });
    }

    const team = await prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.team.updateMany({ data: { isDefault: false } });
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

    res.status(201).json(team);
  } catch (err: any) {
    if (err?.code === 'P2002') return res.status(409).json({ error: 'رابط الفريق مستخدم' });
    res.status(500).json({ error: 'فشل إنشاء الفريق' });
  }
});

// PATCH /api/system/teams/:id - update team (admin only)
router.patch('/teams/:id', requireAdmin, async (req, res) => {
  try {
    const { name, slug, description, color, emoji, isDefault,
            assignmentStrategy, maxConcurrentPerAgent } = req.body;
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = String(name).trim();
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
      data.slug = String(slug)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    }
    if (description !== undefined) data.description = description?.trim() || null;
    if (color !== undefined) data.color = color || '#6366F1';
    if (emoji !== undefined) data.emoji = emoji?.trim() || null;
    if (isDefault !== undefined) data.isDefault = Boolean(isDefault);

    const team = await prisma.$transaction(async (tx) => {
      if (data.isDefault === true) {
        await tx.team.updateMany({
          where: { id: { not: req.params.id } },
          data: { isDefault: false },
        });
      }
      return tx.team.update({ where: { id: req.params.id }, data });
    });

    res.json(team);
  } catch (err: any) {
    if (err?.code === 'P2025') return res.status(404).json({ error: 'الفريق غير موجود' });
    if (err?.code === 'P2002') return res.status(409).json({ error: 'رابط الفريق مستخدم' });
    res.status(500).json({ error: 'فشل تحديث الفريق' });
  }
});

// DELETE /api/system/teams/:id - remove unused team (admin only)
router.delete('/teams/:id', requireAdmin, async (req, res) => {
  try {
    const team = await prisma.team.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { members: true, conversations: true, sessions: true } } },
    });
    if (!team) return res.status(404).json({ error: 'الفريق غير موجود' });
    if (team.isDefault) return res.status(400).json({ error: 'لا يمكن حذف الفريق الافتراضي' });
    if (team._count.members || team._count.conversations || team._count.sessions) {
      return res.status(409).json({ error: 'الفريق مستخدم، انقل العناصر قبل الحذف' });
    }
    await prisma.team.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'فشل حذف الفريق' });
  }
});

// GET /api/system/stats — overview dashboard numbers
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
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/system/users?all=true - team members / user management
router.get('/users', async (req, res) => {
  try {
    const { all } = req.query;
    const users = await prisma.user.findMany({
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
        createdAt: true,
        identity: { select: { email: true } },
      },
      orderBy: { name: 'asc' },
    });
    // Map identity.email to email field to maintain same API structure
    const mapped = users.map((u) => ({
      ...u,
      email: u.identity.email,
      identity: undefined,
    }));
    res.json(mapped);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/system/users — create user (admin only)
router.post('/users', requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: 'فشل إنشاء المستخدم' });
  }
});

// PATCH /api/system/users/:id — update user (admin only)
router.patch('/users/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role, phone, isActive, primaryTeamId, teamIds } = req.body;
    
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

    res.json({
      ...user,
      email: user.identity.email,
      identity: undefined,
    });
  } catch {
    res.status(500).json({ error: 'فشل تحديث المستخدم' });
  }
});

// DELETE /api/system/users/:id — deactivate user (soft delete)
router.delete('/users/:id', requireAdmin, async (req, res) => {
  try {
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
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'فشل تعطيل المستخدم' });
  }
});

// GET /api/system/inbox-config - team-owned WhatsApp sessions
router.get('/inbox-config', async (req, res) => {
  res.json(await inboxConfig(req.user!.organizationId));
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
    const sessions = await prisma.whatsappSession.findMany();
    const withStatus = await Promise.all(
      sessions.map(async (s) => {
        let connected = false;
        let livePhone: string | null = null;
        try {
          const r = await OpenWAService.getStatus(s.sessionName);
          const st = (r.data?.status || r.data?.state || '').toLowerCase();
          connected =
            ['connected', 'authenticated', 'working', 'ready'].includes(st) ||
            r.data?.connected === true;
          livePhone = typeof r.data?.phone === 'string' ? r.data.phone : null;
        } catch {
          // OpenWA unreachable — report disconnected
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
        return { ...s, connected };
      })
    );
    res.json(withStatus);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// WhatsApp group routes removed: RabiTech is a 1:1 conversation platform.

// GET /api/system/sessions/:name/qr — QR code to link a WhatsApp device.
// Creates/starts the OpenWA session as needed; returns { connected } once linked,
// { qrCode } when scannable, or { pending } while the engine is warming up.
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
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

const WH_INCLUDE = { outOfHoursTemplate: true, welcomeTemplate: true } as const;

// GET /api/system/working-hours
router.get('/working-hours', async (_req, res) => {
  try {
    const row = await getWorkingHoursConfig();
    res.json({ ...row, isOpenNow: isWithinWorkingHours(row) });
  } catch {
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
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/system/keywords — list custom keywords (grouped by category)
router.get('/keywords', async (_req, res) => {
  try {
    const rows = await prisma.keyword.findMany({ orderBy: { createdAt: 'asc' } });
    res.json({ categories: KEYWORD_CATEGORIES, keywords: rows });
  } catch {
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
