-- Workspace user access controls and secure email invitations.
CREATE TYPE "ContactVisibilityScope" AS ENUM ('TEAM', 'SELF');

ALTER TABLE "User"
  ADD COLUMN "restrictContactVisibility" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contactVisibilityScope" "ContactVisibilityScope" NOT NULL DEFAULT 'TEAM',
  ADD COLUMN "restrictCalls" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "restrictWorkflows" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maskPhoneAndEmail" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "UserInvitation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT,
  "role" "Role" NOT NULL DEFAULT 'AGENT',
  "primaryTeamId" TEXT,
  "tokenHash" TEXT NOT NULL,
  "invitedByName" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserInvitation_tokenHash_key" ON "UserInvitation"("tokenHash");
CREATE UNIQUE INDEX "UserInvitation_id_organizationId_key" ON "UserInvitation"("id", "organizationId");
CREATE INDEX "UserInvitation_organizationId_createdAt_idx" ON "UserInvitation"("organizationId", "createdAt");
CREATE INDEX "UserInvitation_organizationId_expiresAt_idx" ON "UserInvitation"("organizationId", "expiresAt");

-- At most one invitation that can still be accepted for an email in a
-- workspace. Expired rows are revoked before a replacement is issued.
CREATE UNIQUE INDEX "UserInvitation_live_email_key"
  ON "UserInvitation"("organizationId", lower("email"))
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

ALTER TABLE "UserInvitation"
  ADD CONSTRAINT "UserInvitation_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserInvitation"
  ADD CONSTRAINT "UserInvitation_primaryTeamId_organizationId_fkey"
  FOREIGN KEY ("primaryTeamId", "organizationId") REFERENCES "Team"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
