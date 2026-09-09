import { Request, RequestHandler, Response, Router } from 'express';
import logger from '../../lib/logger';
import type { PlatformPermission } from '../platform/platform-permissions';
import {
  SupportTicketError,
  addPlatformTicketMessage,
  getPlatformTicket,
  listPlatformTickets,
  setPlatformTicketAssignee,
  setPlatformTicketPriority,
  setPlatformTicketStatus,
} from './support-tickets.service';

type PermissionGuard = (permission: PlatformPermission) => RequestHandler;

function sendTicketError(req: Request, res: Response, error: unknown, action: string) {
  if (error instanceof SupportTicketError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logger.error(`Platform support ticket ${action} failed`, {
    error: error instanceof Error ? error.stack : String(error),
    actorIdentityId: req.platformUser?.id,
    reference: req.params.reference,
    requestId: (req as any).id,
  });
  return res.status(500).json({ error: `Failed to ${action} support ticket` });
}

function actor(req: Request) {
  return { id: req.platformUser!.id, email: req.platformUser!.email };
}

export function createPlatformSupportTicketRouter(requirePermission: PermissionGuard) {
  const router = Router();

  router.get('/', requirePermission('ticket:read'), async (req, res) => {
    try {
      return res.json(await listPlatformTickets({
        limit: req.query.limit,
        cursor: req.query.cursor,
        status: req.query.status,
        priority: req.query.priority,
        organizationId: req.query.organizationId,
        assigneeIdentityId: req.query.assigneeIdentityId,
        q: req.query.q,
      }));
    } catch (error) {
      return sendTicketError(req, res, error, 'list');
    }
  });

  router.get('/:reference', requirePermission('ticket:read'), async (req, res) => {
    try {
      const ticket = await getPlatformTicket(req.params.reference);
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
      return res.json(ticket);
    } catch (error) {
      return sendTicketError(req, res, error, 'load');
    }
  });

  router.post(
    '/:reference/replies',
    requirePermission('ticket:read'),
    requirePermission('ticket:reply'),
    async (req, res) => {
      try {
        const result = await addPlatformTicketMessage({
          reference: req.params.reference,
          visibility: 'PUBLIC',
          message: req.body?.message,
          actor: actor(req),
          ipAddress: req.ip,
        });
        return res.status(201).json(result);
      } catch (error) {
        return sendTicketError(req, res, error, 'reply to');
      }
    },
  );

  router.post(
    '/:reference/notes',
    requirePermission('ticket:read'),
    requirePermission('ticket:reply'),
    async (req, res) => {
      try {
        const result = await addPlatformTicketMessage({
          reference: req.params.reference,
          visibility: 'INTERNAL',
          message: req.body?.message,
          actor: actor(req),
          ipAddress: req.ip,
        });
        return res.status(201).json(result);
      } catch (error) {
        return sendTicketError(req, res, error, 'add a note to');
      }
    },
  );

  router.post(
    '/:reference/status',
    requirePermission('ticket:read'),
    requirePermission('ticket:manage'),
    async (req, res) => {
      try {
        return res.json(await setPlatformTicketStatus({
          reference: req.params.reference,
          status: req.body?.status,
          actor: actor(req),
          ipAddress: req.ip,
        }));
      } catch (error) {
        return sendTicketError(req, res, error, 'change status for');
      }
    },
  );

  router.post(
    '/:reference/priority',
    requirePermission('ticket:read'),
    requirePermission('ticket:manage'),
    async (req, res) => {
      try {
        return res.json(await setPlatformTicketPriority({
          reference: req.params.reference,
          priority: req.body?.priority,
          actor: actor(req),
          ipAddress: req.ip,
        }));
      } catch (error) {
        return sendTicketError(req, res, error, 'change priority for');
      }
    },
  );

  router.post(
    '/:reference/assignment',
    requirePermission('ticket:read'),
    requirePermission('ticket:manage'),
    async (req, res) => {
      try {
        return res.json(await setPlatformTicketAssignee({
          reference: req.params.reference,
          assigneeIdentityId: req.body?.assigneeIdentityId,
          actor: actor(req),
          ipAddress: req.ip,
        }));
      } catch (error) {
        return sendTicketError(req, res, error, 'change assignment for');
      }
    },
  );

  return router;
}
