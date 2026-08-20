-- CreateEnum
CREATE TYPE "UsageMetric" AS ENUM (
  'messages_inbound',
  'messages_outbound',
  'active_contacts',
  'ai_tokens_in',
  'ai_tokens_out',
  'campaign_sends'
);

-- AlterTable
ALTER TABLE "OrganizationConfig"
  ADD COLUMN "monthlyActiveContactsLimit" INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN "monthlyInboundMessagesLimit" INTEGER,
  ADD COLUMN "monthlyOutboundMessagesLimit" INTEGER NOT NULL DEFAULT 10000,
  ADD COLUMN "monthlyCampaignSendsLimit" INTEGER NOT NULL DEFAULT 5000,
  ADD COLUMN "monthlyAiTokensInLimit" BIGINT,
  ADD COLUMN "monthlyAiTokensOutLimit" BIGINT;

-- CreateTable
CREATE TABLE "UsageEvent" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "metric" "UsageMetric" NOT NULL,
  "quantity" BIGINT NOT NULL DEFAULT 1,
  "subjectId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformDailyMetric" (
  "organizationId" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "metric" "UsageMetric" NOT NULL,
  "value" BIGINT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformDailyMetric_pkey" PRIMARY KEY ("organizationId", "date", "metric")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_id_organizationId_key"
  ON "UsageEvent"("id", "organizationId");

CREATE INDEX "UsageEvent_organizationId_metric_occurredAt_idx"
  ON "UsageEvent"("organizationId", "metric", "occurredAt");

CREATE INDEX "UsageEvent_organizationId_metric_subjectId_occurredAt_idx"
  ON "UsageEvent"("organizationId", "metric", "subjectId", "occurredAt");

CREATE INDEX "PlatformDailyMetric_date_metric_idx"
  ON "PlatformDailyMetric"("date", "metric");

-- AddForeignKey
ALTER TABLE "UsageEvent"
  ADD CONSTRAINT "UsageEvent_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PlatformDailyMetric"
  ADD CONSTRAINT "PlatformDailyMetric_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
