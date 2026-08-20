BEGIN;

-- Abort before changing constraints if historical data already crosses organizations.
DO $$
DECLARE
  mismatch_count bigint;
BEGIN
  SELECT count(*) INTO mismatch_count
  FROM (
    SELECT 1 FROM "GroupMessage" c JOIN "WhatsappSession" p ON p.id = c."sessionId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Conversation" c JOIN "Contact" p ON p.id = c."contactId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Conversation" c JOIN "WhatsappSession" p ON p.id = c."sessionId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Conversation" c JOIN "User" p ON p.id = c."assignedToId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Message" c JOIN "Conversation" p ON p.id = c."conversationId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Message" c JOIN "User" p ON p.id = c."sentById" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Ticket" c JOIN "Conversation" p ON p.id = c."conversationId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Ticket" c JOIN "User" p ON p.id = c."createdById" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Ticket" c JOIN "User" p ON p.id = c."assignedToId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "TicketNote" c JOIN "Ticket" p ON p.id = c."ticketId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "TicketNote" c JOIN "User" p ON p.id = c."authorId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Campaign" c JOIN "WhatsappSession" p ON p.id = c."sessionId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "CampaignRecipient" c JOIN "Campaign" p ON p.id = c."campaignId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "CampaignRecipient" c JOIN "Contact" p ON p.id = c."contactId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "AuditLog" c JOIN "User" p ON p.id = c."userId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "CsatSurveyResponse" c JOIN "Conversation" p ON p.id = c."conversationId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "CsatSurveyResponse" c JOIN "Contact" p ON p.id = c."contactId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "CsatSurveyResponse" c JOIN "User" p ON p.id = c."assignedToId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Lead" c JOIN "Contact" p ON p.id = c."contactId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Lead" c JOIN "User" p ON p.id = c."assignedToId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Notification" c JOIN "User" p ON p.id = c."userId" WHERE c."organizationId" <> p."organizationId"
    UNION ALL SELECT 1 FROM "Notification" c JOIN "Conversation" p ON p.id = c."conversationId" WHERE c."organizationId" <> p."organizationId"
  ) mismatches;

  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'P1-B aborted: % cross-organization parent-child references found', mismatch_count;
  END IF;
END $$;

-- Parent keys must exist before composite child constraints can reference them.
ALTER TABLE "User" ADD CONSTRAINT "User_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_id_organizationId_key" UNIQUE ("id", "organizationId");

-- One-to-one business keys are tenant-local.
DROP INDEX IF EXISTS "Ticket_conversationId_key";
DROP INDEX IF EXISTS "CsatSurveyResponse_conversationId_key";
CREATE UNIQUE INDEX "Ticket_conversationId_organizationId_key" ON "Ticket"("conversationId", "organizationId");
CREATE UNIQUE INDEX "CsatSurveyResponse_conversationId_organizationId_key" ON "CsatSurveyResponse"("conversationId", "organizationId");

-- Replace single-column foreign keys with tenant-bound composite keys.
ALTER TABLE "GroupMessage" DROP CONSTRAINT IF EXISTS "GroupMessage_sessionId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_contactId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_sessionId_fkey";
ALTER TABLE "Conversation" DROP CONSTRAINT IF EXISTS "Conversation_assignedToId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_conversationId_fkey";
ALTER TABLE "Message" DROP CONSTRAINT IF EXISTS "Message_sentById_fkey";
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "Ticket_conversationId_fkey";
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "Ticket_createdById_fkey";
ALTER TABLE "Ticket" DROP CONSTRAINT IF EXISTS "Ticket_assignedToId_fkey";
ALTER TABLE "TicketNote" DROP CONSTRAINT IF EXISTS "TicketNote_ticketId_fkey";
ALTER TABLE "TicketNote" DROP CONSTRAINT IF EXISTS "TicketNote_authorId_fkey";
ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_sessionId_fkey";
ALTER TABLE "CampaignRecipient" DROP CONSTRAINT IF EXISTS "CampaignRecipient_campaignId_fkey";
ALTER TABLE "CampaignRecipient" DROP CONSTRAINT IF EXISTS "CampaignRecipient_contactId_fkey";
ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_userId_fkey";
ALTER TABLE "CsatSurveyResponse" DROP CONSTRAINT IF EXISTS "CsatSurveyResponse_conversationId_fkey";
ALTER TABLE "CsatSurveyResponse" DROP CONSTRAINT IF EXISTS "CsatSurveyResponse_contactId_fkey";
ALTER TABLE "CsatSurveyResponse" DROP CONSTRAINT IF EXISTS "CsatSurveyResponse_assignedToId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_contactId_fkey";
ALTER TABLE "Lead" DROP CONSTRAINT IF EXISTS "Lead_assignedToId_fkey";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_userId_fkey";
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_conversationId_fkey";

ALTER TABLE "GroupMessage" ADD CONSTRAINT "GroupMessage_sessionId_organizationId_fkey" FOREIGN KEY ("sessionId", "organizationId") REFERENCES "WhatsappSession"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_organizationId_fkey" FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_sessionId_organizationId_fkey" FOREIGN KEY ("sessionId", "organizationId") REFERENCES "WhatsappSession"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedToId_organizationId_fkey" FOREIGN KEY ("assignedToId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_sentById_organizationId_fkey" FOREIGN KEY ("sentById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_organizationId_fkey" FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assignedToId_organizationId_fkey" FOREIGN KEY ("assignedToId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketNote" ADD CONSTRAINT "TicketNote_ticketId_organizationId_fkey" FOREIGN KEY ("ticketId", "organizationId") REFERENCES "Ticket"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketNote" ADD CONSTRAINT "TicketNote_authorId_organizationId_fkey" FOREIGN KEY ("authorId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_sessionId_organizationId_fkey" FOREIGN KEY ("sessionId", "organizationId") REFERENCES "WhatsappSession"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_campaignId_organizationId_fkey" FOREIGN KEY ("campaignId", "organizationId") REFERENCES "Campaign"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_contactId_organizationId_fkey" FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_contactId_organizationId_fkey" FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_assignedToId_organizationId_fkey" FOREIGN KEY ("assignedToId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_contactId_organizationId_fkey" FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_organizationId_fkey" FOREIGN KEY ("assignedToId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
