-- Reverses 20261009090000_webhook_endpoints.
--
-- **Check first.** Dropping this table silently stops every outbound webhook a
-- subscriber has configured. Their software simply stops being told anything —
-- no error on their side, no error on ours, and the signing secrets are gone,
-- so re-creating the endpoints means reconfiguring every receiver by hand.
--
--   SELECT count(*) FROM "WebhookEndpoint" WHERE "isActive" = true;
--
-- Anything but 0 means live integrations depend on this.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261009090000_webhook_endpoints';

BEGIN;

DO $$
DECLARE
  live_count bigint;
BEGIN
  SELECT count(*) INTO live_count FROM "WebhookEndpoint" WHERE "isActive" = true;

  IF live_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % active webhook endpoint(s) exist. Dropping them stops '
      'subscriber integrations silently and destroys their signing secrets. '
      'Deactivate them deliberately first if that is the intent.', live_count;
  END IF;
END $$;

ALTER TABLE "WebhookDeliveryLog" DROP COLUMN IF EXISTS "attempt";
DROP TABLE IF EXISTS "WebhookEndpoint";

COMMIT;
