-- Reverses 20261015090000_plan_max_workspaces.
--
-- Guarded, because the column may carry a platform owner's deliberate edit by
-- the time anybody reverses. The seeded values are recoverable from the
-- catalogue in plans.ts; a hand-set ceiling for one customer is not, and it is
-- exactly the kind of commercial arrangement nobody writes down twice.
--
-- Check before running:
--
--   SELECT "code", "maxWorkspaces" FROM "Plan" ORDER BY "code";
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261015090000_plan_max_workspaces';

BEGIN;

DO $$
DECLARE
  edited bigint;
BEGIN
  -- Anything not equal to what the migration seeded was changed afterwards.
  -- ENTERPRISE is excluded because null is what it was seeded with.
  SELECT count(*) INTO edited FROM "Plan"
   WHERE ("code" IN ('FREE', 'STANDARD', 'GROWTH') AND "maxWorkspaces" IS DISTINCT FROM 1)
      OR ("code" = 'BUSINESS' AND "maxWorkspaces" IS DISTINCT FROM 5)
      OR ("code" = 'ENTERPRISE' AND "maxWorkspaces" IS NOT NULL);

  IF edited > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % plan row(s) carry a maxWorkspaces this migration did not set. '
      'Someone changed an edition ceiling after it shipped, which is a commercial decision '
      'this column is the only record of. Write it down somewhere else before dropping it.',
      edited;
  END IF;
END $$;

ALTER TABLE "Plan" DROP COLUMN IF EXISTS "maxWorkspaces";

COMMIT;
