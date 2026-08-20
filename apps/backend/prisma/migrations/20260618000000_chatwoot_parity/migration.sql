-- Chatwoot parity: displayId, MessageStatus, Notifications, CSAT, shortCode

-- New enums
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');
CREATE TYPE "NotificationType" AS ENUM ('NEW_MESSAGE', 'CONVERSATION_ASSIGNED', 'CONVERSATION_RESOLVED', 'MENTION');

-- Add CSAT to TemplateCategory enum
ALTER TYPE "TemplateCategory" ADD VALUE 'CSAT';

-- Conversation.displayId (auto-increment sequence)
CREATE SEQUENCE "Conversation_displayId_seq";
ALTER TABLE "Conversation" ADD COLUMN "displayId" INTEGER NOT NULL DEFAULT nextval('"Conversation_displayId_seq"');
ALTER SEQUENCE "Conversation_displayId_seq" OWNED BY "Conversation"."displayId";
-- Backfill existing rows with sequential values
SELECT setval('"Conversation_displayId_seq"', COALESCE((SELECT MAX("displayId") FROM "Conversation"), 1000));
CREATE UNIQUE INDEX "Conversation_displayId_key" ON "Conversation"("displayId");

-- Message.status
ALTER TABLE "Message" ADD COLUMN "status" "MessageStatus" NOT NULL DEFAULT 'PENDING';
UPDATE "Message" SET "status" = 'SENT' WHERE "direction" = 'OUTBOUND';
UPDATE "Message" SET "status" = 'READ' WHERE "direction" = 'INBOUND' AND "isRead" = true;
UPDATE "Message" SET "status" = 'DELIVERED' WHERE "direction" = 'INBOUND' AND "isRead" = false;

-- MessageTemplate.shortCode
ALTER TABLE "MessageTemplate" ADD COLUMN "shortCode" TEXT;
CREATE UNIQUE INDEX "MessageTemplate_shortCode_key" ON "MessageTemplate"("shortCode");

-- CsatSurveyResponse table
CREATE TABLE "CsatSurveyResponse" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "contactId"      TEXT NOT NULL,
  "assignedToId"   TEXT,
  "rating"         INTEGER,
  "feedback"       TEXT,
  "sentAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "respondedAt"    TIMESTAMP(3),
  CONSTRAINT "CsatSurveyResponse_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CsatSurveyResponse_conversationId_key" ON "CsatSurveyResponse"("conversationId");
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CsatSurveyResponse" ADD CONSTRAINT "CsatSurveyResponse_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Notification table
CREATE TABLE "Notification" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "type"           "NotificationType" NOT NULL,
  "conversationId" TEXT,
  "title"          TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  "isRead"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
