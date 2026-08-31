-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Safe while nothing is archived, which is how this ships. Lossy afterwards:
-- dropping the column discards *when* each edition was withdrawn, and an
-- archived edition reappears in the console as merely deactivated — or as
-- fully active, if `isActive` was never set alongside it.
--
-- Check before running:
--
--   SELECT code, "archivedAt", "isActive" FROM "Plan" WHERE "archivedAt" IS NOT NULL;
--
-- Any row returned was archived deliberately, and this forgets that decision
-- rather than reversing it.
--
-- Nothing about resolution changes either way. Archived editions resolve, and
-- they resolve after this too, because resolution never depended on the column.

ALTER TABLE "Plan" DROP COLUMN "archivedAt";
