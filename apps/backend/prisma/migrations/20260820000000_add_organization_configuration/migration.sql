BEGIN;

CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PlatformAuditLog_timestamp_idx" ON "PlatformAuditLog"("timestamp");

CREATE TABLE "OrganizationConfig" (
    "organizationId" TEXT NOT NULL,
    "itSessionName" TEXT NOT NULL DEFAULT 'it-support',
    "marketingSessionName" TEXT NOT NULL DEFAULT 'marketing',
    "itNumber" TEXT,
    "marketingNumber" TEXT,
    "itAlertGroupId" TEXT,
    "sharedLine" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrganizationConfig_pkey" PRIMARY KEY ("organizationId"),
    CONSTRAINT "OrganizationConfig_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "OrganizationConfig" (
    "organizationId", "itSessionName", "marketingSessionName", "itNumber",
    "marketingNumber", "itAlertGroupId", "sharedLine", "updatedAt"
)
SELECT
    organization_row.id,
    COALESCE(it_session."sessionName", 'it-support'),
    COALESCE(marketing_session."sessionName", it_session."sessionName", 'marketing'),
    it_session."phoneNumber",
    marketing_session."phoneNumber",
    NULL,
    marketing_session.id IS NULL OR (
      it_session."phoneNumber" IS NOT NULL
      AND marketing_session."phoneNumber" = it_session."phoneNumber"
    ),
    CURRENT_TIMESTAMP
FROM "Organization" organization_row
LEFT JOIN LATERAL (
    SELECT session_row.id, session_row."sessionName", session_row."phoneNumber"
    FROM "WhatsappSession" session_row
    WHERE session_row."organizationId" = organization_row.id AND session_row.department = 'IT'
    ORDER BY session_row."createdAt"
    LIMIT 1
) it_session ON true
LEFT JOIN LATERAL (
    SELECT session_row.id, session_row."sessionName", session_row."phoneNumber"
    FROM "WhatsappSession" session_row
    WHERE session_row."organizationId" = organization_row.id AND session_row.department = 'MARKETING'
    ORDER BY session_row."createdAt"
    LIMIT 1
) marketing_session ON true;

CREATE TABLE "OrgSequence" (
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "OrgSequence_pkey" PRIMARY KEY ("organizationId", "kind"),
    CONSTRAINT "OrgSequence_organizationId_fkey"
      FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "OrgSequence" ("organizationId", "kind", "value")
SELECT organization_row.id, 'ticketLabel', COALESCE(sequence_row.value, 0)
FROM "Organization" organization_row
LEFT JOIN "Sequence" sequence_row ON sequence_row.name = 'ticketLabel:' || organization_row.id;

INSERT INTO "OrgSequence" ("organizationId", "kind", "value")
SELECT
    organization_row.id,
    'conversationDisplayId',
    GREATEST(COALESCE(MAX(conversation_row."displayId") - 1000, 0), 0)
FROM "Organization" organization_row
LEFT JOIN "Conversation" conversation_row ON conversation_row."organizationId" = organization_row.id
GROUP BY organization_row.id;

DROP TABLE "Sequence";

ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_outOfHoursTemplateId_fkey";
ALTER TABLE "WorkingHours" DROP CONSTRAINT IF EXISTS "WorkingHours_welcomeTemplateId_fkey";
ALTER TABLE "WorkingHours" DROP CONSTRAINT "WorkingHours_pkey";
ALTER TABLE "WorkingHours" RENAME TO "WorkingHours_legacy";

CREATE TABLE "WorkingHours" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
    "workDays" INTEGER[] DEFAULT ARRAY[0, 1, 2, 3, 4]::INTEGER[],
    "startTime" TEXT NOT NULL DEFAULT '08:00',
    "endTime" TEXT NOT NULL DEFAULT '20:00',
    "outOfHoursTemplateId" TEXT,
    "welcomeTemplateId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkingHours_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "WorkingHours_organizationId_key" UNIQUE ("organizationId")
);

INSERT INTO "WorkingHours" (
    "id", "organizationId", "enabled", "autoReplyEnabled", "timezone", "workDays",
    "startTime", "endTime", "outOfHoursTemplateId", "welcomeTemplateId", "updatedAt"
)
SELECT
    'wh_' || md5(organization_row.id),
    organization_row.id,
    COALESCE(legacy_row.enabled, true),
    COALESCE(legacy_row."autoReplyEnabled", true),
    COALESCE(legacy_row.timezone, 'Asia/Jerusalem'),
    COALESCE(legacy_row."workDays", ARRAY[0, 1, 2, 3, 4]::INTEGER[]),
    COALESCE(legacy_row."startTime", '08:00'),
    COALESCE(legacy_row."endTime", '20:00'),
    CASE
      WHEN template_ooh."organizationId" = organization_row.id THEN legacy_row."outOfHoursTemplateId"
      ELSE NULL
    END,
    CASE
      WHEN template_welcome."organizationId" = organization_row.id THEN legacy_row."welcomeTemplateId"
      ELSE NULL
    END,
    COALESCE(legacy_row."updatedAt", CURRENT_TIMESTAMP)
FROM "Organization" organization_row
LEFT JOIN LATERAL (SELECT * FROM "WorkingHours_legacy" LIMIT 1) legacy_row ON true
LEFT JOIN "MessageTemplate" template_ooh ON template_ooh.id = legacy_row."outOfHoursTemplateId"
LEFT JOIN "MessageTemplate" template_welcome ON template_welcome.id = legacy_row."welcomeTemplateId";

DROP TABLE "WorkingHours_legacy";

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_id_organizationId_key" UNIQUE ("id", "organizationId");
ALTER TABLE "WorkingHours"
  ADD CONSTRAINT "WorkingHours_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkingHours"
  ADD CONSTRAINT "WorkingHours_outOfHoursTemplateId_organizationId_fkey"
  FOREIGN KEY ("outOfHoursTemplateId", "organizationId")
  REFERENCES "MessageTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WorkingHours"
  ADD CONSTRAINT "WorkingHours_welcomeTemplateId_organizationId_fkey"
  FOREIGN KEY ("welcomeTemplateId", "organizationId")
  REFERENCES "MessageTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "Conversation_displayId_key";
ALTER TABLE "Conversation" ALTER COLUMN "displayId" DROP DEFAULT;
ALTER SEQUENCE "Conversation_displayId_seq" OWNED BY NONE;
DROP SEQUENCE "Conversation_displayId_seq";
CREATE UNIQUE INDEX "Conversation_organizationId_displayId_key"
  ON "Conversation"("organizationId", "displayId");

COMMIT;
