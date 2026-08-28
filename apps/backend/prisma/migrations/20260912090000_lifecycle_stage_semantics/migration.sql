-- Separate funnel stages from drop-off reasons and make default/won semantics durable.
ALTER TABLE "LifecycleStage"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "emoji" TEXT,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isWon" BOOLEAN NOT NULL DEFAULT false;

-- The original bootstrap vocabulary already carried these meanings implicitly.
UPDATE "LifecycleStage"
SET "kind" = 'LOST', "orderIndex" = 0
WHERE lower("name") IN ('unqualified', 'cold lead');

WITH won AS (
  SELECT DISTINCT ON ("organizationId") "id"
  FROM "LifecycleStage"
  WHERE "kind" = 'ACTIVE' AND lower("name") IN ('customer', 'won')
  ORDER BY "organizationId", "orderIndex" DESC, "id"
)
UPDATE "LifecycleStage" stage
SET "isWon" = true
FROM won
WHERE stage."id" = won."id";

WITH defaults AS (
  SELECT DISTINCT ON ("organizationId") "id"
  FROM "LifecycleStage"
  WHERE "kind" = 'ACTIVE' AND "isWon" = false
  ORDER BY "organizationId", "orderIndex", "id"
)
UPDATE "LifecycleStage" stage
SET "isDefault" = true
FROM defaults
WHERE stage."id" = defaults."id";

ALTER TABLE "LifecycleStage"
  ADD CONSTRAINT "LifecycleStage_kind_check" CHECK ("kind" IN ('ACTIVE', 'LOST')),
  ADD CONSTRAINT "LifecycleStage_terminal_flags_check" CHECK (
    ("kind" = 'ACTIVE' OR ("isDefault" = false AND "isWon" = false))
    AND NOT ("isDefault" = true AND "isWon" = true)
  );

CREATE UNIQUE INDEX "LifecycleStage_one_default_per_org"
  ON "LifecycleStage"("organizationId")
  WHERE "isDefault" = true;

CREATE UNIQUE INDEX "LifecycleStage_one_won_per_org"
  ON "LifecycleStage"("organizationId")
  WHERE "isWon" = true;

DROP INDEX IF EXISTS "LifecycleStage_organizationId_orderIndex_idx";
CREATE INDEX "LifecycleStage_organizationId_kind_orderIndex_idx"
  ON "LifecycleStage"("organizationId", "kind", "orderIndex");
