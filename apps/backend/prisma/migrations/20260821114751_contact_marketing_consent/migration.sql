-- Marketing consent. On the official WhatsApp API Meta enforces opt-out; on an
-- unofficial gateway nothing does, so this column is the only thing standing
-- between a tenant and messaging a contact who asked them to stop.
DO $$ BEGIN
  CREATE TYPE "MarketingConsent" AS ENUM ('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Contact"
  ADD COLUMN IF NOT EXISTS "marketingConsent" "MarketingConsent" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "consentSource"    TEXT,
  ADD COLUMN IF NOT EXISTS "consentUpdatedAt" TIMESTAMP(3);

-- Broadcast audience resolution filters on this on every send.
CREATE INDEX IF NOT EXISTS "Contact_organizationId_marketingConsent_idx"
  ON "Contact" ("organizationId", "marketingConsent");
