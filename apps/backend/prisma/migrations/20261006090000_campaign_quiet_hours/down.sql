-- Reverses 20261006090000_campaign_quiet_hours.
--
-- Cleanly reversible, and worth saying why for once rather than only warning:
-- these columns are configuration, not records. Dropping them loses a
-- subscriber's chosen window — an annoyance they can retype — and does not
-- destroy anything that happened. No broadcast, recipient or message row
-- references them.
--
-- The one consequence to be aware of is behavioural rather than destructive:
-- once the code is also reverted, broadcasts resume sending at any hour. A
-- subscriber who had quiet hours on will not be told they are off. If any
-- organization has enabled them, say so before reverting rather than after.
--
--   SELECT count(*) FROM "OrganizationConfig" WHERE "quietHoursEnabled";
--
-- Not raised as an exception here, deliberately — unlike the blocked-contacts
-- and mid-question reversals, nothing is stranded and nothing becomes
-- unrecoverable. A refusal would be theatre.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261006090000_campaign_quiet_hours';

BEGIN;

ALTER TABLE "OrganizationConfig"
  DROP CONSTRAINT IF EXISTS "OrganizationConfig_quietHoursEnd_check",
  DROP CONSTRAINT IF EXISTS "OrganizationConfig_quietHoursStart_check";

ALTER TABLE "OrganizationConfig"
  DROP COLUMN IF EXISTS "quietHoursEnd",
  DROP COLUMN IF EXISTS "quietHoursStart",
  DROP COLUMN IF EXISTS "quietHoursEnabled";

COMMIT;
