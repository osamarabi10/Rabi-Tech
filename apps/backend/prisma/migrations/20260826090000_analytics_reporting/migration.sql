-- M7 — reporting foundations.
--
-- Response and resolution times were previously only inferrable from
-- `Conversation.updatedAt`, which every edit touches: relabelling a resolved
-- thread moved its "resolution time". These two columns record the moments
-- themselves, so the metric stops being a guess and becomes an indexed
-- aggregate instead of a per-conversation message scan.

ALTER TABLE "Conversation" ADD COLUMN "firstResponseAt" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "resolvedAt" TIMESTAMP(3);

-- Backfill: the first human outbound reply in each thread. Auto-replies are
-- excluded — counting them as "the response" would report a first-response
-- time of seconds for every conversation and make the metric meaningless.
UPDATE "Conversation" c
SET "firstResponseAt" = m."firstAt"
FROM (
  SELECT "conversationId", MIN("timestamp") AS "firstAt"
  FROM "Message"
  WHERE direction = 'OUTBOUND' AND "isAuto" = false AND "isInternal" = false
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c.id;

-- Backfill resolution: `updatedAt` is the only evidence available for threads
-- resolved before this migration, so historic values are approximate and can
-- sit later than the true resolution. Everything resolved from now on is
-- stamped at the transition itself.
UPDATE "Conversation"
SET "resolvedAt" = "updatedAt"
WHERE status = 'RESOLVED';

CREATE INDEX "Conversation_organizationId_resolvedAt_idx"
  ON "Conversation"("organizationId", "resolvedAt");
CREATE INDEX "Conversation_organizationId_firstResponseAt_idx"
  ON "Conversation"("organizationId", "firstResponseAt");

-- `createdAt` carries the volume-over-time and new-conversation reporting and
-- had no index of its own.
CREATE INDEX "Conversation_organizationId_createdAt_idx"
  ON "Conversation"("organizationId", "createdAt");

-- Hourly rollup.
--
-- Postgres can bucket by hour trivially; Prisma cannot express `date_trunc` in
-- `groupBy`, and raw SQL would bypass the tenancy extension entirely — the one
-- thing this codebase does not do. So the buckets are materialised here and
-- maintained by a worker that counts each hour over indexed ranges. Reading a
-- peak-hours heatmap then costs one row per hour instead of one row per
-- message.
CREATE TABLE "AnalyticsHourly" (
  "organizationId"        TEXT NOT NULL,
  "hourStart"             TIMESTAMP(3) NOT NULL,
  "inbound"               INTEGER NOT NULL DEFAULT 0,
  "outbound"              INTEGER NOT NULL DEFAULT 0,
  "automated"             INTEGER NOT NULL DEFAULT 0,
  "failed"                INTEGER NOT NULL DEFAULT 0,
  "conversationsCreated"  INTEGER NOT NULL DEFAULT 0,
  "conversationsResolved" INTEGER NOT NULL DEFAULT 0,
  "computedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AnalyticsHourly_pkey" PRIMARY KEY ("organizationId", "hourStart")
);

ALTER TABLE "AnalyticsHourly"
  ADD CONSTRAINT "AnalyticsHourly_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AnalyticsHourly_organizationId_hourStart_idx"
  ON "AnalyticsHourly"("organizationId", "hourStart");
