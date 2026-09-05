-- Reverse the session-to-channel binding.
--
-- Drops the constraint, the index and the column — but only after proving that
-- the rows it is about to discard are exactly the rows the migration created.
--
-- Guard 1 refuses when there is no audit trail. Without the recorded counts
-- this script cannot tell a backfilled binding from one a customer chose, and
-- dropping the column would throw both away with no way to know it happened.
--
-- Guard 2 refuses when the number of bound sessions has changed. Every creation
-- path sets channelId now, so a single number connected since the migration
-- moves this count — and that binding is a real decision, not something a
-- reversal is entitled to delete. Both directions are refused: a higher count
-- means new bindings exist, a lower one means bindings were removed by
-- something this script did not do and cannot reason about.

DO $do$
DECLARE
  recorded  integer;
  present   integer;
  rows      integer;
BEGIN
  SELECT count(*) INTO rows
    FROM "PlatformAuditLog"
   WHERE action = 'whatsapp-session.channel-backfilled';

  IF rows = 0 THEN
    RAISE EXCEPTION
      'Refusing: found 0 whatsapp-session.channel-backfilled audit rows, so there is no record of how many sessions this migration bound. Dropping the column would discard every binding, including any chosen since, with nothing left to say so.';
  END IF;

  SELECT ("afterState" ->> 'bound')::integer INTO recorded
    FROM "PlatformAuditLog"
   WHERE action = 'whatsapp-session.channel-backfilled'
   ORDER BY timestamp DESC
   LIMIT 1;

  SELECT count(*) INTO present
    FROM "WhatsappSession"
   WHERE "channelId" IS NOT NULL;

  IF present <> recorded THEN
    RAISE EXCEPTION
      'Refusing: the migration bound % sessions, but % are bound now. Sessions have been bound or unbound since, and this script did not touch them — reversing would discard a decision it cannot account for.',
      recorded, present;
  END IF;

  ALTER TABLE "WhatsappSession" DROP CONSTRAINT "WhatsappSession_channelId_organizationId_fkey";
  DROP INDEX "WhatsappSession_organizationId_channelId_idx";
  ALTER TABLE "WhatsappSession" DROP COLUMN "channelId";

  DELETE FROM "PlatformAuditLog"
   WHERE action = 'whatsapp-session.channel-backfilled';
END
$do$;
