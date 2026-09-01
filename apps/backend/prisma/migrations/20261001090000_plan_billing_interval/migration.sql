-- An edition can be sold yearly, not only monthly.
--
-- WHAT THIS DOES NOT CHANGE, which is the distinction the whole change turns on:
--
--   * billing interval  — how often the subscriber is CHARGED. New here.
--   * usage month       — how often their allowances RESET. Unchanged, and
--                         deliberately so.
--
-- Every column named monthly* is the second kind: monthlyActiveContactsLimit
-- and its siblings are metered per calendar month by monthRange(), and a yearly
-- subscription still meters monthly. Conflating the two would mean a yearly
-- subscriber getting twelve months of allowance on day one, which is not what
-- anybody is selling.
--
-- monthlyPriceCents is deliberately NOT renamed. It now means "the amount
-- charged per interval", which the column comment records. The name is wrong
-- and the rename is real debt, but it has 52 references across 11 files, spans
-- the API boundary into the frontend, and appears in three applied migrations —
-- a diff that large for no behaviour change is exactly where a real bug hides.
-- Recorded as debt rather than paid here.
--
-- Defaulted to MONTHLY, which is what every existing row already is, so this
-- migration moves no money and changes no subscriber's terms.
--
-- The Stripe adapter maps an edition to a Stripe Price through the environment,
-- and a second interval means a second price per edition: the map becomes
-- STRIPE_PRICE_<CODE>_<INTERVAL>. An unmapped combination refuses at checkout
-- rather than charging against the wrong price.

CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'YEARLY');

ALTER TABLE "Plan" ADD COLUMN "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY';

COMMENT ON COLUMN "Plan"."monthlyPriceCents" IS
  'The amount charged per billingInterval, in cents. The name predates yearly billing and is retained deliberately; see migration 20261001090000.';
