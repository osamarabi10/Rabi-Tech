-- Reverses 20261008120000_api_token_masking.
--
-- **This reversal widens access.** Dropping the column does not merely forget a
-- setting: every token issued by a masked admin stops masking, and starts
-- returning the phone numbers and email addresses that user is not permitted to
-- see. Nothing fails, nothing logs, and the data flows to whatever third-party
-- software holds the token.
--
--   SELECT count(*) FROM "ApiToken"
--   WHERE "maskContactDetails" = true AND "revokedAt" IS NULL;
--
-- Anything but 0 means live tokens are relying on this. Revoke them first if
-- the reversal is genuinely intended; the DO block refuses otherwise.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261008120000_api_token_masking';

BEGIN;

DO $$
DECLARE
  masked_count bigint;
BEGIN
  SELECT count(*) INTO masked_count
  FROM "ApiToken" WHERE "maskContactDetails" = true AND "revokedAt" IS NULL;

  IF masked_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % live token(s) are masking contact details. Dropping '
      'this column would silently unmask them to third-party software. Revoke '
      'them deliberately first if that is the intent.', masked_count;
  END IF;
END $$;

ALTER TABLE "ApiToken" DROP COLUMN IF EXISTS "maskContactDetails";

COMMIT;
