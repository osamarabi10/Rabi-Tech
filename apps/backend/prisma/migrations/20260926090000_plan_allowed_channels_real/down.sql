-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Restores the shipped {OPENWA} on every edition. Only correct while the code
-- half is also reverted: with enforcement still active, this would withdraw
-- Meta from every subscriber at once, which is precisely the regression the
-- forward migration exists to avoid.
--
-- Lossy if an owner has already narrowed an edition deliberately — this
-- overwrites every row rather than restoring what each one held. Check first:
--
--   SELECT code, "allowedChannels" FROM "Plan"
--   WHERE "allowedChannels" <> ARRAY['OPENWA','WHATSAPP_CLOUD'];
--
-- Any row returned was set on purpose and this discards that decision.

UPDATE "Plan" SET "allowedChannels" = ARRAY['OPENWA'];
