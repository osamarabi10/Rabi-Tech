-- Reverses 20261007090000_granular_user_restrictions.
--
-- **Check first, and the direction of the danger is the opposite of usual.**
--
-- Most reversals in this repository risk losing a record. This one risks
-- *granting access*. Dropping these columns removes every applied restriction,
-- so a user who was deliberately barred from exporting contacts or from
-- workspace settings silently regains both the moment the code is also
-- reverted. Nobody is notified, and the admin who applied the restriction is
-- the last to find out — the same shape as the blocked-contacts reversal, but
-- reaching further, because these narrow admins and supervisors rather than
-- customers.
--
--   SELECT count(*) FROM "User"
--   WHERE "restrictDataExport" OR "restrictContactDeletion" OR "restrictWorkspaceSettings";
--
-- Anything but 0 means somebody is relying on this. Export those rows before
-- reversing, so the restrictions can be reapplied rather than reconstructed
-- from memory. The DO block below refuses rather than granting silently, so a
-- reversal run without reading this comment still stops.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261007090000_granular_user_restrictions';

BEGIN;

DO $$
DECLARE
  restricted_count bigint;
BEGIN
  SELECT count(*) INTO restricted_count FROM "User"
  WHERE "restrictDataExport" OR "restrictContactDeletion" OR "restrictWorkspaceSettings";

  IF restricted_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % user(s) carry a restriction. Dropping these columns '
      'would silently grant them access again. Export the rows first.', restricted_count;
  END IF;
END $$;

ALTER TABLE "User"
  DROP COLUMN IF EXISTS "restrictWorkspaceSettings",
  DROP COLUMN IF EXISTS "restrictContactDeletion",
  DROP COLUMN IF EXISTS "restrictDataExport";

COMMIT;
