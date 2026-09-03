-- Reverses 20261014090000_workspaces_scope_enforcement.
--
-- This narrows contact identity back to one contact per number per
-- organization. That is only reversible while no organization has actually used
-- a second workspace, and the guards below are how this file tells the
-- difference — because by the time the constraint refuses, the reversal is
-- already half applied on a table nobody can write to.
--
-- Check before running:
--
--   SELECT count(*) FROM "Workspace" WHERE NOT "isDefault";
--   SELECT count(*) FROM (
--     SELECT "organizationId", "phone" FROM "Contact"
--     GROUP BY 1,2 HAVING count(DISTINCT "workspaceId") > 1) d;
--   SELECT count(*) FROM (
--     SELECT "organizationId", "email" FROM "Contact" WHERE "email" IS NOT NULL
--     GROUP BY 1,2 HAVING count(DISTINCT "workspaceId") > 1) d;
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261014090000_workspaces_scope_enforcement';

BEGIN;

DO $$
DECLARE
  extra_workspaces  bigint;
  duplicate_phones  bigint;
  duplicate_emails  bigint;
BEGIN
  -- Guard 1: is anybody using a second workspace?
  --
  -- Every workspace commit 1 created is the organization's default. A workspace
  -- that is not one was made deliberately, and narrowing the constraint while
  -- it exists means the next contact created in it can collide with a contact
  -- in the default workspace that has nothing to do with it.
  SELECT count(*) INTO extra_workspaces FROM "Workspace" WHERE NOT "isDefault";

  IF extra_workspaces > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % non-default workspace(s) exist. Narrowing contact '
      'identity back to one-per-organization while a second workspace is in use '
      'makes two unrelated people with the same number collide. Move that '
      'content into the default workspace and delete the extra workspaces first.',
      extra_workspaces;
  END IF;

  -- Guard 2: would the narrowed unique actually hold?
  --
  -- Guard 1 is about intent; this one is about the data. They are not the same
  -- question: a workspace could have been created, used, and deleted, leaving
  -- contacts behind that collide under the old rule. Asking the constraint's own
  -- question directly is the only answer that cannot be out of date, and
  -- discovering it here beats discovering it from a failed CREATE UNIQUE INDEX
  -- halfway through the reversal.
  SELECT count(*) INTO duplicate_phones FROM (
    SELECT "organizationId", "phone" FROM "Contact"
    GROUP BY 1, 2 HAVING count(DISTINCT "workspaceId") > 1) d;

  IF duplicate_phones > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % phone number(s) exist in more than one workspace of '
      'the same organization. Restoring the old unique index would fail partway '
      'through and leave the schema between two shapes. Merge or delete those '
      'contacts first — and decide deliberately which history survives, because '
      'this file cannot make that choice for you.',
      duplicate_phones;
  END IF;

  SELECT count(*) INTO duplicate_emails FROM (
    SELECT "organizationId", "email" FROM "Contact" WHERE "email" IS NOT NULL
    GROUP BY 1, 2 HAVING count(DISTINCT "workspaceId") > 1) d;

  IF duplicate_emails > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % email address(es) exist in more than one workspace of '
      'the same organization. Same reason as the phone check above.',
      duplicate_emails;
  END IF;
END $$;

-- Step 3 undone: the three indexes.
DROP INDEX IF EXISTS "WhatsappSession_organizationId_workspaceId_idx";
DROP INDEX IF EXISTS "Conversation_organizationId_workspaceId_isArchived_status_l_idx";
DROP INDEX IF EXISTS "Contact_organizationId_workspaceId_name_idx";

-- Step 2c undone: the composite foreign keys narrow back to two columns.
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversationId_organizationId_workspaceId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_sessionId_organizationId_workspaceId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_contactId_organizationId_workspaceId_fkey";

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_organizationId_fkey"
  FOREIGN KEY ("contactId", "organizationId")
  REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sessionId_organizationId_fkey"
  FOREIGN KEY ("sessionId", "organizationId")
  REFERENCES "WhatsappSession"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_organizationId_fkey"
  FOREIGN KEY ("conversationId", "organizationId")
  REFERENCES "Conversation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 2b undone: contact identity narrows. Guard 2 has already established
-- that these will succeed.
DROP INDEX IF EXISTS "Contact_organizationId_workspaceId_phone_key";
DROP INDEX IF EXISTS "Contact_organizationId_workspaceId_email_key";

-- Restored as UNIQUE CONSTRAINTs, both of them, which is deliberately NOT an
-- exact restoration.
--
-- Before this migration these two were different shapes in this database:
-- phone was a constraint, email a bare unique index. Both satisfy Prisma and
-- both enforce identically; the difference is an accident of which migration
-- created each. Reproducing the accident would mean recording it as intended.
-- The constraint form is what Prisma emits today, so a reversal converges on
-- one shape rather than restoring two.
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_phone_key" UNIQUE ("organizationId", "phone");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_email_key" UNIQUE ("organizationId", "email");

-- Step 2a undone: the three-column uniques.
DROP INDEX IF EXISTS "Conversation_id_organizationId_workspaceId_key";
DROP INDEX IF EXISTS "Contact_id_organizationId_workspaceId_key";
DROP INDEX IF EXISTS "WhatsappSession_id_organizationId_workspaceId_key";

-- Step 1 undone: the column goes back to nullable, which is commit 1's state.
-- The data stays; only the constraint is lifted, so re-applying this migration
-- afterwards needs no second backfill.
ALTER TABLE "Message" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "Conversation" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "Contact" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "WhatsappSession" ALTER COLUMN "workspaceId" DROP NOT NULL;

COMMIT;
