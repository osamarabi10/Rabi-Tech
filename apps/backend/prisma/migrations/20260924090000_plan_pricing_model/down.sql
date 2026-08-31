-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Schema-reversible, semantically lossy. Dropping the column restores the
-- database to a state where FREE and ENTERPRISE are both "price 0" and nothing
-- can tell them apart — the exact conflation this migration removed. Any
-- edition created while it existed loses its pricing model entirely, and
-- `isPaidPlan` falls back to deciding by name, which only has a correct answer
-- for the original five codes.
--
-- So this is safe to run while the catalogue holds only the shipped editions,
-- and lossy the moment a sixth exists — which is E4's rule, not a new one.

ALTER TABLE "Plan" DROP COLUMN "pricingModel";

DROP TYPE "PricingModel";
