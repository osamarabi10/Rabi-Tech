ALTER TABLE "OrganizationConfig"
ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
ADD COLUMN "userInactivityTimeoutMinutes" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN "weeklyRecapEnabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "OrganizationConfig" AS config
SET "timezone" = hours."timezone"
FROM "WorkingHours" AS hours
WHERE hours."organizationId" = config."organizationId";

ALTER TABLE "OrganizationConfig"
ADD CONSTRAINT "OrganizationConfig_userInactivityTimeoutMinutes_check"
CHECK ("userInactivityTimeoutMinutes" BETWEEN 5 AND 10080);

CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WeeklyRecapRecipient" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyRecapRecipient_pkey" PRIMARY KEY ("organizationId", "userId")
);

CREATE UNIQUE INDEX "AuthSession_id_organizationId_key" ON "AuthSession"("id", "organizationId");
CREATE INDEX "AuthSession_organizationId_userId_revokedAt_idx" ON "AuthSession"("organizationId", "userId", "revokedAt");
CREATE INDEX "AuthSession_lastSeenAt_idx" ON "AuthSession"("lastSeenAt");
CREATE INDEX "WeeklyRecapRecipient_organizationId_createdAt_idx" ON "WeeklyRecapRecipient"("organizationId", "createdAt");

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuthSession"
ADD CONSTRAINT "AuthSession_userId_organizationId_fkey"
FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WeeklyRecapRecipient"
ADD CONSTRAINT "WeeklyRecapRecipient_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WeeklyRecapRecipient"
ADD CONSTRAINT "WeeklyRecapRecipient_userId_organizationId_fkey"
FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
