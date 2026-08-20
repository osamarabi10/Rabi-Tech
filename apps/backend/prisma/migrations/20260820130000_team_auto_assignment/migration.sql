-- Automatic conversation assignment, configured per team.
--
-- Until now Conversation.assignedToId existed but nothing ever set it: every
-- conversation sat unassigned until an agent manually claimed it. This adds the
-- two strategies Respond.io ships, plus a workload cap.
--
-- Defaults are deliberately inert: existing teams keep manual assignment until an
-- admin opts in, so this migration changes no live behaviour on its own.

ALTER TABLE "Team" ADD COLUMN "assignmentStrategy" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Team" ADD COLUMN "maxConcurrentPerAgent" INTEGER;

-- Assignment lookups filter by assignee and open status on every inbound message.
CREATE INDEX IF NOT EXISTS "Conversation_organizationId_assignedToId_status_idx"
  ON "Conversation" ("organizationId", "assignedToId", "status");
