-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Safe while every edition still holds null, which is how they ship. Lossy the
-- moment an owner sets a real AI allowance on one: dropping these columns
-- deletes that number, and any OrganizationConfig value written from it stays
-- behind with nothing to explain where it came from or how to reproduce it.
--
-- Check before running:
--
--   SELECT code, "monthlyAiTokensInLimit", "monthlyAiTokensOutLimit"
--   FROM "Plan"
--   WHERE "monthlyAiTokensInLimit" IS NOT NULL
--      OR "monthlyAiTokensOutLimit" IS NOT NULL;
--
-- Any row returned means the allowance was set deliberately and reversing this
-- discards it.

ALTER TABLE "Plan"
  DROP COLUMN "monthlyAiTokensInLimit",
  DROP COLUMN "monthlyAiTokensOutLimit";
