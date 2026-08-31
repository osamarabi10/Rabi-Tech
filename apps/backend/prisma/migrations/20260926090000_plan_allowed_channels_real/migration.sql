-- allowedChannels stops being decorative.
--
-- The column shipped as {OPENWA} on every edition, was identical on all five,
-- was never read by anything, and the PATCH endpoint refused to let an owner
-- set it — three separate signals that it granted nothing. A Meta-only tier is
-- a stated product requirement, so it has to start meaning something.
--
-- Enforcement lands in channels.routes.ts in the same change. This migration is
-- only the data half, and it exists because enforcing the shipped values would
-- be a regression rather than a feature: the Meta channel kind is
-- WHATSAPP_CLOUD, no edition listed it, and Meta connection is currently
-- allowed on all five because nothing checks. Turning the check on against
-- {OPENWA} would silently withdraw Meta from every subscriber who has it today.
--
-- So every edition is widened to both kinds, which preserves exactly what is
-- possible right now. The lever becomes real without moving anything with it,
-- and narrowing an edition to one channel is then an owner decision made in
-- the console — which is where a product decision belongs.

UPDATE "Plan" SET "allowedChannels" = ARRAY['OPENWA', 'WHATSAPP_CLOUD'];
