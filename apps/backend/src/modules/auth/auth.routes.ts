import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { verifyToken } from './auth.middleware';
import { getIO } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import { notifyAssigned } from '../../utils/notification-service';
import { runAsPlatform, runAsOrganization } from '../../lib/tenant-context';

const router = Router();

// POST /api/auth/login
// After schema migration: email lookup is now on Identity table (global), user is org-scoped
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Look up by global email (Identity table)
    const normalizedEmail = email.trim().toLowerCase();
    const identity = await runAsPlatform('login', async () =>
      prisma.identity.findUnique({ where: { email: normalizedEmail } })
    );
    if (!identity) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password
    const valid = await bcrypt.compare(password, identity.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (identity.platformRole === 'OWNER' || identity.platformRole === 'SUPPORT') {
      const token = jwt.sign(
        {
          scope: 'PLATFORM',
          id: identity.id,
          email: identity.email,
          platformRole: identity.platformRole,
        },
        process.env.JWT_SECRET!,
        {
          expiresIn:
            (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
        }
      );

      return res.json({
        token,
        scope: 'PLATFORM',
        user: {
          id: identity.id,
          email: identity.email,
          name: 'RabiTech',
          platformRole: identity.platformRole,
          scope: 'PLATFORM',
        },
      });
    }

    // Find user memberships for this identity
    const memberships = await runAsPlatform('login-memberships', async () =>
      prisma.user.findMany({
        where: { identityId: identity.id, isActive: true },
        select: {
          id: true,
          organizationId: true,
          name: true,
          organization: { select: { name: true, slug: true, status: true } },
        },
      })
    );

    if (memberships.length === 0) {
      return res.status(401).json({ error: 'No organization membership' });
    }

    // Use first membership (TODO: In Phase 2, add org picker)
    const membership = memberships[0];
    if (membership.organization.status !== 'ACTIVE') {
      return res.status(403).json({ error: 'Organization is not active' });
    }

    // Fetch full user details in org context
    const user = await runAsOrganization(membership.organizationId, async () =>
      prisma.user.findUnique({
        where: { id: membership.id },
        select: {
          id: true,
          name: true,
          primaryTeamId: true,
          primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
          teams: { select: { teamId: true } },
          role: true,
          phone: true,
          tokenVersion: true,
        },
      })
    );

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Sign JWT with organizationId (CRITICAL for tenant scoping)
    const token = jwt.sign(
      {
        scope: 'ORGANIZATION',
        id: user.id,
        email: normalizedEmail,
        primaryTeamId: user.primaryTeamId,
        teamIds: user.teams.map((team) => team.teamId),
        name: user.name,
        role: user.role,
        organizationId: membership.organizationId, // CRITICAL: enables tenant context at request time
        tokenVersion: user.tokenVersion,
      },
      process.env.JWT_SECRET!,
      {
        expiresIn:
          (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'],
      }
    );

    res.json({
      token,
      scope: 'ORGANIZATION',
      user: {
        id: user.id,
        name: user.name,
        email: normalizedEmail,
        primaryTeamId: user.primaryTeamId,
        primaryTeam: user.primaryTeam,
        teamIds: user.teams.map((team) => team.teamId),
        role: user.role,
        organizationId: membership.organizationId,
        organization: membership.organization,
        scope: 'ORGANIZATION',
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    // A platform user viewing a subscriber has no User row in that org. Return
    // their platform identity rather than null, so the client keeps knowing who
    // it is signed in as and can still offer the way back out.
    if (req.platformUser) {
      return res.json({
        id: req.platformUser.id,
        name: req.platformUser.email,
        email: req.platformUser.email,
        role: 'VIEWER',
        platformRole: req.platformUser.platformRole,
        scope: 'PLATFORM',
        viewingOrganizationId: req.user!.organizationId,
        readOnly: true,
        primaryTeamId: null,
        primaryTeam: null,
        teams: [],
        isAway: false,
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        name: true,
        primaryTeamId: true,
        primaryTeam: { select: { id: true, name: true, slug: true, color: true } },
        teams: { select: { teamId: true } },
        role: true,
        phone: true,
        isAway: true,
        organizationId: true,
      },
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /api/auth/me/away — toggle agent away mode
router.patch('/me/away', verifyToken, async (req, res) => {
  try {
    const userId = req.user!.id;
    const away: boolean = !!req.body.away;

    await prisma.user.update({
      where: { id: userId },
      data: { isAway: away, awayAt: away ? new Date() : null },
    });

    if (away) {
      const current = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          primaryTeamId: true,
          teams: { select: { teamId: true } },
        },
      });
      const teamIds = Array.from(
        new Set([
          current?.primaryTeamId,
          ...(current?.teams.map((team) => team.teamId) || []),
        ].filter(Boolean)),
      ) as string[];

      // Find another available teammate to take over.
      const replacement = await prisma.user.findFirst({
        where: {
          isActive: true,
          isAway: false,
          id: { not: userId },
          role: { in: ['ADMIN', 'SUPERVISOR', 'AGENT'] },
          ...(teamIds.length
            ? {
                OR: [
                  { primaryTeamId: { in: teamIds } },
                  { teams: { some: { teamId: { in: teamIds } } } },
                ],
              }
            : {}),
        },
        orderBy: { updatedAt: 'asc' },
      });

      // Reassign open/pending conversations to replacement (or unassign)
      const convs = await prisma.conversation.findMany({
        where: {
          assignedToId: userId,
          status: { in: ['OPEN', 'PENDING', 'AWAITING_CLIENT'] },
        },
        select: { id: true },
      });

      for (const conv of convs) {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { assignedToId: replacement?.id ?? null },
        });
        if (replacement) {
          notifyAssigned(conv.id, replacement.id, `${req.user!.name} (غياب)`).catch(
            () => {}
          );
        }
      }
    }

    getIO().to(socketRoom.organization(req.user!.organizationId)).emit('user_status', {
        userId,
        away,
        name: req.user!.name,
      });

    res.json({ isAway: away });
  } catch (err) {
    res.status(500).json({ error: 'فشل تحديث حالة الغياب' });
  }
});

// POST /api/auth/logout-all — invalidate all tokens for this user
router.post('/logout-all', verifyToken, async (req, res) => {
  try {
    const userId = req.user!.id;

    // Increment tokenVersion to invalidate all tokens
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    res.json({ message: 'All sessions logged out' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to logout from all sessions' });
  }
});

export default router;
