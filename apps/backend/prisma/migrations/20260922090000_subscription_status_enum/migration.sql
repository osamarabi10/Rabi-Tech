-- Subscription.status becomes an enum.
--
-- It was a String with the permitted values in a trailing comment. A comment
-- is a convention, not a constraint: a typo stored fine, and because every
-- access check tests for ACTIVE or TRIALING rather than against a closed set,
-- an unrecognised status reads as "not entitled" everywhere at once. A
-- subscription could stop granting access without any row looking wrong.
--
-- Every value below is one the code actually writes:
--   PENDING        column default
--   ACTIVE         activateManualSubscription
--   TRIALING       signup, trial path
--   MANUAL_REVIEW  paid activation the platform cannot self-confirm
--   PAST_DUE       markPaymentFailed
--   CANCELED       cancellation
--
-- Verified before writing: the live table holds only ACTIVE and MANUAL_REVIEW,
-- so the USING cast below cannot fail. On a database with other values it
-- would, loudly, which is the correct outcome — an unknown status is exactly
-- what this migration exists to make impossible.

CREATE TYPE "SubscriptionStatus" AS ENUM (
  'PENDING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'TRIALING',
  'MANUAL_REVIEW'
);

-- The default is dropped and re-added around the type change: PostgreSQL
-- cannot cast a column's existing text default to the new type in place.
ALTER TABLE "Subscription" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Subscription"
  ALTER COLUMN "status" TYPE "SubscriptionStatus"
  USING "status"::"SubscriptionStatus";

ALTER TABLE "Subscription" ALTER COLUMN "status" SET DEFAULT 'PENDING';
