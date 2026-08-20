-- CreateEnum
CREATE TYPE "GatewayProvisioningState" AS ENUM (
  'PENDING',
  'PROVISIONING',
  'AWAITING_QR',
  'ACTIVE',
  'SUSPENDED',
  'FAILED'
);

CREATE TYPE "GatewayProvisioningStep" AS ENUM (
  'ALLOCATE_RESOURCES',
  'START_GATEWAY',
  'WAIT_FOR_PROVIDER',
  'CREATE_SESSION',
  'REGISTER_WEBHOOK',
  'AWAIT_CONNECTION',
  'SUSPEND_GATEWAY',
  'RESUME_GATEWAY',
  'RESTART_GATEWAY',
  'DESTROY_GATEWAY',
  'COMPLETE'
);

-- AlterTable
ALTER TABLE "OrganizationChannel"
  ADD COLUMN "provisioningState" "GatewayProvisioningState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "provisioningStep" "GatewayProvisioningStep",
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "failureStep" "GatewayProvisioningStep",
  ADD COLUMN "managedByProvisioner" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deploymentName" TEXT,
  ADD COLUMN "apiPort" INTEGER,
  ADD COLUMN "dashboardPort" INTEGER,
  ADD COLUMN "dataVolumeName" TEXT,
  ADD COLUMN "redisVolumeName" TEXT,
  ADD COLUMN "provisioningStartedAt" TIMESTAMP(3),
  ADD COLUMN "provisionedAt" TIMESTAMP(3),
  ADD COLUMN "connectedAt" TIMESTAMP(3),
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "deletionRequestedAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3);

-- Existing live/manual channels are observed but never lifecycle-managed by the new worker.
UPDATE "OrganizationChannel"
SET
  "provisioningState" = CASE WHEN "status" = 'ACTIVE' THEN 'ACTIVE'::"GatewayProvisioningState" ELSE 'PENDING'::"GatewayProvisioningState" END,
  "provisioningStep" = CASE WHEN "status" = 'ACTIVE' THEN 'COMPLETE'::"GatewayProvisioningStep" ELSE NULL END,
  "managedByProvisioner" = false;

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationChannel_deploymentName_key" ON "OrganizationChannel"("deploymentName");
CREATE UNIQUE INDEX "OrganizationChannel_apiPort_key" ON "OrganizationChannel"("apiPort");
CREATE UNIQUE INDEX "OrganizationChannel_dashboardPort_key" ON "OrganizationChannel"("dashboardPort");
CREATE UNIQUE INDEX "OrganizationChannel_dataVolumeName_key" ON "OrganizationChannel"("dataVolumeName");
CREATE UNIQUE INDEX "OrganizationChannel_redisVolumeName_key" ON "OrganizationChannel"("redisVolumeName");
CREATE INDEX "OrganizationChannel_managedByProvisioner_provisioningState_idx"
  ON "OrganizationChannel"("managedByProvisioner", "provisioningState");

-- CreateTable
CREATE TABLE "PlatformAlert" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'ERROR',
  "message" TEXT NOT NULL,
  "metadata" JSONB,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatformAlert_resolvedAt_createdAt_idx" ON "PlatformAlert"("resolvedAt", "createdAt");
CREATE INDEX "PlatformAlert_organizationId_createdAt_idx" ON "PlatformAlert"("organizationId", "createdAt");

ALTER TABLE "PlatformAlert"
  ADD CONSTRAINT "PlatformAlert_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
