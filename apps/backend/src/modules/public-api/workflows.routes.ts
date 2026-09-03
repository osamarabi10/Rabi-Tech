import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { requireScope } from '../api-tokens/api-token.middleware';
import { dispatchWorkflowEvent } from '../../workers/workflow.worker';
import { parseContactRef } from './identifier';

/**
 * `/api/v1/workflows` — starting an automation from outside.
 *
 * ## The trigger P1 existed to make possible
 *
 * Before this, an integration could read and write but could not *start*
 * anything. Whatever happened in the subscriber's own system — an order ships,
 * a payment clears, a delivery fails — could only reach the organization as a
 * message somebody had to read and act on. This closes that: their software
 * fires the workflow the organization already built.
 *
 * ## Addressed by id, authorised by a token
 *
 * Deliberately not a secret URL, which is the usual shape for this feature.
 * A per-workflow token in a path ends up in access logs, proxy logs, browser
 * history and referrer headers — every place the bearer scheme exists to keep
 * credentials out of. The workflow id is not a secret and the Authorization
 * header is.
 *
 * `workflows:trigger` is its own scope. Starting an automation can send
 * messages, reassign threads and change lifecycle stages, so it is strictly
 * more powerful than the read scopes and must be granted deliberately — and
 * being new, no token issued before today can hold it.
 */

const router = Router();

router.post('/:id/trigger', requireScope('workflows:trigger'), async (req, res) => {
  try {
    const workflow = await prisma.workflow.findFirst({
      where: { id: String(req.params.id) },
      select: { id: true, name: true, isActive: true, triggerType: true },
    });
    if (!workflow) {
      return res.status(404).json({ error: 'not_found', message: 'No workflow with that id.' });
    }

    /*
      Only a workflow that asked to be triggered this way.

      Firing an arbitrary workflow by id would let a token start automations
      built for a keyword or a tag, with none of the context they were written
      against — a workflow whose first step assumes a conversation, started with
      no conversation, does nothing useful and looks broken.
    */
    if (workflow.triggerType !== 'INCOMING_WEBHOOK') {
      return res.status(409).json({
        error: 'wrong_trigger',
        message: `That workflow is triggered by ${workflow.triggerType}, not by an incoming webhook.`,
      });
    }
    if (!workflow.isActive) {
      return res.status(409).json({
        error: 'workflow_inactive',
        message: 'That workflow is switched off.',
      });
    }

    /*
      A contact is optional but usually wanted.

      Most workflow steps act on somebody — tag them, message them, move their
      stage. A run with no contact is legal and does what it can, but silently
      skipping every step is a confusing answer, so an unresolvable identifier
      is refused rather than dropped.
    */
    let contactId: string | null = null;
    if (req.body?.contact !== undefined && req.body.contact !== null) {
      const ref = parseContactRef(req.body.contact);
      if (!ref.ok) return res.status(400).json({ error: 'invalid_request', message: ref.message });
      const contact = await prisma.contact.findFirst({ where: ref.where, select: { id: true } });
      if (!contact) {
        return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });
      }
      contactId = contact.id;
    }

    /*
      The caller's own data, carried into the run.

      Available to message steps as interpolation variables, which is what makes
      this useful rather than merely a remote button: "your order {{orderId}}
      shipped" needs the order id, and the workspace has no other way to know it.

      Bounded and shallow-copied. An unbounded object becomes a row in the
      execution log, and the log is capped.
    */
    const payload: Record<string, unknown> = {};
    if (req.body?.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data)) {
      for (const [key, value] of Object.entries(req.body.data).slice(0, 50)) {
        if (typeof value === 'object' && value !== null) continue;
        payload[key] = String(value ?? '').slice(0, 1000);
      }
    }

    const started = await dispatchWorkflowEvent({
      triggerType: 'INCOMING_WEBHOOK',
      contactId,
      payload: { ...payload, workflowId: workflow.id },
    });

    logger.info('public-api workflow triggered', {
      workflowId: workflow.id,
      contactId,
      started,
      tokenId: req.apiToken!.id,
    });

    // 202, not 200: the run is queued, not finished. Reporting success for work
    // that has not happened yet is how a caller concludes an automation
    // completed when it is still three steps from starting.
    return res.status(202).json({ accepted: true, workflowId: workflow.id, runs: started });
  } catch (err) {
    logger.error('public-api workflow trigger failed', {
      error: (err as Error)?.message,
      requestId: (req as any).id,
    });
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
