import { workspaceMemberData } from '../../lib/workspace-provisioning';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../../prisma';
import { runAsOrganization, runAsPlatform } from '../../lib/tenant-context';
import { assertSeatAvailable } from '../usage/entitlements';
import { queueMail } from '../mail/mail.service';

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

function frontendUrl() {
  return (process.env.FRONTEND_PUBLIC_URL || process.env.APP_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueUserInvitation(input: {
  organizationId: string;
  email: string;
  name?: string | null;
  role: 'SUPERVISOR' | 'AGENT' | 'VIEWER' | 'FINANCE';
  primaryTeamId?: string | null;
  invitedByName: string;
}) {
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + INVITATION_LIFETIME_MS);

  const invitation = await runAsOrganization(input.organizationId, async () => {
    if (input.primaryTeamId) {
      const team = await prisma.team.findUnique({ where: { id: input.primaryTeamId }, select: { id: true } });
      if (!team) throw new Error('Team not found');
    }

    const existingMembership = await prisma.user.findFirst({
      where: { identity: { email } },
      select: { id: true },
    });
    if (existingMembership) throw new Error('This email already belongs to the workspace');

    // Reissuing an invitation invalidates the old link immediately. This also
    // clears an expired row before the partial live-email index is evaluated.
    await prisma.userInvitation.updateMany({
      where: { email: { equals: email, mode: 'insensitive' }, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return prisma.userInvitation.create({
      data: {
        organizationId: input.organizationId,
        email,
        name: input.name?.trim() || null,
        role: input.role,
        primaryTeamId: input.primaryTeamId || null,
        tokenHash: hashToken(token),
        invitedByName: input.invitedByName,
        expiresAt,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        primaryTeamId: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  });

  const inviteUrl = `${frontendUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
  await queueMail({
    organizationId: input.organizationId,
    to: email,
    kind: 'workspace.user-invitation',
    subject: 'You are invited to a RabiTech workspace',
    body: `${input.invitedByName} invited you to join their RabiTech workspace.\n\nAccept the invitation: ${inviteUrl}\n\nThis link expires in 7 days.`,
    dedupeKey: `user-invitation:${invitation.id}`,
  });

  return {
    ...invitation,
    // Useful for the local/manual mail provider. Production clients do not
    // need to render it; the same link is in the queued email.
    ...(process.env.NODE_ENV === 'production' ? {} : { inviteUrl }),
  };
}

export async function inspectUserInvitation(token: string) {
  const invitation = await runAsPlatform('inspect-user-invitation', () =>
    prisma.userInvitation.findUnique({
      where: { tokenHash: hashToken(token) },
      select: {
        id: true,
        organizationId: true,
        email: true,
        name: true,
        role: true,
        primaryTeamId: true,
        invitedByName: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        organization: { select: { name: true, status: true } },
        primaryTeam: { select: { name: true } },
      },
    }),
  );
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date()) {
    return null;
  }
  const existingIdentity = await runAsPlatform('inspect-user-invitation-identity', () =>
    prisma.identity.findUnique({ where: { email: invitation.email }, select: { id: true } }),
  );
  return { ...invitation, requiresExistingPassword: !!existingIdentity };
}

export async function acceptUserInvitation(token: string, password: string, suppliedName?: string) {
  const invitation = await inspectUserInvitation(token);
  if (!invitation) throw new Error('Invitation is invalid or expired');

  return runAsOrganization(invitation.organizationId, async () => {
    const live = await prisma.userInvitation.findUnique({ where: { id: invitation.id } });
    if (!live || live.acceptedAt || live.revokedAt || live.expiresAt <= new Date()) {
      throw new Error('Invitation is invalid or expired');
    }

    const identity = await prisma.identity.findUnique({ where: { email: live.email } });
    if (identity) {
      const valid = await bcrypt.compare(password, identity.passwordHash);
      if (!valid) throw new Error('Current account password is incorrect');
      const membership = await prisma.user.findFirst({ where: { identityId: identity.id }, select: { id: true } });
      if (membership) throw new Error('This account already belongs to the workspace');
    } else if (password.length < 10) {
      throw new Error('Password must contain at least 10 characters');
    }

    await assertSeatAvailable();
    const name = String(suppliedName || live.name || live.email.split('@')[0]).trim();
    if (name.length < 2 || name.length > 80) throw new Error('Name must be between 2 and 80 characters');

    const created = await prisma.$transaction(async (tx) => {
      const resolvedIdentity = identity ?? await tx.identity.create({
        data: { email: live.email, passwordHash: await bcrypt.hash(password, 10) },
      });
      const user = await tx.user.create({
        data: {
          organizationId: live.organizationId,
          identityId: resolvedIdentity.id,
          name,
          role: live.role,
          primaryTeamId: live.primaryTeamId,
        },
        select: { id: true, name: true, role: true, organizationId: true },
      });
      if (live.primaryTeamId) {
        await tx.userTeam.create({
          data: {
            organizationId: live.organizationId,
            userId: user.id,
            teamId: live.primaryTeamId,
          },
        });
      }
      /*
        Every new user joins the default workspace immediately.
      
        Login mints a workspace claim and verifyToken refuses a claim the user has
        no membership for, so a user created without this row is not partially
        configured — they are locked out of every request by a 403 naming a
        workspace they have never heard of. The tenancy harness found exactly
        that, on a fixture user created after the backfill.
      
        The default workspace only. Membership of any other is a deliberate act
        and belongs with the management UI, which is not in this commit.
      */
      await tx.workspaceMember.create({
        data: workspaceMemberData(live.organizationId, user.id, user.role),
      });

      await tx.userInvitation.update({ where: { id: live.id }, data: { acceptedAt: new Date() } });
      return user;
    });
    return created;
  });
}
