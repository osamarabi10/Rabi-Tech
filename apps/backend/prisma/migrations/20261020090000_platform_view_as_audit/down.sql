-- Remove the structured fields used by time-bounded platform view grants.
--
-- Once either field contains data, dropping it would erase the reason a staff
-- member entered a customer's workspace or the support case that authorised
-- that entry. Refuse that loss instead of presenting a destructive rollback
-- as a reversible migration.

DO $do$
DECLARE
  populated_rows integer;
BEGIN
  SELECT count(*) INTO populated_rows
    FROM "PlatformAuditLog"
   WHERE "route" IS NOT NULL OR "ticketReference" IS NOT NULL;

  IF populated_rows > 0 THEN
    RAISE EXCEPTION
      'Refusing: % platform audit row(s) contain a route or ticket reference. Dropping these columns would erase customer-content access evidence.',
      populated_rows;
  END IF;

  DROP INDEX "PlatformAuditLog_ticketReference_timestamp_idx";
  ALTER TABLE "PlatformAuditLog"
    DROP COLUMN "ticketReference",
    DROP COLUMN "route";
END
$do$;
