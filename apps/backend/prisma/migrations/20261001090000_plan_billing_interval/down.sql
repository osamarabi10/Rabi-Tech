-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- CHECK BEFORE RUNNING. Dropping this column silently reinterprets every
-- yearly edition as monthly: the price stays the same number and starts being
-- charged twelve times as often. Nothing else in the schema records that an
-- edition was ever yearly, so this is not recoverable from the remaining data.
--
--   SELECT code, "monthlyPriceCents", "billingInterval"
--   FROM "Plan" WHERE "billingInterval" <> 'MONTHLY';
--
-- Any row returned is an edition whose price is a yearly figure. After this
-- migration is reversed, that figure is read as a monthly one.
--
-- Safe while every edition is MONTHLY, which is how this ships. The revision
-- history in PlatformAuditLog is untouched either way and still records when an
-- interval changed, so the fact is recoverable by reading — just not by the
-- code, which will have stopped asking.

ALTER TABLE "Plan" DROP COLUMN "billingInterval";
DROP TYPE "BillingInterval";
COMMENT ON COLUMN "Plan"."monthlyPriceCents" IS NULL;
