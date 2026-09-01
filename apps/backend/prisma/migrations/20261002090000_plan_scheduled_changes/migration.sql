-- An edition's terms can change on a date rather than the instant somebody
-- clicks save.
--
-- Two columns rather than a PlanRevision table, and the reason is a constraint
-- this codebase has held since the catalogue moved out of a constant:
-- getEdition() is SYNCHRONOUS, and nineteen call sites depend on it — two of
-- them on the send path. "Which revision is in force now" is a time-dependent
-- read, and answering it per call would either make the accessor async or put a
-- query behind it. Instead refreshEditions resolves it once per refresh and the
-- accessor stays a map lookup.
--
-- The cost, stated rather than hidden: a schedule lands up to one refresh
-- interval late (30s by default). That is the correct trade for a price change
-- dated to a day.
--
-- scheduledChanges holds the same shape the PATCH body takes, validated by the
-- same code when it is scheduled, so a schedule cannot store something the
-- immediate path would have refused.
--
-- WHAT "IN FORCE" MEANS, which is the part that surprises people and is written
-- here because it is not obvious from the columns:
--
--   * price, name, seats, flags, channels, pacing — reach existing subscribers
--     at the next cache refresh, scheduled or immediate alike.
--   * the five metered usage limits — do NOT reach existing subscribers at all
--     until their next activation, because applyPlanLimits copied the previous
--     values into OrganizationConfig and enforcement reads that copy. See D-14.
--
-- Effective dating does not change that split. It changes WHEN the catalogue
-- moves, not who the move reaches.

ALTER TABLE "Plan" ADD COLUMN "scheduledChanges" JSONB;
ALTER TABLE "Plan" ADD COLUMN "scheduledFrom" TIMESTAMP(3);

COMMENT ON COLUMN "Plan"."scheduledChanges" IS
  'Pending edit, in the shape of a PATCH body, applied by refreshEditions once scheduledFrom has passed. Cleared on application.';

-- Partial: only rows with something pending are ever selected by it, and that
-- is a handful at most against a five-row table today.
CREATE INDEX "Plan_scheduledFrom_idx" ON "Plan" ("scheduledFrom") WHERE "scheduledFrom" IS NOT NULL;
