import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import { hasPermission, requirePermission } from '../../middleware/rbac.middleware';
import { getIO, SocketEvents } from '../../socket';
import { socketRoom } from '../../socket/rooms';
import {
  InboxViewFilterError,
  validateInboxViewFilter,
  type InboxViewFilter,
} from '../../lib/inbox-view-filter';

/**
 * Saved views — a named conversation filter pinned to the inbox.
 *
 * Ownership *is* the sharing model: `ownerId` set means private to that user,
 * null means shared with the workspace. There is no `shared` boolean to fall
 * out of step with it.
 *
 * Permission therefore depends on the body and the row, not on the route.
 * Anyone who can read conversations may keep their own views; putting one in
 * front of the whole workspace needs `inbox-view:manage-shared`.
 */

const router = Router();
router.use(verifyToken);

const VIEW_SELECT = {
  id: true,
  name: true,
  filter: true,
  sortOrder: true,
  ownerId: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MAX_NAME_LENGTH = 60;

/**
 * A cap on how many views one workspace can accumulate.
 *
 * Column 1 of the inbox is a fixed-height list beside the conversations. This
 * is not a storage concern — it is the point past which the thing a view is
 * for, finding a conversation quickly, stops working.
 */
const MAX_VIEWS_PER_SCOPE = 30;

class ViewError extends Error {
  constructor(readonly status: number, message: string, readonly key?: string) {
    super(message);
    this.name = 'ViewError';
  }
}

type StoredView = {
  id: string;
  name: string;
  filter: unknown;
  sortOrder: number;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** What the client receives. `shared` is derived, never stored. */
function present(view: StoredView) {
  return {
    id: view.id,
    name: view.name,
    filter: (view.filter ?? {}) as InboxViewFilter,
    sortOrder: view.sortOrder,
    shared: view.ownerId === null,
    ownerId: view.ownerId,
    updatedAt: view.updatedAt.toISOString(),
  };
}

function parseName(raw: unknown): string {
  const name = String(raw ?? '').trim();
  if (!name) throw new ViewError(400, 'اسم العرض مطلوب', 'name');
  if (name.length > MAX_NAME_LENGTH) {
    throw new ViewError(400, `اسم العرض طويل جدًا (الحد ${MAX_NAME_LENGTH} حرفًا)`, 'name');
  }
  return name;
}

function parseFilter(raw: unknown): InboxViewFilter {
  try {
    return validateInboxViewFilter(raw);
  } catch (err) {
    if (err instanceof InboxViewFilterError) throw new ViewError(400, err.message, err.key);
    throw err;
  }
}

/**
 * Announce a change to exactly the people entitled to see it.
 *
 * Called **after** the write has committed. Emitting inside a transaction
 * broadcasts a change that can still roll back, leaving every open inbox
 * showing a view that does not exist.
 */
function announce(
  organizationId: string,
  action: 'created' | 'updated' | 'deleted',
  view: ReturnType<typeof present>,
) {
  try {
    /*
     * Two explicit emits rather than one emit to a room chosen above.
     *
     * The tenancy gate statically audits every emit site for an
     * organization-prefixed room, and it can only see that when the room is
     * built at the site. Hiding the choice behind a helper of my own made that
     * audit fail — correctly: a check that cannot see the room string is not
     * checking anything. Written this way, the guarantee covering every emit
     * in the codebase keeps covering this one, and a reader sees which room
     * each case goes to without following a function to find out.
     */
    const payload = {
      action,
      viewId: view.id,
      ...(action === 'deleted' ? {} : { view }),
    };
    if (view.shared) {
      getIO().to(socketRoom.organization(organizationId)).emit(SocketEvents.INBOX_VIEW_CHANGED, payload);
    } else {
      // Never the organization room: that would put a private view's name and
      // filter in front of the whole workspace.
      getIO().to(socketRoom.user(organizationId, view.ownerId!)).emit(SocketEvents.INBOX_VIEW_CHANGED, payload);
    }
  } catch (err) {
    // A view that saved but did not broadcast is a stale sidebar until the next
    // load. A view that failed to save because the socket was down is worse.
    logger.warn('inbox view broadcast failed', {
      organizationId,
      viewId: view.id,
      error: String(err),
    });
  }
}

/**
 * The row this request is allowed to act on, or the reason it is not.
 *
 * 404 for an id in another organization: the tenancy extension scopes the read,
 * so a row in another workspace is indistinguishable from one that never
 * existed — which is the correct answer to give, since existence is itself
 * information.
 */
async function loadEditable(id: string, userId: string, role: string | undefined) {
  const view = await prisma.inboxView.findUnique({ where: { id }, select: VIEW_SELECT });
  if (!view) throw new ViewError(404, 'العرض غير موجود');

  const isOwner = view.ownerId !== null && view.ownerId === userId;
  if (isOwner) return view;

  // Not the owner: either a shared view, or somebody else's private one. A
  // private view belonging to another user is not listable and not editable —
  // 404 rather than 403, for the same reason as above.
  if (view.ownerId !== null) throw new ViewError(404, 'العرض غير موجود');

  if (!hasPermission(role, 'inbox-view:manage-shared')) {
    throw new ViewError(403, 'ما بتقدر تعدّل عرض مشترك');
  }
  return view;
}

function fail(res: any, err: unknown, requestId: unknown, context: string) {
  if (err instanceof ViewError) {
    return res.status(err.status).json({ error: err.message, ...(err.key ? { key: err.key } : {}) });
  }
  logger.error(context, { error: String(err), requestId });
  return res.status(500).json({ error: 'فشل تنفيذ العملية', requestId });
}

/**
 * This viewer's own private views, plus every shared one.
 *
 * Another user's private views are not returned at all — not filtered out on
 * the client, which would ship their names and filters to a browser that is
 * merely told not to draw them.
 */
router.get('/', requirePermission('conversation:read'), async (req, res) => {
  try {
    const views = await prisma.inboxView.findMany({
      where: { OR: [{ ownerId: null }, { ownerId: req.user!.id }] },
      select: VIEW_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    res.json(views.map(present));
  } catch (err) {
    fail(res, err, (req as any).id, 'inbox views list failed');
  }
});

router.post('/', requirePermission('conversation:read'), async (req, res) => {
  try {
    const name = parseName(req.body?.name);
    const filter = parseFilter(req.body?.filter ?? {});
    const shared = req.body?.shared === true;

    // The permission is decided by the body, not the route: creating a private
    // view is something every agent may do, and sharing one is not.
    if (shared && !hasPermission(req.user!.role, 'inbox-view:manage-shared')) {
      throw new ViewError(403, 'ما بتقدر تنشئ عرض مشترك');
    }

    const ownerId = shared ? null : req.user!.id;
    const existing = await prisma.inboxView.count({ where: { ownerId } });
    if (existing >= MAX_VIEWS_PER_SCOPE) {
      throw new ViewError(400, `وصلت الحد الأقصى للعروض (${MAX_VIEWS_PER_SCOPE})`);
    }

    const created = await prisma.inboxView.create({
      data: {
        organizationId: req.user!.organizationId,
        ownerId,
        name,
        filter,
        sortOrder: Number.isInteger(req.body?.sortOrder) ? req.body.sortOrder : existing,
      },
      select: VIEW_SELECT,
    });

    const view = present(created);
    announce(req.user!.organizationId, 'created', view);
    res.status(201).json(view);
  } catch (err) {
    fail(res, err, (req as any).id, 'inbox view create failed');
  }
});

router.patch('/:id', requirePermission('conversation:read'), async (req, res) => {
  try {
    const current = await loadEditable(req.params.id, req.user!.id, req.user!.role);

    /*
     * Last-write-wins over a JSON blob is silent data loss: two supervisors
     * editing the same shared view, and the second save discards the first's
     * changes with nothing to indicate it happened. The client sends the
     * `updatedAt` it rendered from; a mismatch means the row moved underneath
     * it and the answer is 409, not an overwrite.
     *
     * Cheap now and impossible to retrofit once people rely on shared views.
     */
    const precondition = req.body?.updatedAt;
    if (precondition !== undefined) {
      const sent = new Date(String(precondition)).getTime();
      if (!Number.isFinite(sent)) throw new ViewError(400, 'قيمة updatedAt غير صالحة', 'updatedAt');
      if (sent !== current.updatedAt.getTime()) {
        throw new ViewError(409, 'حدا ثاني عدّل هالعرض. حدّث الصفحة وجرّب كمان مرة');
      }
    }

    const data: Record<string, unknown> = {};
    if (req.body?.name !== undefined) data.name = parseName(req.body.name);
    if (req.body?.filter !== undefined) data.filter = parseFilter(req.body.filter);
    if (req.body?.sortOrder !== undefined) {
      if (!Number.isInteger(req.body.sortOrder)) {
        throw new ViewError(400, 'ترتيب غير صالح', 'sortOrder');
      }
      data.sortOrder = req.body.sortOrder;
    }

    // Sharing and un-sharing change who the view belongs to, so both directions
    // need the shared permission — un-sharing a team's view removes it from
    // four other people's inboxes just as surely as deleting it.
    if (req.body?.shared !== undefined) {
      const shared = req.body.shared === true;
      if (!hasPermission(req.user!.role, 'inbox-view:manage-shared')) {
        throw new ViewError(403, 'ما بتقدر تغيّر مشاركة العرض');
      }
      data.ownerId = shared ? null : req.user!.id;
    }

    if (Object.keys(data).length === 0) {
      return res.json(present(current));
    }

    const updated = await prisma.inboxView.update({
      where: { id: current.id },
      data,
      select: VIEW_SELECT,
    });

    const view = present(updated);

    /*
     * A view that just stopped being shared has to be withdrawn from everyone
     * who could see it, not merely announced to its new owner — otherwise it
     * sits in four other sidebars until they reload, and clicking it 404s.
     */
    if (current.ownerId === null && view.shared === false) {
      announce(req.user!.organizationId, 'deleted', { ...present(current), shared: true });
    }
    announce(req.user!.organizationId, 'updated', view);
    res.json(view);
  } catch (err) {
    fail(res, err, (req as any).id, 'inbox view update failed');
  }
});

router.delete('/:id', requirePermission('conversation:read'), async (req, res) => {
  try {
    const current = await loadEditable(req.params.id, req.user!.id, req.user!.role);
    await prisma.inboxView.delete({ where: { id: current.id } });
    announce(req.user!.organizationId, 'deleted', present(current));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, (req as any).id, 'inbox view delete failed');
  }
});

export default router;
