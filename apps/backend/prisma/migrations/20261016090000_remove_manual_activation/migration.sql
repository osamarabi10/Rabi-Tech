-- Remove manual activation: every PENDING organization becomes ACTIVE.
--
-- PENDING was how the manual-activation queue was represented: an organization
-- nobody could log into until a staff member pressed a button. Signup is
-- self-serve now, so the state has no meaning and no writer.
--
-- ## Why an audit row per organization
--
-- Once PENDING cannot occur, nothing distinguishes an organization this
-- migration changed from one that was always ACTIVE. The information needed to
-- reverse is destroyed by the migration itself. So each changed organization
-- gets a PlatformAuditLog row naming it, and down.sql restores exactly those
-- ids and refuses on anything else.
--
-- PlatformAuditLog is the right home: it is not tenant-scoped, it carries
-- targetOrgId and targetOrgName as plain strings, and its own comment says an
-- audit trail must outlive the subscriber it describes.
--
-- `id` is supplied explicitly. Prisma's @default(cuid()) is generated in the
-- client, not by the database, so a raw INSERT has no default to fall back on.

INSERT INTO "PlatformAuditLog" (
  id, reason, action, "targetOrgId", "targetOrgName", "beforeState", "afterState"
)
SELECT
  'pal_' || replace(gen_random_uuid()::text, '-', ''),
  'Manual activation removed; organization migrated from PENDING to ACTIVE',
  'organization.activation-migrated',
  o.id,
  o.name,
  jsonb_build_object('status', 'PENDING'),
  jsonb_build_object('status', 'ACTIVE')
FROM "Organization" o
WHERE o.status = 'PENDING';

UPDATE "Organization" SET status = 'ACTIVE' WHERE status = 'PENDING';
