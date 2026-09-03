-- Reverses 20261013090000_workspaces_schema.
--
-- This migration is reversible in a way most are not: on the day it lands
-- nothing reads the columns it adds, so dropping them restores the previous
-- state exactly. That stops being true the moment somebody uses it. The two
-- guards below are how this file tells the difference, because "the migration
-- is new" and "the migration is unused" stop being the same sentence quickly
-- and nothing else in the system would notice.
--
-- Check before running:
--
--   SELECT count(*) FROM "Workspace" WHERE "id" <> 'ws_' || "organizationId";
--   SELECT count(*) FROM "WorkspaceMember" m
--     JOIN "User" u ON u."id" = m."userId" AND u."organizationId" = m."organizationId"
--     WHERE m."role" <> u."role";
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261013090000_workspaces_schema';

BEGIN;

DO $$
DECLARE
  created_workspaces bigint;
  diverged_roles     bigint;
BEGIN
  -- Guard 1: has anybody made a workspace?
  --
  -- Every workspace this migration created has the id 'ws_' || organizationId.
  -- A row that does not match was created by something else — commit 2, an
  -- operator, a customer — and it is the one thing here that a backup taken
  -- before the migration cannot return. Dropping the table would delete a
  -- division of somebody's account along with every row assigned to it.
  --
  -- This is exactly the property the derived id was chosen for: without it,
  -- this file could not tell its own rows from anybody else's.
  SELECT count(*) INTO created_workspaces
    FROM "Workspace" WHERE "id" <> 'ws_' || "organizationId";

  IF created_workspaces > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % workspace(s) exist that this migration did not create. '
      'They were made deliberately and dropping this table destroys them and the '
      'assignment of every row that points at them. Move that content back to the '
      'default workspace and delete them explicitly if reversal is really wanted.',
      created_workspaces;
  END IF;

  -- Guard 2: has anybody changed a role?
  --
  -- Step 6 copied User.role into WorkspaceMember.role, so on the day this ran
  -- the two were identical for every user and this count was zero. A non-zero
  -- count means the workspace model has become the place roles are edited, and
  -- User.role is now the stale copy. Dropping the table would silently revert
  -- every one of those edits to whatever User.role still says.
  --
  -- The copy in step 6 is what makes this measurable at all: had role been
  -- defaulted, there would be no baseline to diverge from and this guard could
  -- not exist.
  SELECT count(*) INTO diverged_roles
    FROM "WorkspaceMember" m
    JOIN "User" u ON u."id" = m."userId" AND u."organizationId" = m."organizationId"
    WHERE m."role" <> u."role";

  IF diverged_roles > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % workspace membership(s) carry a role that no longer '
      'matches User.role. Those are edits made after this migration ran, and '
      'dropping the table reverts them without telling anyone. Reconcile the two '
      'columns first, then reverse.',
      diverged_roles;
  END IF;
END $$;

-- Step 7 undone: the composite foreign keys.
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_workspaceId_organizationId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_workspaceId_organizationId_fkey";
ALTER TABLE "Contact" DROP CONSTRAINT IF EXISTS "Contact_workspaceId_organizationId_fkey";
ALTER TABLE "WhatsappSession" DROP CONSTRAINT IF EXISTS "WhatsappSession_workspaceId_organizationId_fkey";

-- Steps 6 and 5 undone: the column goes, and the backfill goes with it. No
-- separate UPDATE to NULL first — the column is being dropped, so writing to it
-- would be work whose only result is a longer lock.
ALTER TABLE "Message" DROP COLUMN IF EXISTS "workspaceId";
ALTER TABLE "Conversation" DROP COLUMN IF EXISTS "workspaceId";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "workspaceId";
ALTER TABLE "WhatsappSession" DROP COLUMN IF EXISTS "workspaceId";

-- Steps 4 to 1 undone. DROP TABLE takes the indexes and the foreign keys
-- declared on these tables with it; the constraints those tables received from
-- Organization and User are dropped by the same statement.
DROP INDEX IF EXISTS "Workspace_organizationId_default_partial_key";

DROP TABLE IF EXISTS "WorkspaceMember";
DROP TABLE IF EXISTS "Workspace";

COMMIT;
