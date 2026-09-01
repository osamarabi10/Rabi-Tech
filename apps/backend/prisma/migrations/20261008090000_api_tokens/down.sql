-- Reverses 20261008090000_api_tokens.
--
-- **Check first. The danger here is silent breakage of somebody else's system.**
--
-- Dropping this table destroys every API credential a subscriber has issued.
-- Their integrations stop authenticating at once, and — unlike most reversals
-- in this repository — the failure surfaces in *their* software, not ours. They
-- get 401s from a system that was working, with nothing on our side saying why,
-- and the tokens cannot be restored because only the hashes were ever stored.
-- New tokens must be issued and every integration reconfigured by hand.
--
--   SELECT count(*) FROM "ApiToken" WHERE "revokedAt" IS NULL;
--
-- Anything but 0 means live integrations depend on this. The DO block refuses
-- rather than breaking them silently.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261008090000_api_tokens';

BEGIN;

DO $$
DECLARE
  live_count bigint;
BEGIN
  SELECT count(*) INTO live_count FROM "ApiToken" WHERE "revokedAt" IS NULL;

  IF live_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % live API token(s) exist. Dropping them breaks '
      'subscriber integrations with no way to restore the secrets. Revoke them '
      'deliberately first if that is the intent.', live_count;
  END IF;
END $$;

DROP TABLE IF EXISTS "ApiToken";

COMMIT;
