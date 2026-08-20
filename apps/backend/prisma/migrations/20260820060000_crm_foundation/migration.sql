-- Task 5 CRM foundation: additive-only contact expansion and CRM tables.

ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "firstName" TEXT,
  ADD COLUMN IF NOT EXISTS "lastName" TEXT,
  ADD COLUMN IF NOT EXISTS "email" TEXT,
  ADD COLUMN IF NOT EXISTS "language" TEXT,
  ADD COLUMN IF NOT EXISTS "profilePic" TEXT,
  ADD COLUMN IF NOT EXISTS "countryCode" TEXT,
  ADD COLUMN IF NOT EXISTS "lifecycleStage" TEXT,
  ADD COLUMN IF NOT EXISTS "assigneeId" TEXT;

CREATE TABLE IF NOT EXISTS "Tag" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "colorCode" TEXT,
  "emoji" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ContactTag" (
  "organizationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("organizationId", "contactId", "tagId")
);

CREATE TABLE IF NOT EXISTS "CustomFieldDefinition" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "dataType" TEXT NOT NULL,
  "allowedValues" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomFieldValue" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "fieldDefinitionId" TEXT NOT NULL,
  "value" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_organizationId_email_key" ON "Contact"("organizationId", "email");
CREATE INDEX IF NOT EXISTS "Contact_organizationId_assigneeId_idx" ON "Contact"("organizationId", "assigneeId");
CREATE INDEX IF NOT EXISTS "Contact_organizationId_lifecycleStage_idx" ON "Contact"("organizationId", "lifecycleStage");

CREATE UNIQUE INDEX IF NOT EXISTS "Tag_id_organizationId_key" ON "Tag"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "Tag_organizationId_name_key" ON "Tag"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "Tag_organizationId_idx" ON "Tag"("organizationId");

CREATE INDEX IF NOT EXISTS "ContactTag_organizationId_tagId_idx" ON "ContactTag"("organizationId", "tagId");

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDefinition_id_organizationId_key" ON "CustomFieldDefinition"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDefinition_organizationId_slug_key" ON "CustomFieldDefinition"("organizationId", "slug");
CREATE INDEX IF NOT EXISTS "CustomFieldDefinition_organizationId_idx" ON "CustomFieldDefinition"("organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldValue_id_organizationId_key" ON "CustomFieldValue"("id", "organizationId");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldValue_organizationId_contactId_fieldDefinitionId_key"
  ON "CustomFieldValue"("organizationId", "contactId", "fieldDefinitionId");
CREATE INDEX IF NOT EXISTS "CustomFieldValue_organizationId_fieldDefinitionId_idx"
  ON "CustomFieldValue"("organizationId", "fieldDefinitionId");

ALTER TABLE "Contact"
  ADD CONSTRAINT "Contact_assigneeId_organizationId_fkey"
  FOREIGN KEY ("assigneeId", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Tag"
  ADD CONSTRAINT "Tag_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactTag"
  ADD CONSTRAINT "ContactTag_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactTag"
  ADD CONSTRAINT "ContactTag_contactId_organizationId_fkey"
  FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContactTag"
  ADD CONSTRAINT "ContactTag_tagId_organizationId_fkey"
  FOREIGN KEY ("tagId", "organizationId") REFERENCES "Tag"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomFieldDefinition"
  ADD CONSTRAINT "CustomFieldDefinition_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomFieldValue"
  ADD CONSTRAINT "CustomFieldValue_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomFieldValue"
  ADD CONSTRAINT "CustomFieldValue_contactId_organizationId_fkey"
  FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CustomFieldValue"
  ADD CONSTRAINT "CustomFieldValue_fieldDefinitionId_organizationId_fkey"
  FOREIGN KEY ("fieldDefinitionId", "organizationId") REFERENCES "CustomFieldDefinition"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
