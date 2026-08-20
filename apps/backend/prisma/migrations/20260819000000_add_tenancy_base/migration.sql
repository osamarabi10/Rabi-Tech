-- Create Organization table
CREATE TABLE "Organization" (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Create Identity table (global login credentials)
CREATE TABLE "Identity" (
  id TEXT NOT NULL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "platformRole" TEXT NOT NULL DEFAULT 'NONE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Insert bootstrap subscriber organization (backfill target for existing data)
INSERT INTO "Organization" (id, name, slug, status, "createdAt", "updatedAt") 
VALUES ('org_rabitech_0', 'RabiTech Demo', 'rabitech-demo', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Add organizationId and identityId to User (nullable during backfill)
ALTER TABLE "User" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "User" ADD COLUMN "identityId" TEXT;

-- Backfill User: create Identity records and link users
-- For each existing user, create corresponding Identity
DO $$
DECLARE
  user_row RECORD;
  new_identity_id TEXT;
BEGIN
  FOR user_row IN SELECT id, email, "passwordHash" FROM "User" LOOP
    SELECT id INTO new_identity_id FROM "Identity" WHERE email = user_row.email;
    
    IF new_identity_id IS NULL THEN
      INSERT INTO "Identity" (id, email, "passwordHash", "createdAt", "updatedAt") 
      VALUES (gen_random_uuid()::text, user_row.email, user_row."passwordHash", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      RETURNING id INTO new_identity_id;
    END IF;
    
    UPDATE "User" 
    SET "identityId" = new_identity_id, "organizationId" = 'org_rabitech_0'
    WHERE id = user_row.id;
  END LOOP;
END $$;

-- Remove unique constraint on email from User (now handled by Identity)
DROP INDEX "User_email_key";
ALTER TABLE "User" DROP COLUMN "email";
ALTER TABLE "User" DROP COLUMN "passwordHash";

-- Add organizationId to all tenant-scoped tables (nullable for safe backfill)
ALTER TABLE "Contact" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Message" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "TicketNote" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "WhatsappSession" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "CsatSurveyResponse" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "GroupMessage" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Keyword" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "organizationId" TEXT;

-- Backfill organizationId for all existing records to the RabiTech org
UPDATE "Contact" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Conversation" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Message" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Ticket" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "TicketNote" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Campaign" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "MessageTemplate" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Lead" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "WhatsappSession" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "CsatSurveyResponse" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "AuditLog" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "CampaignRecipient" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "GroupMessage" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Keyword" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;
UPDATE "Notification" SET "organizationId" = 'org_rabitech_0' WHERE "organizationId" IS NULL;

-- Make organizationId NOT NULL and add composite unique/foreign key constraints

-- User: Make columns NOT NULL and add composite unique constraint
ALTER TABLE "User" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "identityId" SET NOT NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_identityId_key" UNIQUE ("organizationId", "identityId");
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- Contact: Make organizationId NOT NULL and add composite unique
ALTER TABLE "Contact" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "Contact_phone_key";
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_phone_key" UNIQUE ("organizationId", "phone");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Contact_organizationId_zoneId_idx" ON "Contact"("organizationId", "zoneId");
CREATE INDEX "Contact_organizationId_name_idx" ON "Contact"("organizationId", "name");

-- Conversation: Make organizationId NOT NULL
ALTER TABLE "Conversation" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Conversation_organizationId_isArchived_status_lastMessageAt_idx" ON "Conversation"("organizationId", "isArchived", "status", "lastMessageAt");
CREATE INDEX "Conversation_organizationId_contactId_sessionId_idx" ON "Conversation"("organizationId", "contactId", "sessionId");

-- Message: Make organizationId NOT NULL and add composite unique
ALTER TABLE "Message" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "Message_waMessageId_key";
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_waMessageId_key" UNIQUE ("organizationId", "waMessageId");
CREATE INDEX "Message_organizationId_conversationId_timestamp_idx" ON "Message"("organizationId", "conversationId", "timestamp");
CREATE INDEX "Message_organizationId_conversationId_direction_isRead_idx" ON "Message"("organizationId", "conversationId", "direction", "isRead");

-- Ticket: Make organizationId NOT NULL
ALTER TABLE "Ticket" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Ticket_organizationId_idx" ON "Ticket"("organizationId");

-- TicketNote: Make organizationId NOT NULL
ALTER TABLE "TicketNote" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "TicketNote" ADD CONSTRAINT "TicketNote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "TicketNote_organizationId_idx" ON "TicketNote"("organizationId");

-- Campaign: Make organizationId NOT NULL
ALTER TABLE "Campaign" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Campaign_organizationId_idx" ON "Campaign"("organizationId");

-- MessageTemplate: Make organizationId NOT NULL and add composite unique
ALTER TABLE "MessageTemplate" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "MessageTemplate_shortCode_key";
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_organizationId_shortCode_key" UNIQUE ("organizationId", "shortCode");
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "MessageTemplate_organizationId_category_dept_isActive_idx" ON "MessageTemplate"("organizationId", "category", "dept", "isActive");

-- Lead: Make organizationId NOT NULL
ALTER TABLE "Lead" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Lead_organizationId_stage_idx" ON "Lead"("organizationId", "stage");
CREATE INDEX "Lead_organizationId_assignedToId_idx" ON "Lead"("organizationId", "assignedToId");

-- WhatsappSession: Make organizationId NOT NULL and add composite uniques
ALTER TABLE "WhatsappSession" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "WhatsappSession_sessionName_key";
DROP INDEX "WhatsappSession_phoneNumber_key";
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_organizationId_sessionName_key" UNIQUE ("organizationId", "sessionName");
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_organizationId_phoneNumber_key" UNIQUE ("organizationId", "phoneNumber");
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "WhatsappSession_organizationId_idx" ON "WhatsappSession"("organizationId");

-- CsatSurveyResponse: Make organizationId NOT NULL
ALTER TABLE "CsatSurveyResponse" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CsatSurveyResponse_organizationId_idx" ON "CsatSurveyResponse"("organizationId");

-- AuditLog: Make organizationId NOT NULL
ALTER TABLE "AuditLog" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "AuditLog_organizationId_userId_timestamp_idx" ON "AuditLog"("organizationId", "userId", "timestamp");
CREATE INDEX "AuditLog_organizationId_action_timestamp_idx" ON "AuditLog"("organizationId", "action", "timestamp");
CREATE INDEX "AuditLog_organizationId_resourceId_idx" ON "AuditLog"("organizationId", "resourceId");

-- CampaignRecipient: Make organizationId NOT NULL and add composite unique
ALTER TABLE "CampaignRecipient" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "CampaignRecipient_campaignId_contactId_key";
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_organizationId_campaignId_contactId_key" UNIQUE ("organizationId", "campaignId", "contactId");
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "CampaignRecipient_organizationId_idx" ON "CampaignRecipient"("organizationId");

-- GroupMessage: Make organizationId NOT NULL and add composite unique
ALTER TABLE "GroupMessage" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "GroupMessage_waMessageId_key";
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_organizationId_waMessageId_key" UNIQUE ("organizationId", "waMessageId");
ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "GroupMessage_organizationId_sessionId_groupId_timestamp_idx" ON "GroupMessage"("organizationId", "sessionId", "groupId", "timestamp");
CREATE INDEX "GroupMessage_organizationId_groupId_idx" ON "GroupMessage"("organizationId", "groupId");

-- Keyword: Make organizationId NOT NULL and add composite unique
ALTER TABLE "Keyword" ALTER COLUMN "organizationId" SET NOT NULL;
DROP INDEX "Keyword_category_phrase_key";
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_organizationId_category_phrase_key" UNIQUE ("organizationId", "category", "phrase");
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Keyword_organizationId_category_idx" ON "Keyword"("organizationId", "category");

-- Notification: Make organizationId NOT NULL
ALTER TABLE "Notification" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "Notification_organizationId_userId_isRead_createdAt_idx" ON "Notification"("organizationId", "userId", "isRead", "createdAt");
