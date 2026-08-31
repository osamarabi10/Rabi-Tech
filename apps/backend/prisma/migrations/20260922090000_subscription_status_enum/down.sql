-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Unlike the invoice reference migration, this one is safe to roll back
-- indefinitely. enum -> text is lossless: every enum label is a valid string,
-- so no row loses information and rows written under the enum survive the
-- reversal unchanged. There is no point of no return here.
--
-- The asymmetry is worth stating, because it is the exception. Rolling forward
-- again is the constrained direction: the USING cast in migration.sql fails if
-- any row has picked up a value outside the six labels while the column was
-- text. That is the same protection working, not a defect.

ALTER TABLE "Subscription" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Subscription"
  ALTER COLUMN "status" TYPE TEXT
  USING "status"::TEXT;

ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Dropped last: the type cannot go while a column still uses it.
DROP TYPE "SubscriptionStatus";
