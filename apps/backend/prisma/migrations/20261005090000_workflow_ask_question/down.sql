-- Reverses 20261005090000_workflow_ask_question.
--
-- **Check first.** Dropping these columns while any run is mid-question strands
-- it: the row keeps `status = 'AWAITING_REPLY'` with nothing recording when it
-- should give up, so it waits forever and the customer's answer resumes
-- nothing. Nobody is told, because from every screen the workflow simply
-- appears not to have finished.
--
--   SELECT count(*) FROM "WorkflowExecution" WHERE "status" = 'AWAITING_REPLY';
--
-- If that returns anything but 0, decide what those runs should do before
-- reversing. Marking them FAILED is honest; leaving them is not. The DO block
-- below refuses rather than stranding them silently, so a reversal run without
-- reading this comment still stops.
--
-- The ASK_QUESTION steps inside stored workflow definitions are NOT touched.
-- They live in `Workflow.definition` as JSON, and this reversal leaves them
-- there deliberately: destroying a subscriber's automation because the engine
-- was rolled back would be a far worse outcome than a step the engine
-- temporarily refuses. Once the code is reverted those steps fail validation on
-- next save, which is visible and recoverable. Silently rewriting somebody's
-- workflow is neither.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261005090000_workflow_ask_question';

BEGIN;

DO $$
DECLARE
  waiting_count bigint;
BEGIN
  SELECT count(*) INTO waiting_count
  FROM "WorkflowExecution" WHERE "status" = 'AWAITING_REPLY';

  IF waiting_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % run(s) are awaiting a contact reply. Dropping these '
      'columns would strand them waiting forever. Resolve them first.', waiting_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "WorkflowExecution_organizationId_contactId_status_idx";

ALTER TABLE "WorkflowExecution"
  DROP COLUMN IF EXISTS "awaitingAttempts",
  DROP COLUMN IF EXISTS "awaitingUntil";

COMMIT;
