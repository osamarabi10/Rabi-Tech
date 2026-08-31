-- Editions gain a pricing model.
--
-- monthlyPriceCents could express two states and needed three. FREE and
-- ENTERPRISE are both stored at 0 — one because it costs nothing, the other
-- because its price is negotiated per deal and not published — so nothing
-- could tell them apart from the column. `isPaidPlan` worked around it by
-- deciding on the code *name*, which is the only reason FREE had to be a
-- reserved code after E4 opened the space.
--
-- The backfill is explicit per code rather than derived from price, precisely
-- because price cannot distinguish the two rows this migration exists to
-- separate. Deriving it would reproduce the bug in the fix.
--
-- monthlyPriceCents deliberately stays NOT NULL. A nullable price is the
-- cleaner end state, but it ripples into the revenue sums in
-- platform.routes.ts and listPriceCents in entitlements.resolver.ts, and this
-- migration is about the shape of the ladder rather than about arithmetic.
-- NEGOTIATED simply means the number is not the answer.

CREATE TYPE "PricingModel" AS ENUM ('FREE', 'FIXED', 'NEGOTIATED');

ALTER TABLE "Plan" ADD COLUMN "pricingModel" "PricingModel" NOT NULL DEFAULT 'FIXED';

UPDATE "Plan" SET "pricingModel" = 'FREE'       WHERE "code" = 'FREE';
UPDATE "Plan" SET "pricingModel" = 'NEGOTIATED' WHERE "code" = 'ENTERPRISE';
-- STANDARD, GROWTH and BUSINESS keep the FIXED default.
