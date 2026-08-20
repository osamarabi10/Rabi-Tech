-- Configurable auto-replies.
--
-- Every customer-facing automatic message must resolve from an organization-owned
-- MessageTemplate row. There are NO code fallbacks: if an organization has not
-- configured (or has deactivated) a given auto-reply, nothing is sent.
--
-- This replaces the hardcoded TEMPLATES constants, which shipped one company's
-- wording -- including their support phone number -- to every subscriber's customers.

CREATE TYPE "AutoReplyKind" AS ENUM (
  'WELCOME',
  'OUT_OF_HOURS',
  'CSAT_PROMPT',
  'CSAT_THANKS',
  'CONVERSATION_CLOSED',
  'AWAITING_CLIENT',
  'KEYWORD_CRITICAL',
  'KEYWORD_HIGH',
  'KEYWORD_MEDIUM',
  'KEYWORD_LOW'
);

ALTER TABLE "MessageTemplate" ADD COLUMN "autoReplyKind" "AutoReplyKind";

-- One template per kind per organization.
CREATE UNIQUE INDEX "MessageTemplate_organizationId_autoReplyKind_key"
  ON "MessageTemplate" ("organizationId", "autoReplyKind")
  WHERE "autoReplyKind" IS NOT NULL;

-- Adopt the two auto-replies that were already configurable.
UPDATE "MessageTemplate" t
SET "autoReplyKind" = 'WELCOME'
FROM "WorkingHours" w
WHERE w."welcomeTemplateId" = t."id" AND w."organizationId" = t."organizationId";

UPDATE "MessageTemplate" t
SET "autoReplyKind" = 'OUT_OF_HOURS'
FROM "WorkingHours" w
WHERE w."outOfHoursTemplateId" = t."id" AND w."organizationId" = t."organizationId";
