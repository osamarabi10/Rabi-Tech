-- Move the edition catalogue into the database.
--
-- Plan carried only price and name, so what a subscriber may actually do lived
-- in the PLAN_ENTITLEMENTS constant and repricing a tier meant a deploy. These
-- columns let the platform owner change the menu, not just grant one customer
-- an exception.
--
-- Every column is nullable or defaulted, so the four rows that already exist
-- stay valid and are filled by a separate, reviewable seed step. Nothing reads
-- these columns yet; the accessor migration comes after the seed is proven
-- byte-identical to the constant.

-- Metered allowances. NULL means unlimited, matching the constant.
ALTER TABLE "Plan"
  ADD COLUMN "monthlyActiveContactsLimit"   INTEGER,
  ADD COLUMN "monthlyOutboundMessagesLimit" INTEGER,
  ADD COLUMN "monthlyCampaignSendsLimit"    INTEGER,
  ADD COLUMN "customFieldsLimit"            INTEGER,
  ADD COLUMN "usersLimit"                   INTEGER,
  ADD COLUMN "workflowsLimit"               INTEGER;

-- Broadcast pacing. OpenWA drives WhatsApp Web, so blasting risks a ban.
ALTER TABLE "Plan"
  ADD COLUMN "campaignRateMax"        INTEGER,
  ADD COLUMN "campaignRateDurationMs" INTEGER;

-- Feature grants. Defaulted false so an unseeded row grants nothing: a new
-- edition must be given its features deliberately, never inherit them.
ALTER TABLE "Plan"
  ADD COLUMN "customDomain"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "whiteLabel"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maskContactDetails" BOOLEAN NOT NULL DEFAULT false;

-- NOT ENFORCED. Stored so the catalogue is complete and the console can show it
-- greyed with a reason, rather than offering a switch that does nothing.
ALTER TABLE "Plan"
  ADD COLUMN "autoProvisionGateway" BOOLEAN NOT NULL DEFAULT false;

-- Channel kinds this edition may use, matching OrganizationChannel.kind. A list
-- rather than a single value, so an edition may offer a choice and so Meta can
-- join later without a migration. Defaulted to OPENWA, the only transport that
-- exists today. Carried but NOT enforced: no code permits or refuses a channel
-- by edition yet, and the policy is still an open product question.
ALTER TABLE "Plan"
  ADD COLUMN "allowedChannels" TEXT[] NOT NULL DEFAULT ARRAY['OPENWA']::TEXT[];

-- Widen the plan-override constraint to admit STANDARD.
--
-- Organization.planOverride is TEXT with a CHECK listing the valid codes, not an
-- enum, so the code list lives in SQL as well as in PlanCode. Adding a fifth
-- edition without this would let an owner select Standard in the console and be
-- refused by the database at write time - the failure landing on the one person
-- who has no way to diagnose it.
--
-- Dropped and recreated rather than altered: Postgres has no ALTER CONSTRAINT
-- for a CHECK expression, and IF EXISTS keeps this rerunnable on a database
-- where the constraint was never created.
ALTER TABLE "Organization" DROP CONSTRAINT IF EXISTS "Organization_planOverride_check";
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planOverride_check"
  CHECK ("planOverride" IS NULL
         OR "planOverride" IN ('FREE','STANDARD','GROWTH','BUSINESS','ENTERPRISE'));
