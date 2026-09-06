-- Restore Organization.tier.
--
-- The column is reconstructed from the live subscription, which is where the
-- value came from in the first place. That reconstruction is exact for every
-- organization whose column agreed with its subscription — and the forward
-- migration recorded how many did not, so this script can refuse rather than
-- quietly inventing values for the ones it cannot rebuild.
--
-- Guard 1 refuses when there is no audit trail. Without the recorded counts
-- this script cannot tell a database this migration emptied from one that has
-- been running since, and it would restore a column full of guesses that look
-- exactly like the originals.
--
-- Guard 2 refuses when the forward migration found rows whose column disagreed
-- with their subscription. Those values cannot be rebuilt from the
-- subscription, because disagreeing with it is precisely what they did. On the
-- database this ran against the count was zero; anywhere it is not, the
-- reversal would silently overwrite a real difference.
--
-- Guard 3 refuses when organizations have been created since. Their `tier`
-- never existed, so restoring the column would fabricate a value for them and
-- there is no way afterwards to tell which rows were fabricated.

DO $do$
DECLARE
  recorded_orgs   integer;
  recorded_bad    integer;
  present_orgs    integer;
  audit_rows      integer;
BEGIN
  SELECT count(*) INTO audit_rows
    FROM "PlatformAuditLog"
   WHERE action = 'organization.tier-dropped';

  IF audit_rows = 0 THEN
    RAISE EXCEPTION
      'Refusing: found 0 organization.tier-dropped audit rows, so there is no record of what this column held. Restoring it would fill every row with a value reconstructed from the subscription, with nothing left to say which of those were reconstructions.';
  END IF;

  SELECT ("beforeState" ->> 'organizations')::integer,
         ("beforeState" ->> 'disagreeing')::integer
    INTO recorded_orgs, recorded_bad
    FROM "PlatformAuditLog"
   WHERE action = 'organization.tier-dropped'
   ORDER BY timestamp DESC
   LIMIT 1;

  IF recorded_bad > 0 THEN
    RAISE EXCEPTION
      'Refusing: the migration recorded % organization(s) whose tier disagreed with their live subscription. Those values cannot be rebuilt from the subscription — disagreeing with it is what they did — and this script would replace a real difference with a plausible fiction.',
      recorded_bad;
  END IF;

  SELECT count(*) INTO present_orgs FROM "Organization";

  IF present_orgs <> recorded_orgs THEN
    RAISE EXCEPTION
      'Refusing: the migration ran against % organization(s) and there are % now. Any organization created since never had a tier, so restoring the column would invent one, and nothing afterwards could tell an invented value from a restored one.',
      recorded_orgs, present_orgs;
  END IF;

  ALTER TABLE "Organization" ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'FREE';

  UPDATE "Organization" o
     SET "tier" = coalesce(
       (SELECT s."planCode" FROM "Subscription" s
         WHERE s."organizationId" = o.id AND s.status IN ('ACTIVE', 'TRIALING')
         ORDER BY s."createdAt" DESC LIMIT 1),
       'FREE');

  DELETE FROM "PlatformAuditLog"
   WHERE action = 'organization.tier-dropped';
END
$do$;
