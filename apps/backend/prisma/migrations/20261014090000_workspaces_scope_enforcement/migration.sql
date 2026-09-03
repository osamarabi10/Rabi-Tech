-- Workspaces, commit 2a: scope enforcement.
--
-- Commit 1 created the column, backfilled it and constrained it while nothing
-- read it. This commit makes it mandatory, widens the constraints that assumed
-- one contact per number per organization, and teaches the scope extension to
-- inject it. One migration, because a NOT NULL column the application does not
-- populate is an outage and the two halves cannot ship apart.
--
-- With one workspace per organization — which is every organization today —
-- this is behaviour-identical to what ran before it. That is what makes it
-- safe to land without the UI that comes in 2b.
--
-- ## The semantic change, stated plainly
--
-- @@unique([organizationId, phone]) becomes [organizationId, workspaceId,
-- phone]. The same number in two workspaces is now two contacts, sharing
-- nothing: not tags, not consent, not history. They are two relationships that
-- happen to reach the same handset, and the product's position is that they
-- should not see each other.
--
-- ## Why SET NOT NULL is written the long way (step 1)
--
-- A bare ALTER COLUMN ... SET NOT NULL takes ACCESS EXCLUSIVE and scans the
-- whole table under it, so every reader and writer waits for the scan. A CHECK
-- constraint added NOT VALID and then VALIDATEd does the same scan under SHARE
-- UPDATE EXCLUSIVE, which concurrent reads and writes do not block on, and
-- PostgreSQL then accepts that validated constraint as proof and skips the scan
-- SET NOT NULL would otherwise do.
--
-- Measured on this server (15.19) against a two-million-row table:
--
--   bare SET NOT NULL                          122.5 ms   ACCESS EXCLUSIVE
--   ADD CONSTRAINT ... CHECK ... NOT VALID      15.1 ms   brief
--   VALIDATE CONSTRAINT                        219.6 ms   SHARE UPDATE EXCLUSIVE
--   SET NOT NULL (with the validated CHECK)      4.2 ms   ACCESS EXCLUSIVE
--
-- More total work, roughly thirty times less of it under the lock that blocks
-- the application. The CHECK is dropped afterwards because the NOT NULL now
-- says the same thing and two statements of one rule drift apart.
--
-- ## Deliberately NOT widened
--
-- Conversation (organizationId, displayId). displayId is 1000 + an
-- organization-level OrgSequence and is the number a customer quotes back at
-- an agent. Per-workspace numbering would need a per-workspace counter — that
-- is behaviour, not a constraint — and would let two workspaces both hold a
-- "conversation 47" inside one organization the customer deals with as one
-- company. Gaps in a workspace's numbering are harmless; an ambiguous
-- reference is not.
--
-- Message (organizationId, waMessageId). The id comes from the provider and is
-- globally unique there, so organization scope already disambiguates it. Three
-- delivery-status callbacks look it up knowing only the organization —
-- openwa.webhook.ts:183 and :337, meta.webhook.ts:260 — and no workspace is
-- available at that point. Widening would break status handling to buy
-- disambiguation the identifier does not need.
--
-- WhatsappSession (organizationId, sessionName) and (organizationId,
-- phoneNumber). One physical number, one gateway. Widening would let the data
-- model represent two workspaces owning the same number, which the gateway
-- cannot be in. A constraint permitting an impossible reality is worse than a
-- restrictive one.
--
-- ## No Message workspace index
--
-- Message reads reach rows through conversationId, which is already selective,
-- and the existing (organizationId, conversationId, timestamp) index leads with
-- the columns those queries filter on. There is no query a workspace-leading
-- index on Message would serve, and an index with no query is the defect this
-- repository has a rule about.

-- Step 1: workspaceId becomes mandatory on the four, one table at a time.
--
-- Each block is: add the CHECK unvalidated (instant), validate it under a weak
-- lock, let SET NOT NULL take the validated constraint as proof, then drop the
-- CHECK now that NOT NULL carries the rule.

ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_workspaceId_not_null"
  CHECK ("workspaceId" IS NOT NULL) NOT VALID;
ALTER TABLE "WhatsappSession" VALIDATE CONSTRAINT "WhatsappSession_workspaceId_not_null";
ALTER TABLE "WhatsappSession" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "WhatsappSession" DROP CONSTRAINT "WhatsappSession_workspaceId_not_null";

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_not_null"
  CHECK ("workspaceId" IS NOT NULL) NOT VALID;
ALTER TABLE "Contact" VALIDATE CONSTRAINT "Contact_workspaceId_not_null";
ALTER TABLE "Contact" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Contact" DROP CONSTRAINT "Contact_workspaceId_not_null";

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_not_null"
  CHECK ("workspaceId" IS NOT NULL) NOT VALID;
ALTER TABLE "Conversation" VALIDATE CONSTRAINT "Conversation_workspaceId_not_null";
ALTER TABLE "Conversation" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_workspaceId_not_null";

ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_not_null"
  CHECK ("workspaceId" IS NOT NULL) NOT VALID;
ALTER TABLE "Message" VALIDATE CONSTRAINT "Message_workspaceId_not_null";
ALTER TABLE "Message" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "Message" DROP CONSTRAINT "Message_workspaceId_not_null";

-- Step 2a: the three-column uniques the widened foreign keys reference.
--
-- The two-column (id, organizationId) uniques stay. Around thirty other tables
-- reference these three that way and none of them are workspace-scoped; those
-- relations are correct as they are and widening them is not this commit.
CREATE UNIQUE INDEX "WhatsappSession_id_organizationId_workspaceId_key"
  ON "WhatsappSession"("id", "organizationId", "workspaceId");
CREATE UNIQUE INDEX "Contact_id_organizationId_workspaceId_key"
  ON "Contact"("id", "organizationId", "workspaceId");
CREATE UNIQUE INDEX "Conversation_id_organizationId_workspaceId_key"
  ON "Conversation"("id", "organizationId", "workspaceId");

-- Step 2b: the contact identity uniques widen. This is the semantic change.
-- Dropped without assuming which form they take, because in this database they
-- do not take the same one.
--
-- A Prisma @@unique can exist as a UNIQUE CONSTRAINT with an index underneath
-- it, or as a bare unique index; Prisma is satisfied by either and its own diff
-- output emits both spellings depending on the migration that created it.
-- Measured here: Contact_organizationId_phone_key is a constraint
-- (pg_constraint.contype = 'u') and Contact_organizationId_email_key is an index
-- only — two spellings of the same declaration, on one table.
--
-- Guessing cost two failed runs. DROP INDEX on the constraint form fails with
-- 2BP01 because the constraint owns the index; DROP CONSTRAINT on the index
-- form fails with 42704 because there is no constraint of that name. Neither is
-- recoverable by picking the other spelling and hoping, because a different
-- environment may have inherited the opposite shape from a different migration.
-- So both spellings are attempted for each name, in the order that matters:
-- DROP CONSTRAINT first, because dropping a constraint takes its index with it,
-- then DROP INDEX for the bare form. Each is IF EXISTS, so whichever does not
-- apply is a no-op rather than an error. Four flat statements, no PL/pgSQL.
--
-- The cost of IF EXISTS is that a mistyped name would drop nothing, report
-- success, and leave the old narrow unique standing with the semantic change
-- silently not made. That is not left to inspection: the workspace harness
-- asserts the old uniques are absent and the widened ones present, so the check
-- is a permanent gate rather than a one-time reading of this file.
ALTER TABLE "Contact" DROP CONSTRAINT IF EXISTS "Contact_organizationId_phone_key";
DROP INDEX IF EXISTS "Contact_organizationId_phone_key";
ALTER TABLE "Contact" DROP CONSTRAINT IF EXISTS "Contact_organizationId_email_key";
DROP INDEX IF EXISTS "Contact_organizationId_email_key";

CREATE UNIQUE INDEX "Contact_organizationId_workspaceId_phone_key"
  ON "Contact"("organizationId", "workspaceId", "phone");
CREATE UNIQUE INDEX "Contact_organizationId_workspaceId_email_key"
  ON "Contact"("organizationId", "workspaceId", "email");

-- Step 2c: the composite foreign keys between the four widen.
--
-- This is what makes workspace isolation a property of the database rather than
-- of the code that queries it. A conversation whose contact belongs to another
-- workspace is now unrepresentable, in the same way a conversation whose
-- contact belongs to another organization already was. App-level checks are not
-- the boundary; these are.
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_contactId_organizationId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT "Conversation_sessionId_organizationId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT "Message_conversationId_organizationId_fkey";

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_organizationId_workspaceId_fkey"
  FOREIGN KEY ("contactId", "organizationId", "workspaceId")
  REFERENCES "Contact"("id", "organizationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sessionId_organizationId_workspaceId_fkey"
  FOREIGN KEY ("sessionId", "organizationId", "workspaceId")
  REFERENCES "WhatsappSession"("id", "organizationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_organizationId_workspaceId_fkey"
  FOREIGN KEY ("conversationId", "organizationId", "workspaceId")
  REFERENCES "Conversation"("id", "organizationId", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 3: three indexes, each named with the query that justifies it.
--
-- The contacts list. GET /api/contacts orders by name within one workspace, and
-- every Contact read now carries workspaceId, so (organizationId, name) is no
-- longer led by the columns the query filters on.
CREATE INDEX "Contact_organizationId_workspaceId_name_idx"
  ON "Contact"("organizationId", "workspaceId", "name");

-- The inbox list. GET /api/conversations filters isArchived and status and
-- orders by lastMessageAt, now within a workspace.
CREATE INDEX "Conversation_organizationId_workspaceId_isArchived_status_l_idx"
  ON "Conversation"("organizationId", "workspaceId", "isArchived", "status", "lastMessageAt");

-- The channels list, and the inbound worker, which resolves a session's
-- workspace on every single message that arrives.
CREATE INDEX "WhatsappSession_organizationId_workspaceId_idx"
  ON "WhatsappSession"("organizationId", "workspaceId");
