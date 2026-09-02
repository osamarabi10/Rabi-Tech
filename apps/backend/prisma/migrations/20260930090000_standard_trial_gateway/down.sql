-- Returns the trial to GROWTH and takes STANDARD's gateway away.
--
-- Restores the D-26 contradiction: trials go back to being provisioned an
-- OpenWA gateway on a Meta-only edition. Only run this alongside reverting
-- TRIAL_PLAN_DEFAULT in trial.service.ts, or the constant and the row disagree
-- and the row wins.

UPDATE "Plan"
SET "autoProvisionGateway" = false
WHERE code = 'STANDARD';

DELETE FROM "PlatformSetting" WHERE "key" = 'billing.trialPlan';
