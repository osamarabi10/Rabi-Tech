-- Edition history becomes readable per edition.
--
-- Every edition change already writes a PlatformAuditLog row carrying full
-- beforeState and afterState snapshots, the actor, and a timestamp — which is
-- the whole of "what changed, when, by whom, and what it was before". What was
-- missing was a way to ask for one edition's history.
--
-- targetOrgId cannot serve: edition changes deliberately set it null, because
-- no subscriber was acted on and pretending otherwise would make the per-org
-- trail lie. The only other handle was the `reason` string ("edition GROWTH
-- updated"), and filtering history on a human-readable sentence is a query that
-- breaks the first time somebody improves the wording.
--
-- So a column, added while this table is smaller than it will ever be again.
-- Nullable and backfilled from the existing rows' afterState, which already
-- carries the code — no history is lost, and rows that are not about an edition
-- keep NULL, which is what they mean.

ALTER TABLE "PlatformAuditLog" ADD COLUMN "targetEditionCode" TEXT;

-- Backfill from what the snapshots already hold. Only edition actions; every
-- other row legitimately has no edition and stays NULL.
UPDATE "PlatformAuditLog"
SET "targetEditionCode" = "afterState"->>'code'
WHERE "action" IN ('platform.edition.updated', 'platform.edition.created')
  AND "afterState" IS NOT NULL
  AND "afterState"->>'code' IS NOT NULL;

-- Paired with timestamp because every read of this column is "this edition's
-- history, newest first". The existing (action, timestamp) index stays: it
-- serves the unfiltered history screen, which this one would not.
CREATE INDEX "PlatformAuditLog_targetEditionCode_timestamp_idx"
  ON "PlatformAuditLog" ("targetEditionCode", "timestamp");
