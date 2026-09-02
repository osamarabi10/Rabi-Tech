-- The trial moves to STANDARD, and STANDARD gains the gateway that requires.
--
-- Until now the trial ran on GROWTH (ENTRY_PAID_PLAN_CODE). E5g narrowed GROWTH
-- to WHATSAPP_CLOUD only, and GROWTH carries autoProvisionGateway = true, so
-- every trial workspace had an OpenWA gateway built for it that its own edition
-- forbids it to pair.
--
-- That combination did not fail loudly. It failed by working: the QR endpoint
-- and the send path never consulted allowedChannels — as the E5g migration note
-- itself recorded — so the gateway paired and sent normally. Trials appeared
-- healthy for the whole period Meta was unconfigured, on a channel their edition
-- did not permit and nothing enforced.
--
-- STANDARD permits OPENWA and WHATSAPP_CLOUD both, so a trial there is
-- provisioned a channel its edition actually allows. That resolves the
-- contradiction at the root rather than by removing gateways from trials.
--
-- Only autoProvisionGateway moves. STANDARD's price and limits are untouched.

UPDATE "Plan"
SET "autoProvisionGateway" = true
WHERE code = 'STANDARD';

-- Explicit rather than relying on TRIAL_PLAN_DEFAULT.
--
-- The constant in trial.service.ts is now STANDARD too, so this row is
-- agreement rather than override. It is written anyway because the setting is
-- what the owner console reads and writes: leaving it absent means the console
-- shows no trial plan while one is plainly in force, and the first owner to set
-- it would be told they were changing nothing.
INSERT INTO "PlatformSetting" ("key", "value", "updatedBy")
VALUES ('billing.trialPlan', 'STANDARD', 'migration:20260930090000')
ON CONFLICT ("key") DO UPDATE
  SET "value" = EXCLUDED."value",
      "updatedBy" = EXCLUDED."updatedBy";
