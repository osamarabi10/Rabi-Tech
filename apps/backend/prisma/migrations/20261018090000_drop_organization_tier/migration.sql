-- Drop Organization.tier.
--
-- The column held a plan code, alongside Subscription.planCode which holds the
-- same fact. Two stores for one thing, kept in step by hand at every
-- activation, trial start, downgrade and cancellation. They agreed only for as
-- long as every one of those call sites remembered to make them agree, and the
-- one that mattered most was cancellation: it reset the column to FREE so that
-- leaving a plan did not leave the entitlements behind. That worked by
-- discipline, not by construction. See D-18.
--
-- resolveEntitlements now resolves: live override -> live subscription -> the
-- floor edition. For an organization with no live subscription that is FREE,
-- which is exactly what the column contained in that situation.
--
-- One PlatformAuditLog row records what was here, so down.sql can tell a
-- database this migration emptied from one that has been used since. `id` is
-- supplied explicitly: Prisma's @default(cuid()) is generated in the client, so
-- a raw INSERT has no default to fall back on.

INSERT INTO "PlatformAuditLog" (
  id, reason, action, "beforeState", "afterState"
)
SELECT
  'pal_' || replace(gen_random_uuid()::text, '-', ''),
  'Organization.tier dropped; the plan lives on Subscription alone',
  'organization.tier-dropped',
  jsonb_build_object(
    'organizations', count(*),
    -- Rows whose column disagreed with their live subscription. Recorded
    -- because it is the only number that could make this migration lossy: a
    -- disagreement is a fact the column held and the subscription did not.
    'disagreeing', count(*) FILTER (
      WHERE coalesce(o."tier", 'FREE') <> coalesce(
        (SELECT s."planCode" FROM "Subscription" s
          WHERE s."organizationId" = o.id AND s.status IN ('ACTIVE', 'TRIALING')
          ORDER BY s."createdAt" DESC LIMIT 1),
        'FREE')
    )
  ),
  jsonb_build_object('organizations', count(*))
FROM "Organization" o;

ALTER TABLE "Organization" DROP COLUMN "tier";
