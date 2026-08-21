import { prisma } from '../../prisma';
import logger from '../../lib/logger';

/**
 * Stamp the moment an agent first replied in a thread.
 *
 * Recording it at write time turns first-response time into an indexed
 * aggregate. The alternative — deriving it per conversation from the message
 * table on every report load — is what the old agent-performance endpoint did,
 * and it read every message row for every agent in range.
 *
 * Three conditions, each of which changes the number:
 *
 * - **`firstResponseAt: null`** — only the first reply counts, and the guard
 *   lives in the `where` so two agents replying at once cannot both win.
 * - **`isAuto: false`, `isInternal: false`** (enforced by the callers) — an
 *   auto-reply would report a first-response time of seconds for every thread,
 *   and an internal note is not a response to the customer at all.
 * - **the thread already has an inbound message** — an agent-initiated
 *   conversation has nothing to respond *to*, and counting it would report a
 *   near-zero response on a thread no customer ever waited in.
 *
 * A reopened thread keeps its original stamp: the metric describes the first
 * time that customer was answered, not the fastest reply within it.
 */
export async function stampFirstResponse(conversationId: string, at: Date): Promise<void> {
  try {
    await prisma.conversation.updateMany({
      where: {
        id: conversationId,
        firstResponseAt: null,
        messages: { some: { direction: 'INBOUND' } },
      },
      data: { firstResponseAt: at },
    });
  } catch (err) {
    // Reporting metadata must never fail the send that produced it.
    logger.warn('failed to stamp first response', { conversationId, error: String(err) });
  }
}
