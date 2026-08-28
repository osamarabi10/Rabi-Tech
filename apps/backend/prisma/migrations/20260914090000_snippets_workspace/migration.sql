-- Snippets are QUICK_REPLY templates with workspace-owned topics and files.
-- Contact tags remain a separate domain: a canned reply topic must never
-- change customer segmentation.
CREATE TABLE "SnippetTopic" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SnippetTopic_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SnippetTopicAssignment" (
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SnippetTopicAssignment_pkey" PRIMARY KEY ("organizationId", "templateId", "topicId")
);

CREATE TABLE "SnippetAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SnippetAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SnippetTopic_id_organizationId_key" ON "SnippetTopic"("id", "organizationId");
CREATE UNIQUE INDEX "SnippetTopic_organizationId_name_key" ON "SnippetTopic"("organizationId", "name");
CREATE INDEX "SnippetTopic_organizationId_name_idx" ON "SnippetTopic"("organizationId", "name");
CREATE INDEX "SnippetTopicAssignment_organizationId_topicId_templateId_idx" ON "SnippetTopicAssignment"("organizationId", "topicId", "templateId");
CREATE UNIQUE INDEX "SnippetAttachment_id_organizationId_key" ON "SnippetAttachment"("id", "organizationId");
CREATE UNIQUE INDEX "SnippetAttachment_organizationId_storageKey_key" ON "SnippetAttachment"("organizationId", "storageKey");
CREATE UNIQUE INDEX "SnippetAttachment_organizationId_templateId_fileName_key" ON "SnippetAttachment"("organizationId", "templateId", "fileName");
CREATE INDEX "SnippetAttachment_organizationId_templateId_sortOrder_idx" ON "SnippetAttachment"("organizationId", "templateId", "sortOrder");

ALTER TABLE "SnippetTopic" ADD CONSTRAINT "SnippetTopic_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnippetTopicAssignment" ADD CONSTRAINT "SnippetTopicAssignment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnippetTopicAssignment" ADD CONSTRAINT "SnippetTopicAssignment_templateId_organizationId_fkey"
  FOREIGN KEY ("templateId", "organizationId") REFERENCES "MessageTemplate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnippetTopicAssignment" ADD CONSTRAINT "SnippetTopicAssignment_topicId_organizationId_fkey"
  FOREIGN KEY ("topicId", "organizationId") REFERENCES "SnippetTopic"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnippetAttachment" ADD CONSTRAINT "SnippetAttachment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SnippetAttachment" ADD CONSTRAINT "SnippetAttachment_templateId_organizationId_fkey"
  FOREIGN KEY ("templateId", "organizationId") REFERENCES "MessageTemplate"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep the original file name with outbound media so a failed document send
-- can be retried with the same WhatsApp payload.
ALTER TABLE "Message" ADD COLUMN "mediaFileName" TEXT;
