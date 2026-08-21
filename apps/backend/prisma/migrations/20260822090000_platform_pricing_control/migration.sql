-- P9: platform-owner commercial control.
--
-- These columns are resolved at REQUEST TIME by modules/billing/resolver.ts and
-- are deliberately never mirrored into OrganizationConfig. That table means
-- "what this plan grants"; overriding it in place would break override expiry
-- (an expired override would keep applying) and would make detectQuotaDrift
-- fire on every overridden org, turning a real signal into noise.

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "planOverride"      TEXT,
  ADD COLUMN IF NOT EXISTS "macQuotaOverride"  INTEGER,
  ADD COLUMN IF NOT EXISTS "discountPercent"   INTEGER,
  ADD COLUMN IF NOT EXISTS "creditCents"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "overrideReason"    TEXT,
  ADD COLUMN IF NOT EXISTS "overrideExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "overrideSetBy"     TEXT,
  ADD COLUMN IF NOT EXISTS "overrideSetAt"     TIMESTAMP(3);

-- Value integrity at the database, not only in the route handler. Mirrors the
-- PlanCode union in modules/billing/plans.ts. Organization.tier is a plain TEXT
-- column with the same value set, so planOverride is TEXT too: making one an
-- enum and leaving the other a string would put two types on one concept.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planOverride_check"
    CHECK ("planOverride" IS NULL
           OR "planOverride" IN ('FREE','GROWTH','BUSINESS','ENTERPRISE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_discountPercent_check"
    CHECK ("discountPercent" IS NULL
           OR ("discountPercent" >= 0 AND "discountPercent" <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Negative credit would be a debt, which this column does not model. Debt
-- belongs on Invoice.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_creditCents_check"
    CHECK ("creditCents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_macQuotaOverride_check"
    CHECK ("macQuotaOverride" IS NULL OR "macQuotaOverride" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A reason is mandatory whenever anything is overridden. The route enforces it
-- with a readable message; this is the backstop so a future writer cannot
-- create an unexplained commercial exception.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_override_reason_required"
    CHECK (
      ("planOverride" IS NULL AND "macQuotaOverride" IS NULL
        AND "discountPercent" IS NULL AND "overrideExpiresAt" IS NULL)
      OR ("overrideReason" IS NOT NULL AND length(btrim("overrideReason")) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The console lists live and expiring overrides; without this that is a full
-- scan of every subscriber on each console load.
CREATE INDEX IF NOT EXISTS "Organization_overrideExpiresAt_idx"
  ON "Organization" ("overrideExpiresAt")
  WHERE "overrideExpiresAt" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PlatformAuditLog already exists as {id, reason, timestamp} and is written by
-- auditPlatformScope() on every platform-scope entry. Every column added here
-- is NULLABLE so that writer keeps working and its existing rows stay valid.
--
-- targetOrgId and actorIdentityId carry NO foreign key on purpose. PlatformAlert
-- uses onDelete: SetNull, which is right for an alert and wrong for an audit
-- log: deleting a subscriber would blank out which subscriber the record was
-- about, destroying the evidence the log exists to keep.
-- ---------------------------------------------------------------------------

ALTER TABLE "PlatformAuditLog"
  ADD COLUMN IF NOT EXISTS "action"          TEXT,
  ADD COLUMN IF NOT EXISTS "actorIdentityId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail"      TEXT,
  ADD COLUMN IF NOT EXISTS "targetOrgId"     TEXT,
  ADD COLUMN IF NOT EXISTS "targetOrgName"   TEXT,
  ADD COLUMN IF NOT EXISTS "beforeState"     JSONB,
  ADD COLUMN IF NOT EXISTS "afterState"      JSONB,
  ADD COLUMN IF NOT EXISTS "ipAddress"       TEXT;

CREATE INDEX IF NOT EXISTS "PlatformAuditLog_targetOrgId_timestamp_idx"
  ON "PlatformAuditLog" ("targetOrgId", "timestamp");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_action_timestamp_idx"
  ON "PlatformAuditLog" ("action", "timestamp");
