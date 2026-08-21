-- P10-a: saved segments — a named, stored M3 contact filter.

CREATE TABLE IF NOT EXISTS "Segment" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "filter"         JSONB NOT NULL,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "deletedAt"      TIMESTAMP(3),
  CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- Composite unique so another table could reference a segment tenant-locally,
-- per the project rule that every cross-model join key carries organizationId.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_id_organizationId_key"
  ON "Segment" ("id", "organizationId");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_deletedAt_idx"
  ON "Segment" ("organizationId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_name_idx"
  ON "Segment" ("organizationId", "name");

-- Name uniqueness: PARTIAL and CASE-INSENSITIVE.
--
--   WHERE deletedAt IS NULL — a soft-deleted segment must not reserve its name
--     forever. Without this, deleting "VIP" makes "VIP" permanently unusable
--     and the only fix is a manual database edit.
--   LOWER(name) — "VIP" and "vip" are the same segment to a person, and two
--     chips differing only in case is a support ticket.
--
-- Prisma supports neither partial nor functional indexes in the schema, which
-- is why this lives here and the model carries a pointer to it.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_organizationId_name_unique_active"
  ON "Segment" ("organizationId", LOWER("name"))
  WHERE "deletedAt" IS NULL;

ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK: the join key carries organizationId on both sides, so a segment
-- can never point at a user in another tenant. RESTRICT is safe because users
-- are deactivated, never hard-deleted (system.routes.ts sets isActive: false).
ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_createdById_organizationId_fkey"
  FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
