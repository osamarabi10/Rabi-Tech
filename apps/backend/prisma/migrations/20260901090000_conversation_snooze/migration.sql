-- Snoozing a conversation.
--
-- "Deal with this on Tuesday" had nowhere to live. An agent's only options were
-- to leave a thread open — where it sits in the queue looking like work nobody
-- has started — or resolve it, which tells the customer it is finished and
-- sends them a rating request.
--
-- A timestamp rather than a boolean plus a job: a conversation is snoozed while
-- `snoozedUntil` is in the future, and simply is not once it passes. There is no
-- worker to fall over, no queue to drain, and no window during which the row
-- says one thing and the truth is another.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "snoozedUntil" TIMESTAMP(3);

-- Who snoozed it, for the activity trail. Denormalised name so the entry stays
-- readable after the user is deleted.
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "snoozedByName" TEXT;

-- Partial index: only rows that are actually snoozed are worth indexing, and
-- that set is small next to the table.
CREATE INDEX IF NOT EXISTS "Conversation_organizationId_snoozedUntil_idx"
  ON "Conversation"("organizationId", "snoozedUntil")
  WHERE "snoozedUntil" IS NOT NULL;
