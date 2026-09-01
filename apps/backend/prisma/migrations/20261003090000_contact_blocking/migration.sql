-- Blocked contacts (M9.1).
--
-- A third state, deliberately not a fourth use of `isArchived` and not a
-- delete. Archiving hides a contact and still accepts their messages; deleting
-- destroys the conversation history that is usually the reason for blocking
-- someone. The history has to survive the block.
--
-- Enforcement is in the inbound worker, immediately after the contact upsert
-- and before a conversation is opened, so a blocked number cannot open a
-- thread, fire an auto-reply, consume quota, or reach an agent.

BEGIN;

ALTER TABLE "Contact"
  ADD COLUMN "blockedAt"     TIMESTAMP(3),
  ADD COLUMN "blockedReason" TEXT,
  ADD COLUMN "blockedById"   TEXT;

-- Tenant-bound, like every other user reference in this schema: the pair has to
-- match a single User, so a block attributed to another organization's user is
-- refused by the database rather than trusted from whichever route wrote it.
--
-- RESTRICT rather than SET NULL, matching Conversation.assignedToId and
-- AuditLog.userId. SET NULL is not available here: the constraint spans
-- ("blockedById", "organizationId") and nulling it would have to null
-- organizationId too, which is NOT NULL.
ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_blockedById_organizationId_fkey"
  FOREIGN KEY ("blockedById", "organizationId")
  REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Read on every inbound message, which makes it the hottest lookup on this
-- table after phone. Partial: only blocked rows are ever the subject of the
-- query, and on a healthy workspace that is a rounding error of the table.
CREATE INDEX "Contact_organizationId_blockedAt_idx"
  ON "Contact"("organizationId", "blockedAt")
  WHERE "blockedAt" IS NOT NULL;

-- A block is a moderation action against a person; it is recorded, never
-- silent. Nothing is backfilled — every existing contact is unblocked, which is
-- the correct starting state and needs no data migration.

COMMIT;
