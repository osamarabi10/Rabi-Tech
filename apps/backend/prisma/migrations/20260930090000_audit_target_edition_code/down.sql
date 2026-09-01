-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Safe. The column is derived: every value in it was backfilled from
-- afterState->>'code', and afterState is untouched by this migration and by its
-- reversal. Dropping it loses an index and a query path, not history — the
-- history is the snapshots, and they stay.
--
-- What stops working is per-edition filtering. The history screen falls back to
-- the (action, timestamp) index and the caller must filter client-side, which
-- is exactly where this started.

DROP INDEX IF EXISTS "PlatformAuditLog_targetEditionCode_timestamp_idx";
ALTER TABLE "PlatformAuditLog" DROP COLUMN "targetEditionCode";
