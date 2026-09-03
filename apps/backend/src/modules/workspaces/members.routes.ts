/**
 * Workspace membership: who belongs to a workspace, and as what.
 *
 * Mounted under /api/workspaces by workspaces.routes.ts.
 *
 * ## Which role governs, and which does not
 *
 * `WorkspaceMember.role` governs **membership management of that workspace and
 * nothing else**. Every other permission in this product still comes from
 * `User.role` through `requirePermission`.
 *
 * That boundary is deliberate and it is the whole reason this file can ship. A
 * per-workspace role that governed nothing would be a control that lies: a user
 * displayed as VIEWER in a workspace while holding full ADMIN powers there.
 * Rewiring RBAC to consult the workspace role app-wide is a much larger change
 * — every requirePermission call site, every gate — and it is its own commit.
 * Until then the role is real for exactly one thing, and the tenancy harness
 * asserts that this file actually reads it, so it cannot quietly become
 * decorative.
 *
 * ## The organization-admin override
 *
 * An organization ADMIN may manage membership of a workspace they are not a
 * member of. Without it, an admin can create a workspace, set themselves
 * VIEWER, and be locked out of a workspace nobody can now administer — a state
 * recoverable only by editing the database.
 *
 * It is scoped to make it defensible rather than merely convenient:
 *
 * - **Membership only, never data.** The override decides who belongs. It does
 *   not grant a single contact, conversation or message — those still require
 *   membership, because the scope extension resolves them from the claim and
 *   this endpoint does not touch the claim.
 * - **Every override action is audited as an override**, with its own action
 *   name, so it is distinguishable from the same action taken by a member. An
 *   escape hatch nobody can see is indistinguishable from a hole.
 *
 * The privacy case is the reason for both conditions: a client workspace in an
 * agency account should not silently acquire an organization administrator.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { auditLog } from '../../lib/audit';
import { defaultWorkspaceIdFor } from '../../lib/workspace-provisioning';
import { runAsOrganization } from '../../lib/tenant-context';
import logger from '../../lib/logger';

const router = Router({ mergeParams: true });

type Access =
  | { ok: true; via: 'member'; role: string }
  | { ok: true; via: 'override' }
  | { ok: false; status: number; error: string; message: string };

/**
 * May this caller manage membership of this workspace, and by what authority?
 *
 * Returns HOW rather than just whether, because the two paths are audited
 * differently and the UI has to say which one the user is on.
 */
async function resolveAccess(workspaceId: string, req: any): Promise<Access> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: req.user.id },
    // The role is READ here, not merely selected for existence. This is the
    // line the harness asserts: without it the workspace role governs nothing
    // and the editor in the UI is a lie.
    select: { role: true },
  });

  if (membership) {
    if (membership.role !== 'ADMIN') {
      return {
        ok: false,
        status: 403,
        error: 'not_workspace_admin',
        message: 'لازم تكون أدمن بهذي المساحة عشان تعدّل الأعضاء.',
      };
    }
    return { ok: true, via: 'member', role: membership.role };
  }

  if (req.user.role === 'ADMIN') return { ok: true, via: 'override' };

  return {
    ok: false,
    status: 403,
    error: 'not_a_member',
    message: 'إنت مش عضو بهذي المساحة.',
  };
}

/** Organization-scoped, so an id from another tenant resolves to nothing. */
async function loadWorkspace(id: string) {
  return prisma.workspace.findFirst({
    where: { id },
    select: { id: true, name: true, isDefault: true },
  });
}

/**
 * The members of a workspace, plus the organization users who could be added.
 *
 * Both halves in one response on purpose: the add control needs the candidate
 * list, and fetching it separately would let the two disagree about who is
 * already a member.
 */
router.get('/:id/members', async (req, res) => {
  try {
    const workspace = await loadWorkspace(String(req.params.id));
    if (!workspace) {
      return res.status(404).json({ error: 'not_found', message: 'ما في مساحة عمل بهذا المعرّف' });
    }

    const access = await resolveAccess(workspace.id, req);
    // Reading the member list is allowed to any member, whatever their role —
    // knowing who you work alongside is not an administrative act. Only the
    // mutations below require ADMIN.
    const ownMembership = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: req.user!.id },
      select: { role: true },
    });
    if (!ownMembership && req.user!.role !== 'ADMIN') {
      return res.status(403).json({ error: 'not_a_member', message: 'إنت مش عضو بهذي المساحة.' });
    }

    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: workspace.id },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, isActive: true, role: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const memberIds = new Set(members.map((row) => row.userId));
    const candidates = await prisma.user.findMany({
      where: { isActive: true, id: { notIn: [...memberIds] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });

    return res.json({
      workspace,
      members: members.map((row) => ({
        userId: row.userId,
        name: row.user.name,
        isActive: row.user.isActive,
        organizationRole: row.user.role,
        workspaceRole: row.role,
        joinedAt: row.createdAt,
      })),
      candidates,
      // The UI needs all three: whether to render the controls, whether to warn
      // that this is an override, and whether removal of self is offered.
      canManage: access.ok,
      actingAsOverride: access.ok && access.via === 'override',
      selfUserId: req.user!.id,
      isDefaultWorkspace: workspace.isDefault,
    });
  } catch (err) {
    logger.error('workspace members list failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Add an existing organization user to this workspace.
 *
 * Deliberately NOT an invitation. This creates a WorkspaceMember row against a
 * User that already exists in this organization, and refuses otherwise — the
 * inverse of D-39's guard: that one made sure every new User gets a membership,
 * this one makes sure no membership exists without a User.
 *
 * Adding somebody who is not yet in the organization is the invitation flow,
 * which cannot target a workspace: UserInvitation carries no workspaceId and
 * acceptance places the new user in the default workspace. So it is a two-step
 * — invite, then add here — and the UI says so rather than pretending the
 * button does something it cannot.
 */
router.post('/:id/members', async (req, res) => {
  try {
    const workspace = await loadWorkspace(String(req.params.id));
    if (!workspace) {
      return res.status(404).json({ error: 'not_found', message: 'ما في مساحة عمل بهذا المعرّف' });
    }

    const access = await resolveAccess(workspace.id, req);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });

    const userId = String(req.body?.userId ?? '').trim();
    const role = String(req.body?.role ?? 'AGENT').trim().toUpperCase();
    const ROLES = ['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'];
    if (!userId) return res.status(400).json({ error: 'invalid_request', message: 'لازم تحدد المستخدم' });
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_request', message: 'دور غير معروف' });

    // Organization-scoped by the extension, so a user id from another tenant
    // resolves to nothing and is refused as unknown rather than as forbidden.
    const user = await prisma.user.findFirst({ where: { id: userId }, select: { id: true, name: true } });
    if (!user) {
      return res.status(404).json({
        error: 'not_in_organization',
        message: 'هالشخص مش بالمؤسسة. ابعتله دعوة أول، وبعدين ضيفه هون.',
      });
    }

    const existing = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId },
      select: { id: true },
    });
    if (existing) return res.status(409).json({ error: 'already_a_member', message: 'هالشخص عضو أصلاً' });

    await prisma.workspaceMember.create({
      data: { organizationId: req.user!.organizationId, workspaceId: workspace.id, userId, role: role as any },
    });

    await auditLog({
      userId: req.user!.id,
      action: access.via === 'override' ? 'workspace.member-added.org-admin-override' : 'workspace.member-added',
      resource: 'workspace',
      resourceId: workspace.id,
      changes: { after: { userId, role } },
      description: access.via === 'override'
        ? `Added ${user.name} to ${workspace.name} as organization administrator (not a member of it)`
        : `Added ${user.name} to ${workspace.name}`,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.status(201).json({ userId, role });
  } catch (err) {
    logger.error('workspace member add failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

/** Change a member's role within this workspace. */
router.patch('/:id/members/:userId', async (req, res) => {
  try {
    const workspace = await loadWorkspace(String(req.params.id));
    if (!workspace) {
      return res.status(404).json({ error: 'not_found', message: 'ما في مساحة عمل بهذا المعرّف' });
    }

    const access = await resolveAccess(workspace.id, req);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });

    const targetId = String(req.params.userId);
    const role = String(req.body?.role ?? '').trim().toUpperCase();
    const ROLES = ['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE'];
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'invalid_request', message: 'دور غير معروف' });

    const target = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: targetId },
      select: { id: true, role: true, user: { select: { name: true } } },
    });
    if (!target) return res.status(404).json({ error: 'not_found', message: 'هالشخص مش عضو بهذي المساحة' });

    /*
      Demoting the last administrator is the same failure as removing them, so
      it is refused for the same reason. A workspace whose only admin becomes a
      VIEWER cannot be administered by anybody, and recovery means editing the
      database — which is why this check lives here and not only on DELETE.
    */
    if (target.role === 'ADMIN' && role !== 'ADMIN') {
      const admins = await prisma.workspaceMember.count({
        where: { workspaceId: workspace.id, role: 'ADMIN' },
      });
      if (admins <= 1) {
        return res.status(409).json({
          error: 'last_admin',
          message: 'هاد آخر أدمن بالمساحة. عيّن أدمن تاني قبل ما تغيّر دوره.',
        });
      }
    }

    await prisma.workspaceMember.updateMany({
      where: { workspaceId: workspace.id, userId: targetId },
      data: { role: role as any },
    });

    await auditLog({
      userId: req.user!.id,
      action: access.via === 'override' ? 'workspace.member-role-changed.org-admin-override' : 'workspace.member-role-changed',
      resource: 'workspace',
      resourceId: workspace.id,
      changes: { before: { role: target.role }, after: { role } },
      description: `${target.user.name} in ${workspace.name}: ${target.role} to ${role}`
        + (access.via === 'override' ? ' (organization administrator override)' : ''),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ userId: targetId, role });
  } catch (err) {
    logger.error('workspace member role change failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Remove a member from a workspace.
 *
 * Four rules, decided deliberately rather than inherited:
 *
 * 1. **Never from the default workspace.** Default membership is what every
 *    login claim depends on, so removing it locks the user out of the entire
 *    organization rather than out of one workspace. That is D-39 exactly.
 *    Removing somebody from the organization is `user:delete` — a different
 *    act, on a different screen, with a different confirmation.
 * 2. **Never the last ADMIN.** Respond.io lets any collaborator remove any
 *    other with no restriction, and for conversations that is right: friction
 *    with no benefit. A workspace is a different failure. An unwatched thread
 *    degrades; an unadministered workspace is a dead end.
 * 3. **Removing yourself is allowed**, subject to 1 and 2. Leaving is not the
 *    same act as being removed, and blocking it buys nothing.
 * 4. **Assigned conversations are unassigned, and the count is returned.**
 *    Conversation.assignedToId references User by [id, organizationId] and
 *    knows nothing about workspaces, so removal would otherwise leave threads
 *    showing an assignee who cannot open them. Refusing removal while work is
 *    assigned would block the ordinary case — somebody leaving — so the work is
 *    released and the number is reported rather than done silently.
 */
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const workspace = await loadWorkspace(String(req.params.id));
    if (!workspace) {
      return res.status(404).json({ error: 'not_found', message: 'ما في مساحة عمل بهذا المعرّف' });
    }

    if (workspace.isDefault) {
      return res.status(409).json({
        error: 'default_workspace',
        message: 'ما بتقدر تشيل حدا من المساحة الأساسية. لإزالته من المؤسسة، استخدم إعدادات أعضاء الفريق.',
      });
    }

    const access = await resolveAccess(workspace.id, req);
    if (!access.ok) return res.status(access.status).json({ error: access.error, message: access.message });

    const targetId = String(req.params.userId);
    const target = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: targetId },
      select: { role: true, user: { select: { name: true } } },
    });
    if (!target) return res.status(404).json({ error: 'not_found', message: 'هالشخص مش عضو بهذي المساحة' });

    if (target.role === 'ADMIN') {
      const admins = await prisma.workspaceMember.count({
        where: { workspaceId: workspace.id, role: 'ADMIN' },
      });
      if (admins <= 1) {
        return res.status(409).json({
          error: 'last_admin',
          message: 'هاد آخر أدمن بالمساحة. عيّن أدمن تاني قبل ما تشيله.',
        });
      }
    }

    /*
      Run in the TARGET workspace scope, not the caller’s.

      The scope extension injects workspaceId into updateMany LAST, so it
      overwrites an explicit one in the same where clause. Written the obvious
      way, this releases conversations in whichever workspace the caller
      happens to be viewing - which for the organization-admin override is a
      DIFFERENT workspace from the one being edited. An admin in Head office
      removing somebody from Retail would have unassigned Head office’s
      threads, silently, and the audit line would have named Retail.

      runAsOrganization with an explicit workspaceId opens a nested scope whose
      injected value is the right one, so the extension and the intent agree
      instead of fighting.
    */
    const released = await runAsOrganization(
      req.user!.organizationId,
      () => prisma.conversation.updateMany({
        where: { assignedToId: targetId },
        data: { assignedToId: null },
      }),
      { workspaceId: workspace.id },
    );

    await prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id, userId: targetId } });

    await auditLog({
      userId: req.user!.id,
      action: access.via === 'override' ? 'workspace.member-removed.org-admin-override' : 'workspace.member-removed',
      resource: 'workspace',
      resourceId: workspace.id,
      changes: { before: { userId: targetId, role: target.role }, after: { unassignedConversations: released.count } },
      description: `Removed ${target.user.name} from ${workspace.name}, releasing ${released.count} conversation(s)`
        + (access.via === 'override' ? ' (organization administrator override)' : ''),
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    /*
      Leaving the workspace you are currently in invalidates your own claim, and
      verifyToken would refuse your very next request with a 403 naming a
      workspace you just left — locking you out of the product rather than out
      of the workspace.

      So a self-removal returns a token re-minted onto the default workspace.
      That is safe for one specific reason: rule 1 above means default
      membership can never be removed, so it is the one destination guaranteed
      to exist. A guarantee doing work rather than sitting there.
    */
    let token: string | undefined;
    if (targetId === req.user!.id) {
      const header = String(req.headers.authorization || '');
      const current = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (current) {
        const decoded = jwt.verify(current, process.env.JWT_SECRET!) as Record<string, unknown>;
        const rest = { ...decoded };
        delete rest.iat;
        delete rest.exp;
        delete rest.nbf;
        token = jwt.sign(
          { ...rest, workspaceId: defaultWorkspaceIdFor(req.user!.organizationId) },
          process.env.JWT_SECRET!,
          { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
        );
      }
    }

    return res.json({ ok: true, unassignedConversations: released.count, ...(token ? { token } : {}) });
  } catch (err) {
    logger.error('workspace member removal failed', { error: (err as Error)?.message, requestId: (req as any).id });
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
