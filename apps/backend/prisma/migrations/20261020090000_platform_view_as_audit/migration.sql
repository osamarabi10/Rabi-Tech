ALTER TABLE "PlatformAuditLog"
  ADD COLUMN "route" TEXT,
  ADD COLUMN "ticketReference" TEXT;

CREATE INDEX "PlatformAuditLog_ticketReference_timestamp_idx"
  ON "PlatformAuditLog"("ticketReference", "timestamp");
