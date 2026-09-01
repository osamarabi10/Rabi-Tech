-- Reverses 20261003090000_contact_blocking.
--
-- Safe while no contact is blocked. **It is not safe once one is**, and the
-- failure is silent rather than loud: dropping these columns discards the fact
-- that somebody was blocked, and the inbound worker — once its code is also
-- reverted — starts accepting their messages again. Nobody is notified, and the
-- person who blocked them is the last to find out.
--
-- Check before running this. It is one query:
--
--   SELECT count(*) FROM "Contact" WHERE "blockedAt" IS NOT NULL;
--
-- If it returns anything but 0, export those rows first, or forward-fix instead.
-- Reversing schema is recoverable; silently un-blocking a harasser is not.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only, so
-- undoing the SQL is not enough:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261003090000_contact_blocking';

BEGIN;

DROP INDEX IF EXISTS "Contact_organizationId_blockedAt_idx";

ALTER TABLE "Contact"
  DROP CONSTRAINT IF EXISTS "Contact_blockedById_organizationId_fkey";

ALTER TABLE "Contact"
  DROP COLUMN IF EXISTS "blockedById",
  DROP COLUMN IF EXISTS "blockedReason",
  DROP COLUMN IF EXISTS "blockedAt";

COMMIT;
