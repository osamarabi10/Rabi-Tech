CREATE TYPE "ClosingNoteMode" AS ENUM (
  'OPTIONAL',
  'CATEGORY_REQUIRED',
  'CATEGORY_AND_SUMMARY_REQUIRED'
);

CREATE TYPE "ConversationClosingSource" AS ENUM (
  'MANUAL',
  'AUTO_CLOSE',
  'WORKFLOW',
  'API',
  'MERGE'
);

ALTER TABLE "OrganizationConfig"
  ADD COLUMN "autoCloseEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "autoCloseDurationMinutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "autoCloseEnabledAt" TIMESTAMP(3),
  ADD COLUMN "manualClosingNotesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manualClosingNoteMode" "ClosingNoteMode" NOT NULL DEFAULT 'OPTIONAL';

ALTER TABLE "Conversation"
  ADD COLUMN "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "autoCloseEligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastHumanOutboundAt" TIMESTAMP(3),
  ADD COLUMN "autoCloseAt" TIMESTAMP(3);

UPDATE "Conversation" SET "openedAt" = "createdAt";

CREATE INDEX "Conversation_organizationId_autoCloseAt_idx"
  ON "Conversation"("organizationId", "autoCloseAt");
CREATE INDEX "Conversation_organizationId_openedAt_idx"
  ON "Conversation"("organizationId", "openedAt");

CREATE TABLE "ConversationCategory" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConversationCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationCategory_id_organizationId_key"
  ON "ConversationCategory"("id", "organizationId");
CREATE UNIQUE INDEX "ConversationCategory_organizationId_name_key"
  ON "ConversationCategory"("organizationId", "name");
CREATE INDEX "ConversationCategory_organizationId_createdAt_idx"
  ON "ConversationCategory"("organizationId", "createdAt");

ALTER TABLE "ConversationCategory"
  ADD CONSTRAINT "ConversationCategory_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConversationClosure" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT,
  "summary" TEXT,
  "source" "ConversationClosingSource" NOT NULL,
  "closedById" TEXT,
  "closedByName" TEXT,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationClosure_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationClosure_id_organizationId_key"
  ON "ConversationClosure"("id", "organizationId");
CREATE INDEX "ConversationClosure_organizationId_closedAt_idx"
  ON "ConversationClosure"("organizationId", "closedAt");
CREATE INDEX "ConversationClosure_organizationId_categoryName_closedAt_idx"
  ON "ConversationClosure"("organizationId", "categoryName", "closedAt");
CREATE INDEX "ConversationClosure_organizationId_source_closedAt_idx"
  ON "ConversationClosure"("organizationId", "source", "closedAt");
CREATE INDEX "ConversationClosure_organizationId_closedById_closedAt_idx"
  ON "ConversationClosure"("organizationId", "closedById", "closedAt");
CREATE INDEX "ConversationClosure_organizationId_conversationId_closedAt_idx"
  ON "ConversationClosure"("organizationId", "conversationId", "closedAt");

ALTER TABLE "ConversationClosure"
  ADD CONSTRAINT "ConversationClosure_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationClosure"
  ADD CONSTRAINT "ConversationClosure_conversationId_organizationId_fkey"
  FOREIGN KEY ("conversationId", "organizationId")
  REFERENCES "Conversation"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationConfig"
  ADD CONSTRAINT "OrganizationConfig_autoCloseDurationMinutes_check"
  CHECK ("autoCloseDurationMinutes" BETWEEN 30 AND 20160);
