-- Dunning: overdue, then a deadline, then the service stops.
--
-- The only path from "hasn't paid" to "switched off" was markPaymentFailed(),
-- which suspends the organization in the same transaction that notices the
-- problem. No warning, no deadline, no chance to pay. That is defensible for a
-- provider webhook shouting FRAUD and wrong for an invoice that is four days
-- late.
--
-- `suspendAt` is the promise: service continues until this moment, and stops
-- after it unless the balance is cleared. Nullable, because most subscribers
-- are never in this state.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "suspendAt" TIMESTAMP(3);
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "suspendReason" TEXT;

-- Partial index: only the few organizations actually in grace are worth
-- indexing, and the dunning pass looks up exactly that set.
CREATE INDEX IF NOT EXISTS "Organization_suspendAt_idx"
  ON "Organization"("suspendAt")
  WHERE "suspendAt" IS NOT NULL;

-- Platform-wide settings, so the grace period is a decision the owner makes
-- rather than a constant someone has to redeploy to change.
--
-- Key/value rather than columns: the alternative is a one-row table that grows
-- a migration every time the platform gains a knob.
CREATE TABLE IF NOT EXISTS "PlatformSetting" (
  "key"       TEXT NOT NULL,
  "value"     TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy" TEXT,

  CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);
