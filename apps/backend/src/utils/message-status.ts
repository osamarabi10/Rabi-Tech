import { MessageStatus } from '@prisma/client';

/**
 * Delivery status only ever moves forward.
 *
 * WhatsApp acks are not ordered and are redelivered: a `read` can arrive before
 * the matching `delivered`, the same ack can arrive twice, and Meta retries any
 * webhook it did not see acknowledged. Applied naively, a late duplicate walks a
 * message backwards — an agent watches a message they know was read revert to
 * "delivered", and the only thing that changed was network timing.
 *
 * `CAMPAIGN_ACK_RANK` in the OpenWA webhook has enforced this for campaign
 * recipients since it was written. The Message row it sits next to did not: it
 * assigned `status` unconditionally, so the invariant CLAUDE.md states as a rule
 * of this codebase held for one of the two things it was written about. This is
 * the shared version, so a second channel cannot arrive and quietly make it two
 * out of three.
 *
 * **The ordering is the whole design.** FAILED sits between SENT and DELIVERED,
 * which resolves every awkward case without a single special branch:
 *
 * - FAILED after SENT wins (2 > 1) — the send genuinely failed.
 * - FAILED after DELIVERED loses (2 < 3) — the customer demonstrably has the
 *   message, so a late failure is stale noise, not news.
 * - DELIVERED after FAILED wins (3 > 2) — real evidence of receipt corrects a
 *   failure we were wrong about.
 * - SENT after FAILED loses (1 < 2) — "sent" is not evidence of anything the
 *   failure did not already contradict.
 */
const STATUS_RANK: Record<MessageStatus, number> = {
  PENDING: 0,
  SENT: 1,
  FAILED: 2,
  DELIVERED: 3,
  READ: 4,
};

/**
 * The status to write, or null when the incoming ack adds nothing.
 *
 * Returning null rather than the unchanged status is deliberate: it lets callers
 * skip the write and the socket emit entirely, so a redelivered ack does not
 * produce a database round trip and a UI flicker for a value that did not move.
 */
export function advanceMessageStatus(
  current: MessageStatus | string,
  incoming: MessageStatus | string,
): MessageStatus | null {
  const currentRank = STATUS_RANK[current as MessageStatus];
  const incomingRank = STATUS_RANK[incoming as MessageStatus];

  // An unknown status is not a reason to overwrite a known one.
  if (incomingRank === undefined) return null;
  if (currentRank === undefined) return incoming as MessageStatus;

  return incomingRank > currentRank ? (incoming as MessageStatus) : null;
}
