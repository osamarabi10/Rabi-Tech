-- Growth Widgets: the chat-link slice, and first-touch attribution on Contact.
--
-- Hand-written from `prisma migrate diff`, taking ONLY the growth-widget
-- statements. The full diff also proposes ~20 index and constraint renames
-- across ConversationCollaborator, Workflow, GatewayHealthCheck and others —
-- pre-existing drift between hand-written migration names and the names Prisma
-- would generate. That drift is real and predates this work; sweeping it into
-- this migration would hide a schema change inside a feature commit, which is
-- how 9a458795 happened.
--
-- `Contact` is the hottest table in this schema — the inbound worker reads it on
-- every message. Adding "acquisitionSource" NOT NULL with a *constant* default
-- is metadata-only from PostgreSQL 11 onward and does not rewrite the table.
-- Confirmed empirically on this server (15.19) rather than taken from the docs:
-- after the ALTER, pg_relation_filenode was unchanged, pg_attribute.atthasmissing
-- was true and attmissingval was {UNKNOWN}. A backfill loop instead of a default
-- would have rewritten the table.

-- CreateEnum
CREATE TYPE "AcquisitionSource" AS ENUM ('UNKNOWN', 'DIRECT', 'GROWTH_WIDGET', 'IMPORT', 'API');

-- CreateEnum
CREATE TYPE "GrowthWidgetType" AS ENUM ('CHAT_LINK');

-- AlterTable
-- Existing rows become UNKNOWN, which means precisely "this row predates
-- attribution" — deliberately NOT the same fact as DIRECT, which means we
-- looked and there was nothing to find.
ALTER TABLE "Contact" ADD COLUMN     "acquisitionAt" TIMESTAMP(3),
ADD COLUMN     "acquisitionSource" "AcquisitionSource" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "acquisitionUtmCampaign" TEXT,
ADD COLUMN     "acquisitionWidgetId" TEXT;

-- CreateTable
CREATE TABLE "GrowthWidget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GrowthWidgetType" NOT NULL DEFAULT 'CHAT_LINK',
    "publicToken" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "prefillText" TEXT NOT NULL DEFAULT '',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GrowthWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WidgetClick" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "widgetId" TEXT NOT NULL,
    "clickToken" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedByContactId" TEXT,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "WidgetClick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GrowthWidget_publicToken_key" ON "GrowthWidget"("publicToken");

-- CreateIndex
CREATE INDEX "GrowthWidget_organizationId_isArchived_idx" ON "GrowthWidget"("organizationId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "GrowthWidget_id_organizationId_key" ON "GrowthWidget"("id", "organizationId");

-- CreateIndex
CREATE INDEX "WidgetClick_organizationId_widgetId_createdAt_idx" ON "WidgetClick"("organizationId", "widgetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetClick_id_organizationId_key" ON "WidgetClick"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WidgetClick_organizationId_clickToken_key" ON "WidgetClick"("organizationId", "clickToken");

-- CreateIndex
-- Partial, and Prisma cannot express it, so it is written by hand and will not
-- appear in `prisma migrate diff` output afterwards.
--
-- Attributed contacts are the minority and always will be — most contacts
-- arrive directly. Indexing only the rows that carry a widget keeps the sources
-- report's lookup off a mostly-null column on the hottest table here.
CREATE INDEX "Contact_organizationId_acquisitionWidgetId_partial_idx"
  ON "Contact"("organizationId", "acquisitionWidgetId")
  WHERE "acquisitionWidgetId" IS NOT NULL;

-- CreateIndex
-- Partial, hand-written for the same reason.
--
-- Two readers want exactly the unclaimed rows: the claim path, which looks for
-- an unclaimed token, and pruning, which deletes old clicks that never became
-- contacts. Most clicks are never claimed, so this index stays small while the
-- table grows.
CREATE INDEX "WidgetClick_organizationId_unclaimed_partial_idx"
  ON "WidgetClick"("organizationId", "createdAt")
  WHERE "claimedByContactId" IS NULL;

-- AddForeignKey
ALTER TABLE "GrowthWidget" ADD CONSTRAINT "GrowthWidget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrowthWidget" ADD CONSTRAINT "GrowthWidget_sessionId_organizationId_fkey" FOREIGN KEY ("sessionId", "organizationId") REFERENCES "WhatsappSession"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetClick" ADD CONSTRAINT "WidgetClick_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetClick" ADD CONSTRAINT "WidgetClick_widgetId_organizationId_fkey" FOREIGN KEY ("widgetId", "organizationId") REFERENCES "GrowthWidget"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WidgetClick" ADD CONSTRAINT "WidgetClick_claimedByContactId_organizationId_fkey" FOREIGN KEY ("claimedByContactId", "organizationId") REFERENCES "Contact"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, not CASCADE: deleting a widget must not silently delete the
-- contacts it produced. If a widget is genuinely being removed, its contacts
-- have to be dealt with deliberately first.
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_acquisitionWidgetId_organizationId_fkey" FOREIGN KEY ("acquisitionWidgetId", "organizationId") REFERENCES "GrowthWidget"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
