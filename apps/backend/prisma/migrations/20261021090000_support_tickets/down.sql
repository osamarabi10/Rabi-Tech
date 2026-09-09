-- Remove the support-ticket foundation only while it contains no customer data
-- and no platform content-access audit depends on its canonical ticket id.
-- A populated ticket, message, or audit row makes snapshot restore or a
-- forward repair the recovery path; silently dropping it is not rollback.

DO $do$
DECLARE
  ticket_rows bigint;
  message_rows bigint;
  audit_rows bigint;
BEGIN
  SELECT count(*) INTO ticket_rows FROM "SupportTicket";
  SELECT count(*) INTO message_rows FROM "SupportTicketMessage";
  SELECT count(*) INTO audit_rows
    FROM "PlatformAuditLog"
   WHERE "supportTicketId" IS NOT NULL OR "ticketAccessVersion" IS NOT NULL;

  IF ticket_rows > 0 OR message_rows > 0 OR audit_rows > 0 THEN
    RAISE EXCEPTION
      'Refusing: support-ticket rollback would erase % ticket(s), % message(s), and invalidate % platform audit row(s).',
      ticket_rows,
      message_rows,
      audit_rows;
  END IF;

  DROP TRIGGER "SupportTicket_guard_update" ON "SupportTicket";
  DROP FUNCTION "guard_support_ticket_update"();

  DROP TABLE "SupportTicketMessage";
  DROP TABLE "SupportTicket";
  DROP SEQUENCE "SupportTicket_reference_seq";

  DROP TYPE "SupportTicketAuthorType";
  DROP TYPE "SupportTicketMessageVisibility";
  DROP TYPE "SupportTicketPriority";
  DROP TYPE "SupportTicketStatus";

  DROP INDEX "PlatformAuditLog_supportTicketId_timestamp_idx";
  ALTER TABLE "PlatformAuditLog"
    DROP COLUMN "ticketAccessVersion",
    DROP COLUMN "supportTicketId";
END
$do$;
