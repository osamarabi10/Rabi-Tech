import { prisma } from '../../prisma';
import { getTenantId } from '../../lib/tenant-context';
import logger from '../../lib/logger';

/**
 * Automatic conversation assignment.
 *
 * Respond.io ships exactly two strategies, and both check agent availability at
 * assignment time rather than round-robining into an offline queue:
 *
 *   ROUND_ROBIN  - distribute equally across available agents
 *   LEAST_OPEN   - give it to whoever is carrying the fewest open conversations
 *
 * Plus a workload cap. Without one, round-robin cheerfully buries your fastest
 * agent: they close conversations quickly, so they always look "free" and keep
 * receiving more. An agent at capacity is skipped by both strategies.
 *
 * When nobody is eligible the conversation stays unassigned in the team queue and
 * the existing escalation worker picks it up. Routing is never silently dropped.
 */
export type AssignmentStrategy = 'NONE' | 'ROUND_ROBIN' | 'LEAST_OPEN';

/** Conversation states that count against an agent's workload. */
const OPEN_STATES = ['OPEN', 'PENDING', 'AWAITING_CLIENT'] as const;

interface Candidate {
  userId: string;
  openCount: number;
}

/**
 * Agents eligible to receive a conversation on this team:
 * active, not away, and under the team's concurrency cap.
 */
async function eligibleAgents(teamId: string, maxConcurrent: number | null): Promise<Candidate[]> {
  const members = await prisma.userTeam.findMany({
    where: { teamId, user: { isActive: true, isAway: false } },
    select: { userId: true },
  });
  if (members.length === 0) return [];

  const userIds = members.map((m) => m.userId);
  const counts = await prisma.conversation.groupBy({
    by: ['assignedToId'],
    where: { assignedToId: { in: userIds }, status: { in: [...OPEN_STATES] as any } },
    _count: { _all: true },
  });
  const byUser = new Map(counts.map((c) => [c.assignedToId as string, c._count._all]));

  return userIds
    .map((userId) => ({ userId, openCount: byUser.get(userId) ?? 0 }))
    .filter((c) => maxConcurrent === null || c.openCount < maxConcurrent);
}

/**
 * Round robin without a stored cursor: pick the eligible agent whose most recent
 * assignment is oldest. Equivalent distribution, and it self-corrects when agents
 * go away or come back — a stored index would drift as membership changes.
 */
async function pickRoundRobin(candidates: Candidate[]): Promise<string | null> {
  if (candidates.length === 0) return null;

  const userIds = candidates.map((c) => c.userId);
  const latest = await prisma.conversation.groupBy({
    by: ['assignedToId'],
    where: { assignedToId: { in: userIds } },
    _max: { lastMessageAt: true },
  });
  const lastAssigned = new Map(
    latest.map((row) => [row.assignedToId as string, row._max.lastMessageAt?.getTime() ?? 0]),
  );

  return [...userIds].sort(
    (a, b) => (lastAssigned.get(a) ?? 0) - (lastAssigned.get(b) ?? 0),
  )[0];
}

function pickLeastOpen(candidates: Candidate[]): string | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.openCount - b.openCount)[0].userId;
}

/**
 * Assigns a conversation if the team has a strategy configured and an agent is
 * available. Returns the assigned user id, or null when it stays in the queue.
 *
 * Safe to call on every inbound message: already-assigned conversations are left
 * alone, so a customer replying does not bounce their thread between agents.
 */
export async function autoAssignConversation(conversationId: string): Promise<string | null> {
  const organizationId = getTenantId();

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, assignedToId: true, teamId: true, status: true },
  });
  if (!conversation) return null;
  if (conversation.assignedToId) return null;       // never reassign
  if (conversation.status === 'RESOLVED') return null;
  if (!conversation.teamId) return null;

  const team = await prisma.team.findUnique({
    where: { id: conversation.teamId },
    select: { assignmentStrategy: true, maxConcurrentPerAgent: true },
  });
  const strategy = (team?.assignmentStrategy ?? 'NONE') as AssignmentStrategy;
  if (strategy === 'NONE') return null;

  const candidates = await eligibleAgents(conversation.teamId, team?.maxConcurrentPerAgent ?? null);
  if (candidates.length === 0) {
    logger.info('No agent available for auto-assignment', {
      organizationId,
      conversationId,
      teamId: conversation.teamId,
    });
    return null;
  }

  const userId =
    strategy === 'LEAST_OPEN' ? pickLeastOpen(candidates) : await pickRoundRobin(candidates);
  if (!userId) return null;

  // Conditional update: if another worker assigned it first, this is a no-op
  // rather than a fight over the same conversation.
  const claimed = await prisma.conversation.updateMany({
    where: { id: conversationId, assignedToId: null },
    data: { assignedToId: userId },
  });
  if (claimed.count === 0) return null;

  logger.info('Conversation auto-assigned', { organizationId, conversationId, userId, strategy });
  return userId;
}
