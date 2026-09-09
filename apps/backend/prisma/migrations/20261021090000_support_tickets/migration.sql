CREATE TYPE "SupportTicketStatus" AS ENUM (
  'OPEN',
  'IN_PROGRESS',
  'WAITING_ON_CUSTOMER',
  'RESOLVED',
  'CLOSED'
);

CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "SupportTicketMessageVisibility" AS ENUM ('PUBLIC', 'INTERNAL');
CREATE TYPE "SupportTicketAuthorType" AS ENUM ('CUSTOMER', 'PLATFORM');

CREATE SEQUENCE "SupportTicket_reference_seq" START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE TABLE "SupportTicket" (
  "id"                        TEXT NOT NULL,
  "reference"                 TEXT NOT NULL,
  "organizationId"            TEXT NOT NULL,
  "subject"                   TEXT NOT NULL,
  "status"                    "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
  "priority"                  "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
  "requesterUserId"           TEXT,
  "requesterName"             TEXT NOT NULL,
  "requesterEmail"            TEXT NOT NULL,
  "assigneeIdentityId"        TEXT,
  "diagnosticSnapshotVersion" INTEGER NOT NULL DEFAULT 1,
  "diagnosticSnapshot"        JSONB NOT NULL,
  "contentAccessVersion"      INTEGER NOT NULL DEFAULT 1,
  "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                 TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicket_reference_format_check"
    CHECK ("reference" ~ '^SUP-[0-9]{6,}$'),
  CONSTRAINT "SupportTicket_subject_length_check"
    CHECK (char_length(btrim("subject")) BETWEEN 4 AND 160),
  CONSTRAINT "SupportTicket_requester_email_length_check"
    CHECK (char_length(btrim("requesterEmail")) BETWEEN 3 AND 320),
  CONSTRAINT "SupportTicket_snapshot_version_check"
    CHECK ("diagnosticSnapshotVersion" >= 1),
  CONSTRAINT "SupportTicket_content_access_version_check"
    CHECK ("contentAccessVersion" >= 1)
);

CREATE UNIQUE INDEX "SupportTicket_reference_key" ON "SupportTicket"("reference");
CREATE UNIQUE INDEX "SupportTicket_id_organizationId_key"
  ON "SupportTicket"("id", "organizationId");
CREATE INDEX "SupportTicket_organizationId_status_updatedAt_idx"
  ON "SupportTicket"("organizationId", "status", "updatedAt");
CREATE INDEX "SupportTicket_assigneeIdentityId_status_updatedAt_idx"
  ON "SupportTicket"("assigneeIdentityId", "status", "updatedAt");
CREATE INDEX "SupportTicket_priority_status_updatedAt_idx"
  ON "SupportTicket"("priority", "status", "updatedAt");

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicket"
  ADD CONSTRAINT "SupportTicket_assigneeIdentityId_fkey"
  FOREIGN KEY ("assigneeIdentityId") REFERENCES "Identity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SupportTicketMessage" (
  "id"               TEXT NOT NULL,
  "ticketId"         TEXT NOT NULL,
  "organizationId"   TEXT NOT NULL,
  "visibility"       "SupportTicketMessageVisibility" NOT NULL,
  "authorType"       "SupportTicketAuthorType" NOT NULL,
  "authorUserId"     TEXT,
  "authorIdentityId" TEXT,
  "authorName"       TEXT NOT NULL,
  "authorEmail"      TEXT,
  "body"             TEXT NOT NULL,
  "emailOutboxId"    TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SupportTicketMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportTicketMessage_body_length_check"
    CHECK (char_length(btrim("body")) BETWEEN 1 AND 10000),
  CONSTRAINT "SupportTicketMessage_internal_author_check"
    CHECK ("visibility" <> 'INTERNAL' OR "authorType" = 'PLATFORM'),
  CONSTRAINT "SupportTicketMessage_outbox_visibility_check"
    CHECK (
      "emailOutboxId" IS NULL OR
      ("visibility" = 'PUBLIC' AND "authorType" = 'PLATFORM')
    )
);

CREATE UNIQUE INDEX "SupportTicketMessage_emailOutboxId_key"
  ON "SupportTicketMessage"("emailOutboxId");
CREATE UNIQUE INDEX "SupportTicketMessage_id_organizationId_key"
  ON "SupportTicketMessage"("id", "organizationId");
CREATE INDEX "SupportTicketMessage_organizationId_ticketId_createdAt_idx"
  ON "SupportTicketMessage"("organizationId", "ticketId", "createdAt");
CREATE INDEX "SupportTicketMessage_ticketId_visibility_createdAt_idx"
  ON "SupportTicketMessage"("ticketId", "visibility", "createdAt");
CREATE INDEX "SupportTicketMessage_authorIdentityId_createdAt_idx"
  ON "SupportTicketMessage"("authorIdentityId", "createdAt");

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_ticketId_organizationId_fkey"
  FOREIGN KEY ("ticketId", "organizationId")
  REFERENCES "SupportTicket"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_authorIdentityId_fkey"
  FOREIGN KEY ("authorIdentityId") REFERENCES "Identity"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SupportTicketMessage"
  ADD CONSTRAINT "SupportTicketMessage_emailOutboxId_fkey"
  FOREIGN KEY ("emailOutboxId") REFERENCES "EmailOutbox"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION "guard_support_ticket_update"() RETURNS trigger AS $function$
BEGIN
  IF NEW."diagnosticSnapshotVersion" IS DISTINCT FROM OLD."diagnosticSnapshotVersion"
     OR NEW."diagnosticSnapshot" IS DISTINCT FROM OLD."diagnosticSnapshot" THEN
    RAISE EXCEPTION 'SupportTicket diagnostic snapshot is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD."status" IN ('OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER')
     AND NEW."status" IN ('RESOLVED', 'CLOSED') THEN
    IF NEW."contentAccessVersion" = OLD."contentAccessVersion" THEN
      NEW."contentAccessVersion" := OLD."contentAccessVersion" + 1;
    ELSIF NEW."contentAccessVersion" <> OLD."contentAccessVersion" + 1 THEN
      RAISE EXCEPTION 'SupportTicket content access version must advance exactly once on closure'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."contentAccessVersion" IS DISTINCT FROM OLD."contentAccessVersion" THEN
    RAISE EXCEPTION 'SupportTicket content access version changes only on closure'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$ LANGUAGE plpgsql;

CREATE TRIGGER "SupportTicket_guard_update"
BEFORE UPDATE ON "SupportTicket"
FOR EACH ROW EXECUTE FUNCTION "guard_support_ticket_update"();

ALTER TABLE "PlatformAuditLog"
  ADD COLUMN "supportTicketId" TEXT,
  ADD COLUMN "ticketAccessVersion" INTEGER;

CREATE INDEX "PlatformAuditLog_supportTicketId_timestamp_idx"
  ON "PlatformAuditLog"("supportTicketId", "timestamp");
