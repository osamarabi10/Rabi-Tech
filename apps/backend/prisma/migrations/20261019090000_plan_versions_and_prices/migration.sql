-- Split Plan into identity, versioned entitlements, and price.
--
-- An edition was one row holding three different kinds of fact: what it is
-- (code, name, ladder position), what it grants (limits, features, channels),
-- and what it costs. Those change on different schedules and for different
-- reasons, and a Subscription could only ever point at the row as it is *now* —
-- so editing an edition silently changed what every existing subscriber had
-- bought. See D-19.
--
-- Plan keeps identity and scheduling. PlanVersion takes the entitlements, one
-- version per plan marked current. Price takes the money, hanging off the
-- version so that repricing does not require a new entitlement version.
-- Subscription pins a PlanVersion in place of naming a code, which is what
-- makes grandfathering possible at all.
--
-- The move is a copy, not a rewrite: every entitlement column is carried across
-- unchanged into version 1, and the price is built from the columns that held
-- it. Nothing is recomputed, so nothing can be recomputed wrongly.

CREATE TABLE "PlanVersion" (
  "id"        TEXT NOT NULL,
  "planId"    TEXT NOT NULL,
  "version"   INTEGER NOT NULL,
  "isCurrent" BOOLEAN NOT NULL DEFAULT false,

  "monthlyActiveContactsLimit"   INTEGER,
  "monthlyOutboundMessagesLimit" INTEGER,
  "monthlyCampaignSendsLimit"    INTEGER,
  "customFieldsLimit"            INTEGER,
  "usersLimit"                   INTEGER,
  "maxWorkspaces"                INTEGER,
  "workflowsLimit"               INTEGER,
  "monthlyAiTokensInLimit"       BIGINT,
  "monthlyAiTokensOutLimit"      BIGINT,
  "campaignRateMax"              INTEGER,
  "campaignRateDurationMs"       INTEGER,
  "customDomain"                 BOOLEAN NOT NULL DEFAULT false,
  "whiteLabel"                   BOOLEAN NOT NULL DEFAULT false,
  "maskContactDetails"           BOOLEAN NOT NULL DEFAULT false,
  "autoProvisionGateway"         BOOLEAN NOT NULL DEFAULT false,
  "allowedChannels"              TEXT[] DEFAULT ARRAY['OPENWA']::TEXT[],

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlanVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Price" (
  "id"            TEXT NOT NULL,
  "planVersionId" TEXT NOT NULL,
  "amountCents"   INTEGER NOT NULL,
  "currency"      TEXT NOT NULL DEFAULT 'USD',
  "interval"      "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
  "pricingModel"  "PricingModel" NOT NULL DEFAULT 'FIXED',
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Price_pkey" PRIMARY KEY ("id")
);

-- Version 1 of every edition, carrying its entitlements across verbatim.
-- updatedAt is taken from the plan rather than set to now(): it is what the
-- drift detector reads as "when was this edition last edited", and stamping it
-- with the migration time would tell every subscriber's config that it predates
-- an edit that never happened.
INSERT INTO "PlanVersion" (
  "id", "planId", "version", "isCurrent",
  "monthlyActiveContactsLimit", "monthlyOutboundMessagesLimit", "monthlyCampaignSendsLimit",
  "customFieldsLimit", "usersLimit", "maxWorkspaces", "workflowsLimit",
  "monthlyAiTokensInLimit", "monthlyAiTokensOutLimit",
  "campaignRateMax", "campaignRateDurationMs",
  "customDomain", "whiteLabel", "maskContactDetails", "autoProvisionGateway",
  "allowedChannels", "createdAt", "updatedAt"
)
SELECT
  'pv_' || replace(gen_random_uuid()::text, '-', ''),
  p."id", 1, true,
  p."monthlyActiveContactsLimit", p."monthlyOutboundMessagesLimit", p."monthlyCampaignSendsLimit",
  p."customFieldsLimit", p."usersLimit", p."maxWorkspaces", p."workflowsLimit",
  p."monthlyAiTokensInLimit", p."monthlyAiTokensOutLimit",
  p."campaignRateMax", p."campaignRateDurationMs",
  p."customDomain", p."whiteLabel", p."maskContactDetails", p."autoProvisionGateway",
  p."allowedChannels", p."createdAt", p."updatedAt"
FROM "Plan" p;

-- One active price per version, from the columns that held it.
INSERT INTO "Price" (
  "id", "planVersionId", "amountCents", "currency", "interval", "pricingModel",
  "isActive", "createdAt", "updatedAt"
)
SELECT
  'price_' || replace(gen_random_uuid()::text, '-', ''),
  v."id", p."monthlyPriceCents", p."currency", p."billingInterval", p."pricingModel",
  true, p."createdAt", p."updatedAt"
FROM "Plan" p
JOIN "PlanVersion" v ON v."planId" = p."id" AND v."version" = 1;

-- Subscription pins a version instead of naming a code.
ALTER TABLE "Subscription" ADD COLUMN "planVersionId" TEXT;

UPDATE "Subscription" s
   SET "planVersionId" = v."id"
  FROM "Plan" p
  JOIN "PlanVersion" v ON v."planId" = p."id" AND v."isCurrent"
 WHERE p."code" = s."planCode";

-- Refuse rather than orphan. A subscription naming a code with no plan behind
-- it cannot be pinned, and making the column nullable to get past it would
-- leave a paying customer entitled to nothing.
DO $do$
DECLARE unpinned integer;
BEGIN
  SELECT count(*) INTO unpinned FROM "Subscription" WHERE "planVersionId" IS NULL;
  IF unpinned > 0 THEN
    RAISE EXCEPTION
      'Refusing: % subscription(s) name a plan code with no matching Plan row, so they cannot be pinned to a version. Fix the codes before migrating; a null pin would entitle a paying customer to nothing.',
      unpinned;
  END IF;
END
$do$;

ALTER TABLE "Subscription" ALTER COLUMN "planVersionId" SET NOT NULL;
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planCode_fkey";
ALTER TABLE "Subscription" DROP COLUMN "planCode";

-- The columns that moved.
ALTER TABLE "Plan"
  DROP COLUMN "monthlyPriceCents",
  DROP COLUMN "pricingModel",
  DROP COLUMN "billingInterval",
  DROP COLUMN "currency",
  DROP COLUMN "monthlyActiveContactsLimit",
  DROP COLUMN "monthlyOutboundMessagesLimit",
  DROP COLUMN "monthlyCampaignSendsLimit",
  DROP COLUMN "customFieldsLimit",
  DROP COLUMN "usersLimit",
  DROP COLUMN "maxWorkspaces",
  DROP COLUMN "workflowsLimit",
  DROP COLUMN "monthlyAiTokensInLimit",
  DROP COLUMN "monthlyAiTokensOutLimit",
  DROP COLUMN "campaignRateMax",
  DROP COLUMN "campaignRateDurationMs",
  DROP COLUMN "customDomain",
  DROP COLUMN "whiteLabel",
  DROP COLUMN "maskContactDetails",
  DROP COLUMN "autoProvisionGateway",
  DROP COLUMN "allowedChannels";

CREATE UNIQUE INDEX "PlanVersion_planId_version_key" ON "PlanVersion"("planId", "version");
CREATE INDEX "PlanVersion_planId_isCurrent_idx" ON "PlanVersion"("planId", "isCurrent");
-- Exactly one current version per plan. Prisma cannot express a partial unique
-- index, and without it "the current version" is a claim rather than a fact:
-- two current rows would make flattenEdition pick one by row order.
CREATE UNIQUE INDEX "PlanVersion_one_current_per_plan"
  ON "PlanVersion"("planId") WHERE "isCurrent";

CREATE UNIQUE INDEX "Price_planVersionId_interval_currency_key"
  ON "Price"("planVersionId", "interval", "currency");
CREATE INDEX "Price_planVersionId_isActive_idx" ON "Price"("planVersionId", "isActive");
CREATE INDEX "Subscription_planVersionId_idx" ON "Subscription"("planVersionId");

ALTER TABLE "PlanVersion" ADD CONSTRAINT "PlanVersion_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Price" ADD CONSTRAINT "Price_planVersionId_fkey"
  FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planVersionId_fkey"
  FOREIGN KEY ("planVersionId") REFERENCES "PlanVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What was moved, so down.sql can tell a database this migration shaped from
-- one that has been edited since.
INSERT INTO "PlatformAuditLog" (id, reason, action, "beforeState", "afterState")
SELECT
  'pal_' || replace(gen_random_uuid()::text, '-', ''),
  'Plan split into PlanVersion and Price; subscriptions pinned to a version',
  'plan.versioned',
  jsonb_build_object(
    'plans', (SELECT count(*) FROM "Plan"),
    'subscriptions', (SELECT count(*) FROM "Subscription")
  ),
  jsonb_build_object(
    'versions', (SELECT count(*) FROM "PlanVersion"),
    'prices', (SELECT count(*) FROM "Price")
  );
