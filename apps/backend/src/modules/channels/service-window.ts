import { prisma } from '../../prisma';

/**
 * The Meta 24-hour customer service window.
 *
 * Meta permits free-form messages only within 24 hours of the customer's last
 * message. Outside it, only pre-approved templates may be sent — and this
 * product has no Meta template management, so outside the window there is
 * nothing it can legally send at all.
 *
 * **Why this is checked here and not left to Meta.** Three reasons, in order of
 * how much they cost:
 *
 *  1. Meta's rejection arrives as an English error code against a request the
 *     agent has already sent. Refusing locally means an Arabic message that
 *     names when the window closed, in the composer, before anything is sent.
 *  2. Rejected sends are not free. A number that accumulates failed and blocked
 *     sends attracts a lower quality rating, and quality rating governs the
 *     messaging tier — so spending it on requests we already know Meta will
 *     refuse degrades the customer's own number.
 *  3. A message persisted and then rejected leaves a row the agent can see and
 *     the customer never received, which is the failure mode this codebase
 *     already refuses elsewhere ("persist before sending" exists to avoid the
 *     inverse).
 */

/** How long Meta keeps the window open after the customer's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ServiceWindow = {
  open: boolean;
  /** Last inbound message from this contact, or null if they never wrote. */
  lastInboundAt: Date | null;
  /** When the window closes (or closed). Null when there was never one. */
  expiresAt: Date | null;
};

/**
 * Is the window open for this contact?
 *
 * Derived from the latest INBOUND message rather than a denormalised column.
 * `Conversation.lastMessageAt` cannot answer this — it moves on outbound
 * messages too, so an agent replying would keep re-opening a window that Meta
 * considers shut, which is exactly the direction of error that gets a number
 * rejected rather than merely inconvenienced.
 *
 * Scoped to the contact rather than one conversation on purpose: a resolved
 * thread that reopens is a new Conversation row in some flows, and Meta's window
 * is per customer phone number, not per thread in our database.
 *
 * If this measures slow it becomes a maintained `lastInboundAt` column on
 * Conversation. It is a query first because that needs no migration and no
 * second write path to keep correct.
 */
export async function serviceWindowFor(contactId: string | null): Promise<ServiceWindow> {
  if (!contactId) return { open: false, lastInboundAt: null, expiresAt: null };

  const lastInbound = await prisma.message.findFirst({
    where: { direction: 'INBOUND', conversation: { contactId } },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });

  if (!lastInbound) return { open: false, lastInboundAt: null, expiresAt: null };

  const expiresAt = new Date(lastInbound.timestamp.getTime() + SERVICE_WINDOW_MS);
  return {
    open: expiresAt.getTime() > Date.now(),
    lastInboundAt: lastInbound.timestamp,
    expiresAt,
  };
}
