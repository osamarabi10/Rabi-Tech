-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- ============================ CHECK BEFORE RUNNING ============================
--
-- Dropping these columns DISCARDS EVERY PENDING SCHEDULE, silently. A price
-- rise dated to next month simply never happens, and nothing anywhere reports
-- that it was lost — the edition keeps its current values and looks correct.
-- That is the failure this pre-check exists to prevent.
--
-- Run this FIRST. If it returns any row, do not run the rollback until each one
-- has been either applied by hand or deliberately abandoned:
--
--   SELECT code, "scheduledFrom", "scheduledChanges"
--   FROM "Plan"
--   WHERE "scheduledFrom" IS NOT NULL
--   ORDER BY "scheduledFrom";
--
-- Each row is a decision somebody made about a future date. The values are in
-- scheduledChanges and can be applied manually with a normal PATCH; what cannot
-- be recovered afterwards is the knowledge that they were meant to happen.
--
-- APPLIED schedules are not at risk. Applying one writes the values into the
-- row and records a platform.edition.scheduled_applied entry in
-- PlatformAuditLog, which this migration does not touch. Only the pending ones
-- live in these columns.

ALTER TABLE "Plan" DROP COLUMN "scheduledChanges";
ALTER TABLE "Plan" DROP COLUMN "scheduledFrom";
DROP INDEX IF EXISTS "Plan_scheduledFrom_idx";
