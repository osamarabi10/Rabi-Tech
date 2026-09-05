-- Bind every WhatsApp number to the gateway it sends through.
--
-- An outbound message leaves through the gateway of the session its
-- conversation belongs to. Until now the send path asked the *organization*
-- which channel to use, and refused with CHANNEL_AMBIGUOUS if more than one was
-- ACTIVE — so a subscriber could never run OpenWA on one number and Meta's
-- Cloud API on another, and the invariant that made that safe was also the
-- invariant that made it impossible.
--
-- The binding moves onto the number. There is then nothing to disambiguate.
--
-- ## Why the column is nullable, and what watches it
--
-- Rows that predate this migration may have no channel to bind to at all — an
-- organization with no OrganizationChannel row has numbers that were sending
-- through the pre-channel OpenWA fallback. Those become null and the send path
-- refuses them by name (SESSION_NOT_BOUND) rather than guessing.
--
-- The foreign key added below is MATCH SIMPLE, which is Postgres's default and
-- the reason nullable composite keys are a trap: when channelId is null the
-- constraint is skipped entirely, so it enforces nothing on precisely the rows
-- that need watching. That is why check:session-channel exists — it counts
-- sessions created *after* this migration that are still unbound, and the audit
-- row written here is what lets it tell a legacy null from a new bug.
--
-- ## Accounting
--
-- One PlatformAuditLog row records how many sessions were bound and how many
-- were left null. down.sql refuses unless the number of bound rows it finds is
-- exactly the number recorded here — so a session bound since the migration,
-- which every creation path now does, stops the reversal rather than being
-- silently unbound.
--
-- `id` is supplied explicitly: Prisma's @default(cuid()) is generated in the
-- client, so a raw INSERT has no default to fall back on.

ALTER TABLE "WhatsappSession" ADD COLUMN "channelId" TEXT;

-- A Meta session is named meta-<phoneNumberId> by metaSessionName() and can only
-- ever have belonged to the WHATSAPP_CLOUD channel. Bound first, so an
-- organization holding both kinds does not have its Meta numbers bound to
-- OpenWA by the broader rule below.
UPDATE "WhatsappSession" s
   SET "channelId" = c.id
  FROM "OrganizationChannel" c
 WHERE c."organizationId" = s."organizationId"
   AND c.kind = 'WHATSAPP_CLOUD'
   AND s."sessionName" LIKE 'meta-%'
   AND s."channelId" IS NULL;

-- Everything else is an OpenWA number. OrganizationChannel is unique on
-- (organizationId, kind), so this matches at most one row per session and the
-- result cannot depend on ordering.
UPDATE "WhatsappSession" s
   SET "channelId" = c.id
  FROM "OrganizationChannel" c
 WHERE c."organizationId" = s."organizationId"
   AND c.kind = 'OPENWA'
   AND s."channelId" IS NULL;

INSERT INTO "PlatformAuditLog" (
  id, reason, action, "beforeState", "afterState"
)
SELECT
  'pal_' || replace(gen_random_uuid()::text, '-', ''),
  'WhatsApp sessions bound to their gateway channel',
  'whatsapp-session.channel-backfilled',
  jsonb_build_object('boundBefore', 0),
  jsonb_build_object(
    'bound', (SELECT count(*) FROM "WhatsappSession" WHERE "channelId" IS NOT NULL),
    'leftNull', (SELECT count(*) FROM "WhatsappSession" WHERE "channelId" IS NULL),
    'total', (SELECT count(*) FROM "WhatsappSession")
  );

CREATE INDEX "WhatsappSession_organizationId_channelId_idx"
    ON "WhatsappSession"("organizationId", "channelId");

ALTER TABLE "WhatsappSession"
  ADD CONSTRAINT "WhatsappSession_channelId_organizationId_fkey"
  FOREIGN KEY ("channelId", "organizationId")
  REFERENCES "OrganizationChannel"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
