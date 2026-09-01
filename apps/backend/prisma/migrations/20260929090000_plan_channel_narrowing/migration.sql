-- The ladder's channel story, written into the data.
--
-- The product model is that STANDARD is the tier for customers who do NOT have
-- a Meta WhatsApp Business Account. It is the only paid edition allowing
-- OpenWA. Everything above it is Meta-only, because those customers bring their
-- own WABA and token. FREE allows both so a trial can start without a WABA.
--
--   FREE         OPENWA + WHATSAPP_CLOUD    unchanged
--   STANDARD     OPENWA + WHATSAPP_CLOUD    unchanged
--   GROWTH       WHATSAPP_CLOUD             narrowed here
--   BUSINESS     WHATSAPP_CLOUD             narrowed here
--   ENTERPRISE   WHATSAPP_CLOUD             narrowed here
--
-- E5d widened every edition to both kinds deliberately, so that switching
-- enforcement on would not withdraw Meta from subscribers who had it. That was
-- right then: the lever had to become real without moving anything with it.
-- This is the other half — the data finally saying what the ladder means.
--
-- WHAT THIS DOES NOT DO, which is the part worth knowing:
--
-- Enforcement lives at the connect paths only — POST /channels/meta/connect and
-- POST /channels/active. Nothing on the send path consults allowedChannels. So
-- an organization on a narrowed edition with an already-ACTIVE OpenWA channel
-- keeps sending: the row is not touched, the channel is not disconnected, and
-- no message is refused. What it loses is the ability to switch back to OPENWA
-- once it has switched away, because /channels/active is gated.
--
-- That is a one-way exit rather than an outage, and it is the first real
-- evidence of what D-13's upgrade cliff actually does to someone already
-- connected. On this database that someone is `ostudio`, which is test data.
--
-- GUARDED, the way E5e's correction was. The UPDATE fires only where the row
-- still holds exactly the pair E5d shipped, so an owner who has since narrowed
-- or widened an edition from the console keeps their decision. Set containment
-- both ways rather than array equality, because the console's PATCH dedupes
-- through a Set and does not promise element order — an owner who re-saved the
-- same two kinds could legitimately store them the other way round, and that
-- is still the state this migration means to replace.
--
-- PLAN_ENTITLEMENTS moves in the same commit. The harness asserts the constant
-- and the rows match field for field, so a migration that moved one without the
-- other would fail the gate. That is the point of the rule, not a side effect.

UPDATE "Plan"
SET "allowedChannels" = ARRAY['WHATSAPP_CLOUD']
WHERE "code" IN ('GROWTH', 'BUSINESS', 'ENTERPRISE')
  AND "allowedChannels" @> ARRAY['OPENWA', 'WHATSAPP_CLOUD']
  AND "allowedChannels" <@ ARRAY['OPENWA', 'WHATSAPP_CLOUD'];
