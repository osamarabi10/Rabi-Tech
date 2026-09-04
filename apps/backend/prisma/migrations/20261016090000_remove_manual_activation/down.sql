-- Reverse the manual-activation removal.
--
-- Restores PENDING to exactly the organizations this migration changed, named
-- by their audit rows, and refuses anything it cannot account for. Both guards
-- are counted so a refusal says which number was wrong rather than "no".
--
-- Guard 1 refuses when there is no audit trail: without it this script has no
-- way to tell a migrated organization from one that was always ACTIVE, and
-- setting every ACTIVE organization to PENDING would lock the whole platform
-- out of logging in.
--
-- Guard 2 refuses when a migrated organization has since moved off ACTIVE.
-- Suspending it, or deleting it, means the world has changed underneath this
-- script and restoring PENDING would overwrite a newer decision.

DO $do$
DECLARE
  migrated   integer;
  accounted  integer;
BEGIN
  SELECT count(*) INTO migrated
    FROM "PlatformAuditLog"
   WHERE action = 'organization.activation-migrated';

  IF migrated = 0 THEN
    RAISE EXCEPTION
      'Refusing: found 0 organization.activation-migrated audit rows, so there is no record of which organizations to restore. Reversing blindly would set every ACTIVE organization to PENDING and lock every subscriber out.';
  END IF;

  SELECT count(*) INTO accounted
    FROM "PlatformAuditLog" p
    JOIN "Organization" o
      ON o.id = p."targetOrgId"
     AND o.status = 'ACTIVE'
   WHERE p.action = 'organization.activation-migrated';

  IF accounted <> migrated THEN
    RAISE EXCEPTION
      'Refusing: % audit rows but only % of those organizations are still ACTIVE. The rest have been suspended or deleted since the migration, and restoring PENDING would overwrite a newer decision.',
      migrated, accounted;
  END IF;

  UPDATE "Organization"
     SET status = 'PENDING'
   WHERE id IN (
     SELECT "targetOrgId"
       FROM "PlatformAuditLog"
      WHERE action = 'organization.activation-migrated'
   );

  DELETE FROM "PlatformAuditLog"
   WHERE action = 'organization.activation-migrated';
END
$do$;
