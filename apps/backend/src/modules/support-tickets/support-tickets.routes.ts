import { Request, Response, Router } from 'express';
import logger from '../../lib/logger';
import { verifyToken } from '../auth/auth.middleware';
import {
  SupportTicketError,
  addCustomerTicketReply,
  createCustomerTicket,
  getCustomerTicket,
  listCustomerTickets,
} from './support-tickets.service';

const router = Router();

router.use(verifyToken);

function sendTicketError(req: Request, res: Response, error: unknown, action: string) {
  if (error instanceof SupportTicketError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  logger.error(`Customer support ticket ${action} failed`, {
    error: error instanceof Error ? error.stack : String(error),
    organizationId: req.user?.organizationId,
    userId: req.user?.id,
    requestId: (req as any).id,
  });
  return res.status(500).json({ error: `Failed to ${action} support ticket` });
}

router.get('/', async (req, res) => {
  try {
    return res.json(await listCustomerTickets({
      limit: req.query.limit,
      cursor: req.query.cursor,
    }));
  } catch (error) {
    return sendTicketError(req, res, error, 'list');
  }
});

router.post('/', async (req, res) => {
  try {
    const ticket = await createCustomerTicket({
      organizationId: req.user!.organizationId,
      userId: req.user!.id,
      subject: req.body?.subject,
      message: req.body?.message,
      priority: req.body?.priority,
    });
    return res.status(201).json(ticket);
  } catch (error) {
    return sendTicketError(req, res, error, 'create');
  }
});

router.get('/:reference', async (req, res) => {
  try {
    const ticket = await getCustomerTicket(req.params.reference);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    return res.json(ticket);
  } catch (error) {
    return sendTicketError(req, res, error, 'load');
  }
});

router.post('/:reference/replies', async (req, res) => {
  try {
    const ticket = await addCustomerTicketReply({
      reference: req.params.reference,
      userId: req.user!.id,
      message: req.body?.message,
    });
    return res.status(201).json(ticket);
  } catch (error) {
    return sendTicketError(req, res, error, 'reply to');
  }
});

export default router;
