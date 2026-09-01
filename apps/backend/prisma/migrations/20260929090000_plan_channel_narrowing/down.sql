-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- Restores the E5d state: every edition allows both channel kinds. That is a
-- widening, so it takes nothing away from anyone and is safe to run at any
-- time.
--
-- Guarded the same way and for the same reason: it fires only where the row
-- still holds exactly what the forward migration wrote, so an owner who has
-- since edited an edition's channels from the console keeps their decision
-- rather than having it silently replaced by a rollback.
--
-- What this cannot restore is a channel switch someone made in between. If an
-- organization on a narrowed edition moved its active channel to
-- WHATSAPP_CLOUD because OPENWA became unselectable, reversing the catalogue
-- makes OPENWA selectable again but does not switch it back — that is a tenant
-- action, not a catalogue one.

UPDATE "Plan"
SET "allowedChannels" = ARRAY['OPENWA', 'WHATSAPP_CLOUD']
WHERE "code" IN ('GROWTH', 'BUSINESS', 'ENTERPRISE')
  AND "allowedChannels" @> ARRAY['WHATSAPP_CLOUD']
  AND "allowedChannels" <@ ARRAY['WHATSAPP_CLOUD'];
