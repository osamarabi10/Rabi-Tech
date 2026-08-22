-- A failed outbound message recorded only that it failed. The thread showed a
-- red cross and nothing else: no reason, and no way to try again short of
-- retyping the message. Both halves of that are fixed by keeping why.
--
-- Additive and nullable: every existing row keeps its current meaning, and a
-- NULL reason on a FAILED message simply means it failed before this column
-- existed.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
