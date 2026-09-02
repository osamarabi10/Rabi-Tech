-- Reverses 20261011090000_restrict_integrations.
--
-- **This reversal widens access.** Dropping the column does not merely forget a
-- preference: every user an admin had restricted from integration settings
-- regains the ability to mint API keys, add webhook endpoints and connect
-- channels. Nothing fails and nothing logs; the checkbox simply stops existing
-- and the permission comes back.
--
--   SELECT count(*) FROM "User" WHERE "restrictIntegrations" = true;
--
-- Anything but 0 means somebody is relying on this.
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261011090000_restrict_integrations';

BEGIN;

DO $$
DECLARE
  restricted_count bigint;
BEGIN
  SELECT count(*) INTO restricted_count FROM "User" WHERE "restrictIntegrations" = true;

  IF restricted_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % user(s) are restricted from integration settings. '
      'Dropping this column silently returns that access. Clear the flags '
      'deliberately first if that is the intent.', restricted_count;
  END IF;
END $$;

ALTER TABLE "User" DROP COLUMN IF EXISTS "restrictIntegrations";

COMMIT;
