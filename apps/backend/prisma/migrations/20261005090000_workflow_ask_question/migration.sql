-- P11.4: the Ask a Question workflow node.
--
-- The engine already pauses — WAIT_DELAY throws, the runner records
-- currentStepIndex and schedules a delayed BullMQ job to resume. That pause is
-- woken by a clock. This one is woken by the contact answering, which is a
-- different shape: the run has to be findable from an inbound message, and it
-- has to give up eventually if no answer ever comes.
--
-- Two columns and one index carry that. The timeout deliberately reuses the
-- existing delayed-job mechanism rather than adding a sweeper: an unanswered
-- question then costs nothing while it waits, exactly like a WAIT_DELAY.
--
-- `status` stays a free String — it already is — so the new AWAITING_REPLY
-- value needs no enum migration.

BEGIN;

ALTER TABLE "WorkflowExecution"
  -- Only meaningful while status = 'AWAITING_REPLY'. Lets the timeout job tell
  -- "no answer ever came" from "the answer came and this job is a stale
  -- duplicate", which status alone cannot answer once the run has moved on and
  -- paused again at a later step.
  ADD COLUMN "awaitingUntil" TIMESTAMP(3),
  -- Re-asks after an unusable answer. Deliberately not `depth`: that guards
  -- trigger loops, and spending it here would let a chatty contact exhaust the
  -- protection against a workflow re-firing itself.
  ADD COLUMN "awaitingAttempts" INTEGER NOT NULL DEFAULT 0;

-- Read on every inbound message from a contact with any workflow history.
-- contactId leads because status is low-cardinality and would not narrow.
CREATE INDEX "WorkflowExecution_organizationId_contactId_status_idx"
  ON "WorkflowExecution"("organizationId", "contactId", "status");

-- Nothing is backfilled. Every existing run is RUNNING, COMPLETED or FAILED;
-- none is awaiting an answer, and a default of 0 attempts is correct for all.

COMMIT;
