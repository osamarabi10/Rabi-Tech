CREATE TABLE "OrganizationBranding" (
  "organizationId" TEXT NOT NULL,
  "productName" TEXT NOT NULL DEFAULT 'RabiTech',
  "logoUrl" TEXT,
  "faviconUrl" TEXT,
  "primaryHsl" TEXT NOT NULL DEFAULT '262 83% 63%',
  "accentHsl" TEXT NOT NULL DEFAULT '195 90% 60%',
  "defaultLocale" TEXT NOT NULL DEFAULT 'ar',
  "direction" TEXT NOT NULL DEFAULT 'rtl',
  "customDomain" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OrganizationBranding_pkey" PRIMARY KEY ("organizationId")
);

INSERT INTO "OrganizationBranding" (
  "organizationId",
  "productName",
  "primaryHsl",
  "accentHsl",
  "defaultLocale",
  "direction"
)
SELECT
  "id",
  'RabiTech',
  '262 83% 63%',
  '195 90% 60%',
  'ar',
  'rtl'
FROM "Organization"
ON CONFLICT ("organizationId") DO NOTHING;

CREATE UNIQUE INDEX "OrganizationBranding_customDomain_key"
  ON "OrganizationBranding"("customDomain");

CREATE INDEX "OrganizationBranding_customDomain_idx"
  ON "OrganizationBranding"("customDomain");

ALTER TABLE "OrganizationBranding"
  ADD CONSTRAINT "OrganizationBranding_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
