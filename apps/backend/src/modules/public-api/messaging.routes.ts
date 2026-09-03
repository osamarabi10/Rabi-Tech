import { Router } from 'express';
import { prisma } from '../../prisma';
import logger from '../../lib/logger';
import { getOrCreateActiveConversation } from '../../utils/conversation-session';
import { getSessionForTeam } from '../../utils/whatsapp-sessions';
import { describeSendFailure } from '../../utils/send-failure';
import {
  isCapabilityNotIncludedError,
  isQuotaExceededError,
} from '../usage/entitlements';
import { OutboundSendError, sendOutboundMessage } from '../conversations/outbound-message.service';
import { requireScope } from '../api-tokens/api-token.middleware';
import { parseContactRef, assertRefUnambiguous, AmbiguousIdentifierError } from './identifier';

/**
 * Sending, from the public API.
 *
 * Goes through the same `sendOutboundMessage` the console's reply box uses, so
 * a message from a subscriber's own software persists, stamps analytics,
 * restarts the auto-close clock and appears live in the agent's inbox exactly
 * like one an agent typed. An integration whose messages are invisible in the
 * inbox is how an agent ends up answering a customer who was already answered.
 *
 * ## Three refusals that the console does not make
 *
 * The console lets an agent message a contact who is blocked or has opted out,
 * and that is right: a human is looking at the thread and deciding. A script is
 * not. So this endpoint refuses in cases the inbox permits, and says which:
 *
 * - **Opted out.** `OPTED_OUT` is a marketing opt-out and the API cannot know
 *   whether a given message is marketing. The workflow engine already takes
 *   this line — *"a workflow is not an exemption from consent"* — and an
 *   integration is the same kind of actor. A human can still reply from the
 *   inbox, where the judgement is being made by someone accountable for it.
 * - **Blocked.** Blocking exists because a number will not stop writing, or
 *   there is a dispute. Outbound stays open in the console so an operator can
 *   send a final message; nothing about that reasoning extends to a script.
 * - **Archived.** An archived contact was deliberately taken out of circulation.
 *
 * ## No internal notes
 *
 * `isInternal` is not accepted. An internal note is agent-to-agent, addressed
 * to colleagues by name, and a token has no name to sign it with — a note from
 * "nobody" appearing in a thread is worse than no note. Comments from
 * automation are their own feature, not a flag on this one.
 */

const router = Router();

const MAX_BODY = 4096;

function fail(res: any, req: any, err: unknown, where: string) {
  if (err instanceof OutboundSendError) {
    return res.status(err.status).json({ error: err.code.toLowerCase(), message: err.message });
  }
  logger.error(`public-api ${where} failed`, { error: (err as Error)?.message, requestId: req.id });
  return res.status(500).json({ error: 'server_error' });
}

/** Everything that must be true before a script may message this contact. */
function refusalFor(contact: {
  marketingConsent: string;
  blockedAt: Date | null;
  isArchived: boolean;
}): { error: string; message: string } | null {
  if (contact.blockedAt) {
    return {
      error: 'contact_blocked',
      message: 'This contact is blocked. An agent can still reply from the inbox; the API cannot.',
    };
  }
  if (contact.marketingConsent === 'OPTED_OUT') {
    return {
      error: 'contact_opted_out',
      message: 'This contact has opted out. The API cannot send to them; an agent can reply from the inbox.',
    };
  }
  if (contact.isArchived) {
    return {
      error: 'contact_archived',
      message: 'This contact is archived. Un-archive them before sending.',
    };
  }
  return null;
}

/**
 * Shape a send result for the caller.
 *
 * A failed send still returns the message id and a `202`, not a 500. The row
 * exists, the console shows it as FAILED with a reason, and an agent can retry
 * it there — so reporting "nothing happened" would be a lie, and a 5xx would
 * send a well-behaved client into a retry loop that delivers duplicates on any
 * failure that occurred *after* delivery.
 */
function respondToSend(res: any, outcome: { message: any; sendError: unknown | null }) {
  const message = outcome.message;
  const payload = {
    id: message.id,
    conversationId: message.conversationId,
    status: message.status,
    body: message.body,
    timestamp: message.timestamp,
  };

  if (!outcome.sendError) return res.status(201).json(payload);

  // Quota and plan refusals are the subscriber's own limits, not a fault in the
  // request, and a client should stop rather than retry.
  if (isQuotaExceededError(outcome.sendError) || isCapabilityNotIncludedError(outcome.sendError)) {
    return res.status(402).json({
      ...payload,
      error: 'not_entitled',
      message: 'The workspace plan does not currently allow this send.',
      failureReason: describeSendFailure(outcome.sendError).reason,
    });
  }

  return res.status(202).json({
    ...payload,
    error: 'send_failed',
    message: 'The message was recorded but the gateway refused it. It is visible in the inbox and can be retried there.',
    failureReason: describeSendFailure(outcome.sendError).reason,
  });
}

function bodyOf(req: any): string {
  const text = String(req.body?.text ?? req.body?.body ?? '').trim();
  return text.slice(0, MAX_BODY);
}

function rejectInternal(req: any, res: any): boolean {
  if (req.body?.isInternal || req.body?.internal) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Internal notes cannot be sent through the API — a note needs a person to sign it.',
    });
    return true;
  }
  return false;
}

/* ── send into an existing thread ─────────────────────────────────────────── */

router.post('/conversations/:id/messages', requireScope('messages:send'), async (req, res) => {
  try {
    if (rejectInternal(req, res)) return;

    const conversation = await prisma.conversation.findFirst({
      where: { id: String(req.params.id) },
      include: {
        contact: {
          include: { customFieldValues: { include: { fieldDefinition: { select: { slug: true } } } } },
        },
        session: true,
        assignee: { select: { id: true, name: true } },
      },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'not_found', message: 'No conversation with that id.' });
    }

    const refusal = refusalFor(conversation.contact);
    if (refusal) return res.status(403).json(refusal);

    const outcome = await sendOutboundMessage({
      conversation: conversation as any,
      body: bodyOf(req),
      mediaUrl: req.body?.mediaUrl ?? null,
      mediaType: req.body?.mediaType ?? null,
      mediaFileName: req.body?.mediaFileName ?? null,
      isInternal: false,
      sender: { kind: 'api', tokenId: req.apiToken!.id },
    });

    logger.info('public-api message sent', {
      conversationId: conversation.id,
      messageId: outcome.message.id,
      status: outcome.message.status,
      tokenId: req.apiToken!.id,
    });
    return respondToSend(res, outcome);
  } catch (err) { return fail(res, req, err, 'POST /conversations/:id/messages'); }
});

/* ── send to a contact, opening or reopening a thread ─────────────────────── */

/**
 * The endpoint most integrations actually want: address a person, not a thread.
 *
 * Resolves through `getOrCreateActiveConversation`, which is the same function
 * the inbound webhook uses. That matters more than it looks: it means a message
 * sent by an integration lands in the *existing* thread the agent is already
 * reading, reopens a resolved one rather than starting a parallel history, and
 * obeys the one-thread-per-contact rule the whole product is built on.
 */
router.post('/contacts/:identifier/messages', requireScope('messages:send'), async (req, res) => {
  try {
    if (rejectInternal(req, res)) return;

    const countryCode = String(req.body?.defaultCountryCode ?? '').replace(/\D/g, '') || undefined;
    const ref = parseContactRef(req.params.identifier, countryCode);
    if (!ref.ok) return res.status(400).json({ error: 'invalid_request', message: ref.message });

    // Refuse a phone:/email: identifier once it stops being unambiguous. This
    // route reports errors as responses rather than by throwing, so the guard
    // is caught here rather than routed through an ApiError.
    try {
      await assertRefUnambiguous(prisma as any, ref);
    } catch (err) {
      if (err instanceof AmbiguousIdentifierError) {
        return res.status(400).json({ error: 'ambiguous_identifier', message: err.message });
      }
      throw err;
    }

    const contact = await prisma.contact.findFirst({
      where: ref.where,
      select: { id: true, marketingConsent: true, blockedAt: true, isArchived: true },
    });
    if (!contact) {
      return res.status(404).json({ error: 'not_found', message: 'No contact matches that identifier.' });
    }

    const refusal = refusalFor(contact);
    if (refusal) return res.status(403).json(refusal);

    const session = await getSessionForTeam(null);
    if (!session) {
      return res.status(409).json({
        error: 'no_channel',
        message: 'This workspace has no connected WhatsApp channel to send from.',
      });
    }

    const active = await getOrCreateActiveConversation(contact.id, session.id, null);
    const thread = active.conversation;
    const conversation = await prisma.conversation.findFirst({
      where: { id: thread.id },
      include: {
        contact: {
          include: { customFieldValues: { include: { fieldDefinition: { select: { slug: true } } } } },
        },
        session: true,
        assignee: { select: { id: true, name: true } },
      },
    });

    const outcome = await sendOutboundMessage({
      conversation: conversation as any,
      body: bodyOf(req),
      mediaUrl: req.body?.mediaUrl ?? null,
      mediaType: req.body?.mediaType ?? null,
      mediaFileName: req.body?.mediaFileName ?? null,
      isInternal: false,
      sender: { kind: 'api', tokenId: req.apiToken!.id },
    });

    logger.info('public-api message sent to contact', {
      contactId: contact.id,
      conversationId: thread.id,
      messageId: outcome.message.id,
      status: outcome.message.status,
      tokenId: req.apiToken!.id,
    });
    return respondToSend(res, outcome);
  } catch (err) { return fail(res, req, err, 'POST /contacts/:identifier/messages'); }
});

export default router;
