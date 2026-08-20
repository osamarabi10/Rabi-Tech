-- Campaign audience targeting: store the ContactFilterDsl used to resolve recipients.
-- Null keeps existing behaviour (all non-archived contacts), so this is backfill-free.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "audienceFilter" JSONB;
