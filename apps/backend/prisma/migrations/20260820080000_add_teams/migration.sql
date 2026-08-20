-- Add organization-owned Teams as the replacement for the ISP-shaped Department enum.
-- This migration is intentionally additive: legacy department columns remain during the
-- application transition, while team references are backfilled from existing data.

CREATE TABLE "Team" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "color" TEXT NOT NULL DEFAULT '#6366F1',
  "emoji" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserTeam" (
  "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserTeam_pkey" PRIMARY KEY ("organizationId", "userId", "teamId")
);

ALTER TABLE "User" ADD COLUMN "primaryTeamId" TEXT;
ALTER TABLE "WhatsappSession" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "teamId" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "teamId" TEXT;

CREATE UNIQUE INDEX "Team_id_organizationId_key" ON "Team"("id", "organizationId");
CREATE UNIQUE INDEX "Team_organizationId_slug_key" ON "Team"("organizationId", "slug");
CREATE INDEX "Team_organizationId_isDefault_idx" ON "Team"("organizationId", "isDefault");
CREATE INDEX "UserTeam_organizationId_teamId_idx" ON "UserTeam"("organizationId", "teamId");
CREATE INDEX "User_organizationId_primaryTeamId_idx" ON "User"("organizationId", "primaryTeamId");
CREATE INDEX "WhatsappSession_organizationId_teamId_idx" ON "WhatsappSession"("organizationId", "teamId");
CREATE INDEX "Conversation_organizationId_teamId_idx" ON "Conversation"("organizationId", "teamId");
CREATE INDEX "MessageTemplate_organizationId_teamId_category_isActive_idx" ON "MessageTemplate"("organizationId", "teamId", "category", "isActive");

ALTER TABLE "Team"
  ADD CONSTRAINT "Team_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTeam"
  ADD CONSTRAINT "UserTeam_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTeam"
  ADD CONSTRAINT "UserTeam_userId_organizationId_fkey"
  FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserTeam"
  ADD CONSTRAINT "UserTeam_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Team" ("id", "organizationId", "name", "slug", "description", "isDefault", "color", "emoji")
SELECT
  'team_' || md5(o.id || ':general') AS "id",
  o.id AS "organizationId",
  'General' AS "name",
  'general' AS "slug",
  'Default inbox for new conversations and users' AS "description",
  true AS "isDefault",
  '#6366F1' AS "color",
  NULL AS "emoji"
FROM "Organization" o
ON CONFLICT ("organizationId", "slug") DO NOTHING;

WITH used_departments AS (
  SELECT "organizationId", department::text AS department FROM "User"
  UNION
  SELECT "organizationId", department::text AS department FROM "Conversation" WHERE department IS NOT NULL
  UNION
  SELECT "organizationId", department::text AS department FROM "WhatsappSession"
  UNION
  SELECT "organizationId", dept::text AS department FROM "MessageTemplate" WHERE dept IS NOT NULL
),
team_seed AS (
  SELECT DISTINCT
    "organizationId",
    CASE department
      WHEN 'IT' THEN 'support'
      WHEN 'MARKETING' THEN 'sales'
      WHEN 'ADMIN' THEN 'admin'
      ELSE lower(department)
    END AS slug,
    CASE department
      WHEN 'IT' THEN 'Support'
      WHEN 'MARKETING' THEN 'Sales'
      WHEN 'ADMIN' THEN 'Administration'
      ELSE initcap(lower(department))
    END AS name,
    CASE department
      WHEN 'IT' THEN 'Customer support conversations'
      WHEN 'MARKETING' THEN 'Sales and growth conversations'
      WHEN 'ADMIN' THEN 'Administration workspace'
      ELSE 'Imported team'
    END AS description,
    CASE department
      WHEN 'IT' THEN '#2563EB'
      WHEN 'MARKETING' THEN '#DB2777'
      WHEN 'ADMIN' THEN '#475569'
      ELSE '#6366F1'
    END AS color,
    CASE department
      WHEN 'IT' THEN NULL
      WHEN 'MARKETING' THEN NULL
      WHEN 'ADMIN' THEN NULL
      ELSE NULL
    END AS emoji
  FROM used_departments
  WHERE department IS NOT NULL
)
INSERT INTO "Team" ("id", "organizationId", "name", "slug", "description", "isDefault", "color", "emoji")
SELECT
  'team_' || md5("organizationId" || ':' || slug) AS "id",
  "organizationId",
  name,
  slug,
  description,
  false,
  color,
  emoji
FROM team_seed
ON CONFLICT ("organizationId", "slug") DO NOTHING;

UPDATE "User" u
SET "primaryTeamId" = COALESCE(
  (
    SELECT t.id
    FROM "Team" t
    WHERE t."organizationId" = u."organizationId"
      AND t.slug = CASE u.department::text
        WHEN 'IT' THEN 'support'
        WHEN 'MARKETING' THEN 'sales'
        WHEN 'ADMIN' THEN 'admin'
        ELSE lower(u.department::text)
      END
    LIMIT 1
  ),
  (
    SELECT g.id
    FROM "Team" g
    WHERE g."organizationId" = u."organizationId"
      AND g.slug = 'general'
    LIMIT 1
  )
);

INSERT INTO "UserTeam" ("organizationId", "userId", "teamId")
SELECT u."organizationId", u.id, u."primaryTeamId"
FROM "User" u
WHERE u."primaryTeamId" IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO "UserTeam" ("organizationId", "userId", "teamId")
SELECT u."organizationId", u.id, t.id
FROM "User" u
JOIN "Team" t ON t."organizationId" = u."organizationId"
WHERE u.role = 'ADMIN'
ON CONFLICT DO NOTHING;

UPDATE "WhatsappSession" ws
SET "teamId" = t.id
FROM "Team" t
WHERE t."organizationId" = ws."organizationId"
  AND t.slug = CASE ws.department::text
    WHEN 'IT' THEN 'support'
    WHEN 'MARKETING' THEN 'sales'
    WHEN 'ADMIN' THEN 'admin'
    ELSE lower(ws.department::text)
  END;

UPDATE "Conversation" c
SET "teamId" = t.id
FROM "Team" t
WHERE t."organizationId" = c."organizationId"
  AND c.department IS NOT NULL
  AND t.slug = CASE c.department::text
    WHEN 'IT' THEN 'support'
    WHEN 'MARKETING' THEN 'sales'
    WHEN 'ADMIN' THEN 'admin'
    ELSE lower(c.department::text)
  END;

UPDATE "Conversation" c
SET "teamId" = COALESCE(ws."teamId", g.id)
FROM "WhatsappSession" ws
JOIN "Team" g ON g."organizationId" = ws."organizationId" AND g.slug = 'general'
WHERE ws."organizationId" = c."organizationId"
  AND ws.id = c."sessionId"
  AND c."teamId" IS NULL;

UPDATE "MessageTemplate" mt
SET "teamId" = t.id
FROM "Team" t
WHERE t."organizationId" = mt."organizationId"
  AND mt.dept IS NOT NULL
  AND t.slug = CASE mt.dept::text
    WHEN 'IT' THEN 'support'
    WHEN 'MARKETING' THEN 'sales'
    WHEN 'ADMIN' THEN 'admin'
    ELSE lower(mt.dept::text)
  END;

ALTER TABLE "User"
  ADD CONSTRAINT "User_primaryTeamId_organizationId_fkey"
  FOREIGN KEY ("primaryTeamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WhatsappSession"
  ADD CONSTRAINT "WhatsappSession_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_teamId_organizationId_fkey"
  FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
