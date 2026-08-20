-- Finish the Team cutover without dropping legacy ISP columns.
-- Department columns remain temporarily for compatibility/audit only and are no longer source-of-truth.

INSERT INTO "Team" (id, "organizationId", name, slug, description, "isDefault", color, emoji, "createdAt", "updatedAt")
SELECT 'team_' || md5(o.id || ':general'), o.id, 'General', 'general', 'Default inbox team', TRUE, '#6366F1', NULL, NOW(), NOW()
FROM "Organization" o
WHERE NOT EXISTS (
  SELECT 1 FROM "Team" t WHERE t."organizationId" = o.id AND t.slug = 'general'
);

UPDATE "User" u
SET "primaryTeamId" = COALESCE(
  u."primaryTeamId",
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = u."organizationId"
      AND t.slug = CASE u.department
        WHEN 'IT' THEN 'support'
        WHEN 'MARKETING' THEN 'sales'
        WHEN 'ADMIN' THEN 'admin'
        ELSE 'general'
      END
    LIMIT 1
  ),
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = u."organizationId" AND t."isDefault" = TRUE
    ORDER BY t."createdAt" ASC
    LIMIT 1
  )
)
WHERE u."primaryTeamId" IS NULL;

INSERT INTO "UserTeam" ("organizationId", "userId", "teamId", "createdAt")
SELECT u."organizationId", u.id, u."primaryTeamId", NOW()
FROM "User" u
WHERE u."primaryTeamId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "UserTeam" ut
    WHERE ut."organizationId" = u."organizationId"
      AND ut."userId" = u.id
      AND ut."teamId" = u."primaryTeamId"
  );

UPDATE "WhatsappSession" ws
SET "teamId" = COALESCE(
  ws."teamId",
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = ws."organizationId"
      AND t.slug = CASE ws.department
        WHEN 'IT' THEN 'support'
        WHEN 'MARKETING' THEN 'sales'
        WHEN 'ADMIN' THEN 'admin'
        ELSE 'general'
      END
    LIMIT 1
  ),
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = ws."organizationId" AND t."isDefault" = TRUE
    ORDER BY t."createdAt" ASC
    LIMIT 1
  )
)
WHERE ws."teamId" IS NULL;

UPDATE "Conversation" c
SET "teamId" = COALESCE(
  c."teamId",
  ws."teamId",
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = c."organizationId"
      AND t.slug = CASE c.department
        WHEN 'IT' THEN 'support'
        WHEN 'MARKETING' THEN 'sales'
        WHEN 'ADMIN' THEN 'admin'
        ELSE 'general'
      END
    LIMIT 1
  ),
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = c."organizationId" AND t."isDefault" = TRUE
    ORDER BY t."createdAt" ASC
    LIMIT 1
  )
)
FROM "WhatsappSession" ws
WHERE c."sessionId" = ws.id
  AND c."organizationId" = ws."organizationId"
  AND c."teamId" IS NULL;

UPDATE "MessageTemplate" mt
SET "teamId" = COALESCE(
  mt."teamId",
  (
    SELECT t.id FROM "Team" t
    WHERE t."organizationId" = mt."organizationId"
      AND t.slug = CASE mt.dept
        WHEN 'IT' THEN 'support'
        WHEN 'MARKETING' THEN 'sales'
        WHEN 'ADMIN' THEN 'admin'
        ELSE 'general'
      END
    LIMIT 1
  )
)
WHERE mt."teamId" IS NULL AND mt.dept IS NOT NULL;

ALTER TABLE "User" ALTER COLUMN department DROP NOT NULL;
ALTER TABLE "WhatsappSession" ALTER COLUMN department DROP NOT NULL;