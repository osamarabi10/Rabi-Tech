-- Meta template lifecycle storage, phase 1.
--
-- This migration is intentionally additive. It establishes provider identity,
-- approval state, WABA isolation, future campaign bindings, and the future
-- reservation/delivery ledger. No send path is enabled by this migration.
--
-- 2026-09-01: still accurate, and narrower than it looks. No TEMPLATE send path
-- exists to this day - meta.client.ts can create and list templates and cannot
-- send one - which is what canInitiateConversations: false encodes. Text and
-- media do send, through meta.adapter.ts, inside the 24-hour service window.
-- The sentence describes the template path only; it is not a statement that the
-- Meta channel cannot send at all.

ALTER TABLE "MetaChannelCredential"
  ADD COLUMN "businessPortfolioId" TEXT;

-- Template webhook events identify the WABA rather than a phone number. A
-- global WABA index makes that platform-level routing answer one organization
-- or none, just like phoneNumberId routing.
CREATE UNIQUE INDEX "MetaChannelCredential_wabaId_key"
  ON "MetaChannelCredential" ("wabaId");

-- A portfolio is a tenant boundary. NULL is allowed for existing credentials
-- until they are reconnected or repaired; every stored non-NULL portfolio id
-- is globally owned by one organization.
CREATE UNIQUE INDEX "MetaChannelCredential_businessPortfolioId_key"
  ON "MetaChannelCredential" ("businessPortfolioId");

ALTER TABLE "Campaign"
  ADD COLUMN "metaTemplateId" TEXT,
  ADD COLUMN "metaTemplateBindings" JSONB;

-- The ledger can point at a campaign recipient without weakening its tenant
-- boundary. id is already the primary key; this pair makes the composite FK
-- referenceable by PostgreSQL.
CREATE UNIQUE INDEX "CampaignRecipient_id_organizationId_key"
  ON "CampaignRecipient" ("id", "organizationId");

CREATE TABLE "MetaMessageTemplate" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "wabaId" TEXT NOT NULL,
  "providerId" TEXT,
  "name" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "components" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "rejectionReason" TEXT,
  "isSupported" BOOLEAN NOT NULL DEFAULT true,
  "unsupportedReason" TEXT,
  "submittedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "providerUpdatedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MetaMessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaMessageTemplate_id_organizationId_key"
  ON "MetaMessageTemplate" ("id", "organizationId");

-- providerId is NULL for local drafts. PostgreSQL permits multiple NULLs in a
-- unique index, while an imported provider id remains unique inside its WABA.
CREATE UNIQUE INDEX "MetaMessageTemplate_wabaId_providerId_key"
  ON "MetaMessageTemplate" ("wabaId", "providerId");

CREATE INDEX "MetaMessageTemplate_organizationId_status_archivedAt_idx"
  ON "MetaMessageTemplate" ("organizationId", "status", "archivedAt");

CREATE INDEX "MetaMessageTemplate_organizationId_wabaId_name_language_idx"
  ON "MetaMessageTemplate" ("organizationId", "wabaId", "name", "language");

CREATE TABLE "MetaTemplateSend" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "campaignId" TEXT,
  "campaignRecipientId" TEXT,
  "contactId" TEXT,
  "recipientPhone" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'MANUAL',
  "businessInitiated" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'RESERVED',
  "providerStatus" TEXT,
  "providerMessageId" TEXT,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reservationExpiresAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "readAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MetaTemplateSend_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MetaTemplateSend_id_organizationId_key"
  ON "MetaTemplateSend" ("id", "organizationId");

CREATE UNIQUE INDEX "MetaTemplateSend_organizationId_providerMessageId_key"
  ON "MetaTemplateSend" ("organizationId", "providerMessageId");

CREATE INDEX "MetaTemplateSend_organizationId_recipientPhone_reservedAt_idx"
  ON "MetaTemplateSend" ("organizationId", "recipientPhone", "reservedAt");

CREATE INDEX "MetaTemplateSend_organizationId_status_reservedAt_idx"
  ON "MetaTemplateSend" ("organizationId", "status", "reservedAt");

CREATE INDEX "MetaTemplateSend_organizationId_templateId_reservedAt_idx"
  ON "MetaTemplateSend" ("organizationId", "templateId", "reservedAt");

CREATE INDEX "MetaTemplateSend_organizationId_campaignId_idx"
  ON "MetaTemplateSend" ("organizationId", "campaignId");

ALTER TABLE "MetaMessageTemplate"
  ADD CONSTRAINT "MetaMessageTemplate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MetaTemplateSend"
  ADD CONSTRAINT "MetaTemplateSend_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaTemplateSend_templateId_organizationId_fkey"
  FOREIGN KEY ("templateId", "organizationId")
  REFERENCES "MetaMessageTemplate"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaTemplateSend_campaignId_organizationId_fkey"
  FOREIGN KEY ("campaignId", "organizationId")
  REFERENCES "Campaign"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaTemplateSend_campaignRecipientId_organizationId_fkey"
  FOREIGN KEY ("campaignRecipientId", "organizationId")
  REFERENCES "CampaignRecipient"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "MetaTemplateSend_contactId_organizationId_fkey"
  FOREIGN KEY ("contactId", "organizationId")
  REFERENCES "Contact"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_metaTemplateId_organizationId_fkey"
  FOREIGN KEY ("metaTemplateId", "organizationId")
  REFERENCES "MetaMessageTemplate"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
