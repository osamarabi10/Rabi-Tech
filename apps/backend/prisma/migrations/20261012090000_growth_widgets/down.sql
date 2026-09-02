-- Reverses 20261012090000_growth_widgets.
--
-- This one refuses harder than most, because what it would destroy is not
-- recoverable from anywhere — not from a backup of another table, not from a
-- vendor, not by asking the customer.
--
-- A WidgetClick row holds the landing page, the referrer and the UTM values of
-- one visit. The browser that knew them made a single request and never comes
-- back. There is no later moment at which that information can be obtained, so
-- a dropped click table is not a table that can be rebuilt: it is a fact about
-- the past that stops existing.
--
-- Check before running, in this order:
--
--   SELECT count(*) FROM "WidgetClick";
--   SELECT count(*) FROM "Contact" WHERE "acquisitionWidgetId" IS NOT NULL;
--   SELECT count(*) FROM "GrowthWidget" g
--     WHERE EXISTS (SELECT 1 FROM "WidgetClick" c WHERE c."widgetId" = g."id");
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261012090000_growth_widgets';

BEGIN;

DO $$
DECLARE
  click_count      bigint;
  attributed_count bigint;
  clicked_widgets  bigint;
BEGIN
  SELECT count(*) INTO click_count FROM "WidgetClick";

  IF click_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % widget click(s) exist. Each one holds a landing page, '
      'referrer and campaign that were knowable for exactly one HTTP request and '
      'are recoverable from nowhere. Export them before reversing if they matter.',
      click_count;
  END IF;

  SELECT count(*) INTO attributed_count
    FROM "Contact" WHERE "acquisitionWidgetId" IS NOT NULL;

  IF attributed_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % contact(s) carry first-touch attribution. Dropping '
      'these columns destroys it, and the click table is dropped in the same '
      'transaction, so there is no second copy to restore from.',
      attributed_count;
  END IF;

  SELECT count(*) INTO clicked_widgets
    FROM "GrowthWidget" g
    WHERE EXISTS (SELECT 1 FROM "WidgetClick" c WHERE c."widgetId" = g."id");

  IF clicked_widgets > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % widget(s) have been clicked. A widget nobody has used '
      'is recreatable and does not block this; one that has been used may have '
      'its token printed on something physical, and dropping it makes that '
      'artifact dead permanently.',
      clicked_widgets;
  END IF;
END $$;

ALTER TABLE "Contact" DROP CONSTRAINT IF EXISTS "Contact_acquisitionWidgetId_organizationId_fkey";

DROP INDEX IF EXISTS "Contact_organizationId_acquisitionWidgetId_partial_idx";
DROP INDEX IF EXISTS "WidgetClick_organizationId_unclaimed_partial_idx";

DROP TABLE IF EXISTS "WidgetClick";
DROP TABLE IF EXISTS "GrowthWidget";

ALTER TABLE "Contact" DROP COLUMN IF EXISTS "acquisitionAt";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "acquisitionUtmCampaign";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "acquisitionWidgetId";
ALTER TABLE "Contact" DROP COLUMN IF EXISTS "acquisitionSource";

DROP TYPE IF EXISTS "GrowthWidgetType";
DROP TYPE IF EXISTS "AcquisitionSource";

COMMIT;
