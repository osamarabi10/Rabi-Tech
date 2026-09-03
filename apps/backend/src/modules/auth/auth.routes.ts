import { Router } from 'express';
import type { Identity } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { defaultWorkspaceIdFor } from '../../lib/workspace-provisioning';
import { randomUUID } from 'crypto';
import { prisma } from '../../prisma';
import { verifyToken } from './auth.middleware';
import { permissionsForRole, permissionsForUser } from '../../middleware/rbac.middleware';
import { getIO } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import logger from '../../lib/logger';
import { queueMail } from '../mail/mail.service';
import { notifyAssigned } from '../../utils/notification-service';
import { runAsPlatform, runAsOrganization } from '../../lib/tenant-context';
import { encryptCredential } from '../../lib/credential-crypto';
import {
  buildTwoFactorSetup,
  consumeLoginSecondFactor,
  createLoginChallenge,
  generateRecoveryCodes,
  TwoFactorError,
  consumeExistingFactor,
  verifySetupChallenge,
  verifyTotp,
} from './two-factor.service';
import { acceptUserInvitation, inspectUserInvitation } from '../system/user-invitations.service';

const router = Router();

router.get('/invitations/:token', async (req, res) => {
  try {
    const invitation = await inspectUserInvitation(String(req.params.token || ''));
    if (!invitation) return res.status(404).json({ error: 'Invitation is invalid or expired' });
    return res.json({
      email: invitation.email,
      name: invitation.name,
      role: invitation.role,
      invitedByName: invitation.invitedByName,
      expiresAt: invitation.expiresAt,
      workspaceName: invitation.organization.name,
      teamName: invitation.primaryTeam?.name ?? null,
      requiresExistingPassword: invitation.requiresExistingPassword,
    });
  } catch {
    return res.status(404).json({ error: 'Invitation is invalid or expired' });
  }
});

router.post('/invitations/:token/accept', async (req, res) => {
  try {
    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: 'Password is required' });
    const user = await acceptUserInvitation(String(req.params.token || ''), password, req.body?.name);
    return res.status(201).json({ accepted: true, user });
  } catch (error) {
    const message = String((error as Error).message || error);
    const status = message.includes('seat') || message.includes('allows') ? 402 : 400;
    return res.status(status).json({ error: message });
  }
});

async function completeIdentityLogin(identity: Identity) {
  if (identity.platformRole === 'OWNER' || identity.platformRole === 'SUPPORT') {
    if (identity.platformDisabledAt) {
      return { status: 403, body: { error: 'This staff account is disabled' } };
    }
    const token = jwt.sign(
      {
        scope: 'PLATFORM',
        id: identity.id,
        email: identity.email,
        platformRole: identity.platformRole,
      },
      process.env.JWT_SECRET!,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
    );
    return {
      status: 200,
      body: {
        token,
        scope: 'PLATFORM',
        user: {
          id: identity.id,
          email: identity.email,
          name: 'RabiTech',
          platformRole: identity.platformRole,
          // For rendering only — the console shell filters its navigation with
          // this so a support user is not shown destinations that will refuse
          // them. Authorization stays server-side in platform.routes.ts, which
          // re-reads permissions from the database on every request.
          platformPermissions: identity.platformPermissions,
          scope: 'PLATFORM',
        },
      },
    };
  }

  const memberships = await runAsPlatform('login-memberships', async () =>
    prisma.user.findMany({
      where: { identityId: identity.id, isActive: true },
      select: {
        id: true,
        organizationId: true,
        name: true,
        organization: { select: { name: true, slug: true, status: true } },
      },
    }),
  );
  if (memberships.length === 0) {
    return { status: 401, body: { error: 'No organization membership' } };
  }

  const membership = memberships[0];
  if (membership.organization.status !== 'ACTIVE') {
    return { status: 403, body: { error: 'Organization is not active' } };
  }
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
    }),
  );
  if (!user) return { status: 401, body: { error: 'User not found' } };

  const sessionId = randomUUID();
  await runAsOrganization(membership.organizationId, () =>
    prisma.authSession.create({
      data: {
        id: sessionId,
        organizationId: membership.organizationId,
        userId: user.id,
      },
    }),
  );

  const token = jwt.sign(
    {
      scope: 'ORGANIZATION',
      id: user.id,
      email: identity.email,
      primaryTeamId: user.primaryTeamId,
      teamIds: user.teams.map((team) => team.teamId),
      name: user.name,
      role: user.role,
      organizationId: membership.organizationId,
      // The default workspace at login. Switching mints a new token through
      // POST /api/workspaces/:id/activate, which is the only other place this
      // claim is ever set.
      workspaceId: defaultWorkspaceIdFor(membership.organizationId),
      tokenVersion: user.tokenVersion,
      sessionId,
    },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
  );
  return {
    status: 200,
    body: {
      token,
      scope: 'ORGANIZATION',
      user: {
        id: user.id,
        name: user.name,
        email: identity.email,
        primaryTeamId: user.primaryTeamId,
        primaryTeam: user.primaryTeam,
        teamIds: user.teams.map((team) => team.teamId),
        role: user.role,
        organizationId: membership.organizationId,
        organization: membership.organization,
        scope: 'ORGANIZATION',
      },
    },
  };
}

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

    if (identity.totpSecretEnc && identity.totpEnabledAt) {
      const challenge = await runAsPlatform('two-factor-login-challenge', () =>
        createLoginChallenge(identity.id),
      );
      return res.status(202).json({ requiresTwoFactor: true, ...challenge });
    }

    const result = await completeIdentityLogin(identity);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/2fa/login', async (req, res) => {
  const challengeToken = String(req.body?.challengeToken || '');
  const code = String(req.body?.code || '');
  if (!challengeToken || !code) {
    return res.status(400).json({ error: 'Verification code and challenge are required' });
  }
  try {
    const identity = await runAsPlatform('two-factor-login-verify', () =>
      consumeLoginSecondFactor(challengeToken, code),
    );
    const result = await completeIdentityLogin(identity);
    return res.status(result.status).json(result.body);
  } catch (error) {
    if (error instanceof TwoFactorError) {
      logger.warn('two-factor login rejected', { reason: error.message, requestId: (req as any).id });
      return res.status(401).json({ error: 'Invalid or expired verification code' });
    }
    logger.error('two-factor login failed', { error: String(error), requestId: (req as any).id });
    return res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
/**
 * Change your own password.
 *
 * Needs the current one even though the caller is already authenticated. A
 * signed-in session is not proof that the person at the keyboard is the
 * account holder — an unlocked laptop is the ordinary case this defends
 * against, and it costs a legitimate user one field they already know.
 *
 * This is the half of credential self-service that works without mail. The
 * other half — a reset for somebody who has forgotten it — needs a message to
 * reach them, which needs a mail provider.
 */
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');

    if (next.length < 8) {
      return res.status(400).json({ error: 'كلمة السر لازم تكون ٨ أحرف على الأقل' });
    }
    if (next === current) {
      return res.status(400).json({ error: 'كلمة السر الجديدة لازم تكون غير القديمة' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true, identityId: true, identity: { select: { passwordHash: true, email: true } } },
    });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });

    const valid = await bcrypt.compare(current, user.identity.passwordHash);
    if (!valid) {
      logger.warn('password change rejected: wrong current password', {
        userId: user.id,
        requestId: (req as any).id,
      });
      return res.status(403).json({ error: 'كلمة السر الحالية غلط' });
    }

    /*
     * Everything else this identity is signed into stops working.
     *
     * Changing a password is what somebody does when they think another
     * person has it. Leaving that person's existing sessions alive is the one
     * outcome the change was meant to prevent — so tokenVersion moves and
     * every issued token becomes invalid, on every device including this one.
     */
    await runAsPlatform('password-change-all-memberships', () =>
      prisma.$transaction(async (tx) => {
        await tx.identity.update({
          where: { id: user.identityId },
          data: { passwordHash: await bcrypt.hash(next, 10) },
        });
        await tx.user.updateMany({
          where: { identityId: user.identityId },
          data: { tokenVersion: { increment: 1 } },
        });
      }),
    );

    // Told, not just done. A password that changes without a notice is
    // indistinguishable from one that was taken.
    await queueMail({
      to: user.identity.email,
      kind: 'security.password-changed',
      subject: 'Your RabiTech password was changed',
      body: [
        'Hello,',
        '',
        'The password for your RabiTech account was just changed, and every',
        'device that was signed in has been signed out.',
        '',
        'If this was not you, contact your workspace administrator immediately.',
      ].join(String.fromCharCode(10)),
    });

    logger.info('password changed', { userId: user.id });
    res.json({ ok: true, signedOutEverywhere: true });
  } catch (error) {
    logger.error('password change failed', { error: String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'تعذّر تغيير كلمة السر' });
  }
});

async function currentIdentity(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: {
      identityId: true,
      identity: {
        select: {
          id: true,
          email: true,
          passwordHash: true,
          totpEnabledAt: true,
        },
      },
    },
  });
}

router.post('/me/2fa/setup', verifyToken, async (req, res) => {
  if (req.platformUser) return res.status(403).json({ error: 'Subscriber security settings are read-only in platform view' });
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const user = await currentIdentity(req.user!.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.identity.passwordHash))) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    if (user.identity.totpEnabledAt) {
      return res.status(409).json({ error: 'Two-factor authentication is already enabled' });
    }
    return res.json(await buildTwoFactorSetup(user.identity.id, user.identity.email));
  } catch (error) {
    logger.error('two-factor setup failed', { error: String(error), requestId: (req as any).id });
    return res.status(500).json({ error: 'Could not start two-factor setup' });
  }
});

router.post('/me/2fa/enable', verifyToken, async (req, res) => {
  if (req.platformUser) return res.status(403).json({ error: 'Subscriber security settings are read-only in platform view' });
  try {
    const setupToken = String(req.body?.setupToken || '');
    const code = String(req.body?.code || '').trim();
    const user = await currentIdentity(req.user!.id);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (user.identity.totpEnabledAt) {
      return res.status(409).json({ error: 'Two-factor authentication is already enabled' });
    }
    const secret = verifySetupChallenge(setupToken, user.identity.id);
    if (!verifyTotp(code, secret)) {
      return res.status(400).json({ error: 'Verification code is invalid' });
    }

    const recoveryCodes = generateRecoveryCodes();
    await runAsPlatform('two-factor-enable-all-memberships', () =>
      prisma.$transaction(async (tx) => {
        await tx.identity.update({
          where: { id: user.identity.id },
          data: {
            totpSecretEnc: encryptCredential(secret),
            totpEnabledAt: new Date(),
            totpLastUsedCounter: null,
          },
        });
        await tx.identityRecoveryCode.deleteMany({ where: { identityId: user.identity.id } });
        await tx.identityRecoveryCode.createMany({
          data: recoveryCodes.map(({ codeHash }) => ({ identityId: user.identity.id, codeHash })),
        });
        await tx.twoFactorChallenge.deleteMany({ where: { identityId: user.identity.id } });
        await tx.user.updateMany({
          where: { identityId: user.identity.id },
          data: { tokenVersion: { increment: 1 } },
        });
      }),
    );

    await queueMail({
      to: user.identity.email,
      kind: 'security.two-factor-enabled',
      subject: 'Two-factor authentication enabled for RabiTech',
      body: 'Two-factor authentication was enabled for your RabiTech account. If this was not you, contact your workspace administrator immediately.',
    });
    return res.json({
      enabled: true,
      recoveryCodes: recoveryCodes.map(({ code: recoveryCode }) => recoveryCode),
      signedOutEverywhere: true,
    });
  } catch (error) {
    if (error instanceof TwoFactorError) return res.status(400).json({ error: error.message });
    logger.error('two-factor enable failed', { error: String(error), requestId: (req as any).id });
    return res.status(500).json({ error: 'Could not enable two-factor authentication' });
  }
});

router.delete('/me/2fa', verifyToken, async (req, res) => {
  if (req.platformUser) return res.status(403).json({ error: 'Subscriber security settings are read-only in platform view' });
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const code = String(req.body?.code || '');
    const user = await currentIdentity(req.user!.id);
    if (!user || !(await bcrypt.compare(currentPassword, user.identity.passwordHash))) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    if (!user.identity.totpEnabledAt) {
      return res.status(409).json({ error: 'Two-factor authentication is not enabled' });
    }
    if (!(await consumeExistingFactor(user.identity.id, code))) {
      return res.status(400).json({ error: 'Verification code is invalid' });
    }

    await runAsPlatform('two-factor-disable-all-memberships', () =>
      prisma.$transaction(async (tx) => {
        await tx.identity.update({
          where: { id: user.identity.id },
          data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedCounter: null },
        });
        await tx.identityRecoveryCode.deleteMany({ where: { identityId: user.identity.id } });
        await tx.twoFactorChallenge.deleteMany({ where: { identityId: user.identity.id } });
        await tx.user.updateMany({
          where: { identityId: user.identity.id },
          data: { tokenVersion: { increment: 1 } },
        });
      }),
    );
    await queueMail({
      to: user.identity.email,
      kind: 'security.two-factor-disabled',
      subject: 'Two-factor authentication disabled for RabiTech',
      body: 'Two-factor authentication was disabled for your RabiTech account. If this was not you, contact your workspace administrator immediately.',
    });
    return res.json({ enabled: false, signedOutEverywhere: true });
  } catch (error) {
    logger.error('two-factor disable failed', { error: String(error), requestId: (req as any).id });
    return res.status(500).json({ error: 'Could not disable two-factor authentication' });
  }
});

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
        permissions: permissionsForRole('VIEWER'),
        platformRole: req.platformUser.platformRole,
        // See the login payload: navigation rendering only, never the boundary.
        platformPermissions: req.platformUser.platformPermissions,
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
        avatarUrl: true,
        locale: true,
        theme: true,
        notificationNewMessage: true,
        notificationAssignment: true,
        notificationMention: true,
        notificationResolution: true,
        notificationEscalation: true,
        notificationSound: true,
        onboardingLifecycleComplete: true,
        restrictContactVisibility: true,
        contactVisibilityScope: true,
        restrictCalls: true,
        restrictWorkflows: true,
        // Selected because permissionsForUser below subtracts them from the
        // role. Omitting one here would silently hand the client a permission
        // the server then refuses — the sidebar would offer a page that 403s,
        // which is the exact failure the derived-permissions design exists to
        // prevent.
        restrictDataExport: true,
        restrictContactDeletion: true,
        restrictWorkspaceSettings: true,
        restrictIntegrations: true,
        maskPhoneAndEmail: true,
        isAway: true,
        organizationId: true,
        identity: { select: { email: true, totpEnabledAt: true } },
      },
    });

    // Sent alongside the role rather than instead of it: the client shows the
    // role and decides from the permissions, and those are two different
    // questions.
    res.json(user && {
      ...user,
      email: user.identity.email,
      twoFactorEnabled: !!user.identity.totpEnabledAt,
      identity: undefined,
      permissions: permissionsForUser(user.role, user),
    });
  } catch (err) {
    logger.error('Current user fetch failed', { error: err instanceof Error ? err.stack : String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PATCH /api/auth/me/away — toggle agent away mode
router.patch('/me', verifyToken, async (req, res) => {
  try {
    if (req.platformUser) {
      return res.status(403).json({ error: 'Subscriber profiles are read-only in platform view' });
    }
    const data: {
      name?: string;
      phone?: string | null;
      avatarUrl?: string | null;
      locale?: string;
      theme?: string;
      onboardingLifecycleComplete?: boolean;
    } = {};

    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (name.length < 2 || name.length > 80) {
        return res.status(400).json({ error: 'Name must be between 2 and 80 characters' });
      }
      data.name = name;
    }
    if (req.body?.phone !== undefined) {
      const phone = String(req.body.phone || '').trim();
      if (phone && !/^\+?[0-9][0-9\s-]{5,24}$/.test(phone)) {
        return res.status(400).json({ error: 'Phone number is invalid' });
      }
      data.phone = phone || null;
    }
    if (req.body?.avatarUrl !== undefined) {
      const avatarUrl = String(req.body.avatarUrl || '').trim();
      if (avatarUrl) {
        try {
          const parsed = new URL(avatarUrl);
          if (parsed.protocol !== 'https:') throw new Error('protocol');
        } catch {
          return res.status(400).json({ error: 'Avatar URL must use HTTPS' });
        }
      }
      data.avatarUrl = avatarUrl || null;
    }
    if (req.body?.locale !== undefined) {
      const locale = String(req.body.locale);
      if (!['ar', 'he', 'en'].includes(locale)) return res.status(400).json({ error: 'Locale is invalid' });
      data.locale = locale;
    }
    if (req.body?.theme !== undefined) {
      const theme = String(req.body.theme);
      if (!['light', 'dark', 'system'].includes(theme)) return res.status(400).json({ error: 'Theme is invalid' });
      data.theme = theme;
    }
    if (req.body?.onboardingLifecycleComplete !== undefined) {
      if (typeof req.body.onboardingLifecycleComplete !== 'boolean') {
        return res.status(400).json({ error: 'Onboarding lifecycle completion must be a boolean' });
      }
      data.onboardingLifecycleComplete = req.body.onboardingLifecycleComplete;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No profile fields supplied' });

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: {
        id: true,
        name: true,
        phone: true,
        avatarUrl: true,
        locale: true,
        theme: true,
        onboardingLifecycleComplete: true,
        isAway: true,
        organizationId: true,
        identity: { select: { email: true, totpEnabledAt: true } },
      },
    });
    res.json({
      ...user,
      email: user.identity.email,
      twoFactorEnabled: !!user.identity.totpEnabledAt,
      identity: undefined,
    });
  } catch (error) {
    logger.error('profile update failed', { error: String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

router.patch('/me/notification-preferences', verifyToken, async (req, res) => {
  try {
    if (req.platformUser) {
      return res.status(403).json({ error: 'Subscriber preferences are read-only in platform view' });
    }
    const deliveryFields = [
      'notificationNewMessage',
      'notificationAssignment',
      'notificationMention',
      'notificationResolution',
      'notificationEscalation',
    ] as const;
    const data: Partial<Record<(typeof deliveryFields)[number], 'IN_APP' | 'OFF'>> & {
      notificationSound?: boolean;
    } = {};
    for (const field of deliveryFields) {
      if (req.body?.[field] === undefined) continue;
      if (!['IN_APP', 'OFF'].includes(req.body[field])) {
        return res.status(400).json({ error: `${field} is invalid` });
      }
      data[field] = req.body[field];
    }
    if (req.body?.notificationSound !== undefined) {
      if (typeof req.body.notificationSound !== 'boolean') {
        return res.status(400).json({ error: 'notificationSound must be boolean' });
      }
      data.notificationSound = req.body.notificationSound;
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'No notification preferences supplied' });

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data,
      select: {
        notificationNewMessage: true,
        notificationAssignment: true,
        notificationMention: true,
        notificationResolution: true,
        notificationEscalation: true,
        notificationSound: true,
      },
    });
    res.json(user);
  } catch (error) {
    logger.error('notification preferences update failed', { error: String(error), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to update notification preferences' });
  }
});

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
    logger.error('Away status update failed', { error: err instanceof Error ? err.stack : String(err), requestId: (req as any).id });
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
    await prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    res.json({ message: 'All sessions logged out' });
  } catch (err) {
    logger.error('Logout-all failed', { error: err instanceof Error ? err.stack : String(err), requestId: (req as any).id });
    res.status(500).json({ error: 'Failed to logout from all sessions' });
  }
});

export default router;
