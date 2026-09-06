-- Fold PlanVersion and Price back into Plan.
--
-- Reconstructs the columns from each plan's current version and that version's
-- active price, and re-derives Subscription.planCode from the pinned version.
-- That is exact only while the catalogue still looks the way this migration
-- left it, so the guards below refuse anything else rather than collapsing
-- history into a single row and calling it a reversal.
--
-- Guard 1 refuses without an audit trail: nothing to compare against, and the
-- reconstruction would look identical to the original whether or not it was.
--
-- Guard 2 refuses when any plan has more than one version. That is the whole
-- point of the change having been used — a second version means an edition was
-- edited after subscribers were pinned to the first, and folding back keeps
-- only the current one. Every subscription still pinned to a superseded version
-- would silently move onto today's terms, which is precisely the defect D-19
-- removed.
--
-- Guard 3 refuses when a version carries more than one active price. Plan had
-- exactly one price shape, so a second currency or interval cannot be folded
-- back into it and would be dropped without trace.
--
-- Guard 4 refuses when plans have been created or removed since.

DO $do$
DECLARE
  recorded_plans integer;
  present_plans  integer;
  audit_rows     integer;
  extra_versions integer;
  extra_prices   integer;
BEGIN
  SELECT count(*) INTO audit_rows
    FROM "PlatformAuditLog" WHERE action = 'plan.versioned';
  IF audit_rows = 0 THEN
    RAISE EXCEPTION
      'Refusing: found 0 plan.versioned audit rows, so there is no record of what this migration produced. A reconstruction would be indistinguishable from the original whether or not it was correct.';
  END IF;

  SELECT ("beforeState" ->> 'plans')::integer INTO recorded_plans
    FROM "PlatformAuditLog" WHERE action = 'plan.versioned'
   ORDER BY timestamp DESC LIMIT 1;

  SELECT count(*) INTO extra_versions
    FROM (SELECT "planId" FROM "PlanVersion" GROUP BY "planId" HAVING count(*) > 1) x;
  IF extra_versions > 0 THEN
    RAISE EXCEPTION
      'Refusing: % plan(s) have more than one version. Folding back keeps only the current one, so every subscription pinned to a superseded version would move onto today''s terms — the exact failure this migration exists to prevent.',
      extra_versions;
  END IF;

  SELECT count(*) INTO extra_prices
    FROM (SELECT "planVersionId" FROM "Price" WHERE "isActive" GROUP BY "planVersionId" HAVING count(*) > 1) x;
  IF extra_prices > 0 THEN
    RAISE EXCEPTION
      'Refusing: % version(s) carry more than one active price. Plan holds a single price shape, so the others would be dropped with nothing left to say they existed.',
      extra_prices;
  END IF;

  SELECT count(*) INTO present_plans FROM "Plan";
  IF present_plans <> recorded_plans THEN
    RAISE EXCEPTION
      'Refusing: the migration ran against % plan(s) and there are % now.',
      recorded_plans, present_plans;
  END IF;

  ALTER TABLE "Plan"
    ADD COLUMN "monthlyPriceCents" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "pricingModel" "PricingModel" NOT NULL DEFAULT 'FIXED',
    ADD COLUMN "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD',
    ADD COLUMN "monthlyActiveContactsLimit" INTEGER,
    ADD COLUMN "monthlyOutboundMessagesLimit" INTEGER,
    ADD COLUMN "monthlyCampaignSendsLimit" INTEGER,
    ADD COLUMN "customFieldsLimit" INTEGER,
    ADD COLUMN "usersLimit" INTEGER,
    ADD COLUMN "maxWorkspaces" INTEGER,
    ADD COLUMN "workflowsLimit" INTEGER,
    ADD COLUMN "monthlyAiTokensInLimit" BIGINT,
    ADD COLUMN "monthlyAiTokensOutLimit" BIGINT,
    ADD COLUMN "campaignRateMax" INTEGER,
    ADD COLUMN "campaignRateDurationMs" INTEGER,
    ADD COLUMN "customDomain" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "whiteLabel" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "maskContactDetails" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "autoProvisionGateway" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "allowedChannels" TEXT[] DEFAULT ARRAY['OPENWA']::TEXT[];

  UPDATE "Plan" p SET
    "monthlyActiveContactsLimit"   = v."monthlyActiveContactsLimit",
    "monthlyOutboundMessagesLimit" = v."monthlyOutboundMessagesLimit",
    "monthlyCampaignSendsLimit"    = v."monthlyCampaignSendsLimit",
    "customFieldsLimit"            = v."customFieldsLimit",
    "usersLimit"                   = v."usersLimit",
    "maxWorkspaces"                = v."maxWorkspaces",
    "workflowsLimit"               = v."workflowsLimit",
    "monthlyAiTokensInLimit"       = v."monthlyAiTokensInLimit",
    "monthlyAiTokensOutLimit"      = v."monthlyAiTokensOutLimit",
    "campaignRateMax"              = v."campaignRateMax",
    "campaignRateDurationMs"       = v."campaignRateDurationMs",
    "customDomain"                 = v."customDomain",
    "whiteLabel"                   = v."whiteLabel",
    "maskContactDetails"           = v."maskContactDetails",
    "autoProvisionGateway"         = v."autoProvisionGateway",
    "allowedChannels"              = v."allowedChannels",
    "monthlyPriceCents"            = coalesce(pr."amountCents", 0),
    "currency"                     = coalesce(pr."currency", 'USD'),
    "billingInterval"              = coalesce(pr."interval", 'MONTHLY'),
    "pricingModel"                 = coalesce(pr."pricingModel", 'FIXED')
  FROM "PlanVersion" v
  LEFT JOIN "Price" pr ON pr."planVersionId" = v."id" AND pr."isActive"
  WHERE v."planId" = p."id" AND v."isCurrent";

  ALTER TABLE "Subscription" ADD COLUMN "planCode" TEXT;
  UPDATE "Subscription" s SET "planCode" = p."code"
    FROM "PlanVersion" v JOIN "Plan" p ON p."id" = v."planId"
   WHERE v."id" = s."planVersionId";
  ALTER TABLE "Subscription" ALTER COLUMN "planCode" SET NOT NULL;

  ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planVersionId_fkey";
  DROP INDEX "Subscription_planVersionId_idx";
  ALTER TABLE "Subscription" DROP COLUMN "planVersionId";
  ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planCode_fkey"
    FOREIGN KEY ("planCode") REFERENCES "Plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

  DROP TABLE "Price";
  DROP TABLE "PlanVersion";

  DELETE FROM "PlatformAuditLog" WHERE action = 'plan.versioned';
END
$do$;
