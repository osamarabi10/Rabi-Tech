BEGIN;

CREATE TABLE "OrganizationChannel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OPENWA',
    "baseUrl" TEXT NOT NULL,
    "apiKeyEnc" TEXT NOT NULL,
    "webhookToken" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationChannel_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OrganizationChannel_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrganizationChannel_organizationId_kind_key" UNIQUE ("organizationId", "kind"),
    CONSTRAINT "OrganizationChannel_webhookToken_key" UNIQUE ("webhookToken")
);

CREATE INDEX "OrganizationChannel_organizationId_status_idx"
  ON "OrganizationChannel"("organizationId", "status");

INSERT INTO "OrganizationChannel" (
    "id", "organizationId", "kind", "baseUrl", "apiKeyEnc", "webhookToken",
    "status", "createdAt", "updatedAt"
)
SELECT
    'channel_' || md5(organization_row.id),
    organization_row.id,
    'OPENWA',
    'http://openwa:2785',
    '',
    replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
    'ACTIVE',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Organization" organization_row;

COMMIT;
