-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Restores the inversion: STANDARD grants less than FREE again. Only run this
-- if the forward change is being reverted for a reason other than the defect
-- it fixed, because on its own it reintroduces a paying tier that is worse
-- than the free one.
--
-- Guarded the same way, so it cannot overwrite a value an owner set
-- deliberately from the console after the fact.
--
-- No organization was on STANDARD when this was applied, so neither direction
-- changes what any subscriber is entitled to today. That will not be true once
-- one is: at that point this is a downgrade of a live subscription, and
-- reversing it needs the consequence preview that does not exist yet.

UPDATE "Plan"
SET "customFieldsLimit" = 0
WHERE "code" = 'STANDARD' AND "customFieldsLimit" = 5;

UPDATE "Plan"
SET "workflowsLimit" = 0
WHERE "code" = 'STANDARD' AND "workflowsLimit" = 1;
