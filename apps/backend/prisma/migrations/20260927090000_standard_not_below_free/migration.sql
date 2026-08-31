-- STANDARD granted strictly less than FREE.
--
--   customFieldsLimit   FREE 5  vs STANDARD 0
--   workflowsLimit      FREE 1  vs STANDARD 1 -> 0
--
-- A paying customer got less than a non-paying one on two axes, for $19 a
-- month. That is not a pricing opinion, it is an inversion of the ladder.
--
-- The zeros were deliberate, which is why this needs saying rather than
-- quietly fixing: STANDARD is documented as "messaging and nothing else", on
-- the reasoning that a tier granting "a few" workflows invites an argument
-- about why three is not four, while one granting none states a boundary. That
-- reasoning is sound in isolation and collides with the rung below it.
--
-- The inversion can be resolved from either end. Lowering FREE to zero would
-- also fix it — and would take capability away from organizations currently on
-- FREE, of which there are two. Raising STANDARD affects nobody: **no
-- organization is on STANDARD.** So it is raised.
--
-- These are the *minimum* values that stop the inversion, matching FREE rather
-- than choosing a number for STANDARD. What STANDARD should actually offer is a
-- pricing decision, and it is now editable from the console without a deploy —
-- which is the point of the whole phase.
--
-- Guarded: only rows still holding the shipped-wrong values are touched, so
-- re-running cannot clobber an owner's later edit.

UPDATE "Plan"
SET "customFieldsLimit" = 5
WHERE "code" = 'STANDARD' AND "customFieldsLimit" = 0;

UPDATE "Plan"
SET "workflowsLimit" = 1
WHERE "code" = 'STANDARD' AND "workflowsLimit" = 0;
