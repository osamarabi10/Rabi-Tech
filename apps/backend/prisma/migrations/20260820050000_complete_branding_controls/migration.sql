-- Additive P1.5 branding completion controls.
ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'FREE';

ALTER TABLE "OrganizationBranding"
  ADD COLUMN IF NOT EXISTS "customFooter" TEXT,
  ADD COLUMN IF NOT EXISTS "customDomainVerificationToken" TEXT,
  ADD COLUMN IF NOT EXISTS "customDomainVerifiedAt" TIMESTAMP(3);

UPDATE "Organization"
SET "tier" = 'FREE'
WHERE "tier" IS NULL OR "tier" = '';
