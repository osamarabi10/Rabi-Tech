-- Contact metadata is already tenant-owned. This migration adds the
-- management attributes needed by the workspace settings and preserves where
-- each tag assignment came from.

ALTER TABLE "ContactTag"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "createdByName" TEXT;

ALTER TABLE "CustomFieldDefinition"
  ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'HIDE_WHEN_EMPTY';

WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "organizationId" ORDER BY "createdAt", "id") + 6 AS position
  FROM "CustomFieldDefinition"
)
UPDATE "CustomFieldDefinition" AS field
SET "sortOrder" = ranked.position
FROM ranked
WHERE field."id" = ranked."id";

CREATE INDEX "CustomFieldDefinition_organizationId_sortOrder_idx"
  ON "CustomFieldDefinition"("organizationId", "sortOrder");

CREATE UNIQUE INDEX "CustomFieldDefinition_organizationId_name_key"
  ON "CustomFieldDefinition"("organizationId", "name");

CREATE TABLE "ContactFieldPreference" (
  "organizationId" TEXT NOT NULL,
  "fieldKey" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'HIDE_WHEN_EMPTY',
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContactFieldPreference_pkey" PRIMARY KEY ("organizationId", "fieldKey")
);

CREATE INDEX "ContactFieldPreference_organizationId_sortOrder_idx"
  ON "ContactFieldPreference"("organizationId", "sortOrder");

ALTER TABLE "ContactFieldPreference"
  ADD CONSTRAINT "ContactFieldPreference_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
