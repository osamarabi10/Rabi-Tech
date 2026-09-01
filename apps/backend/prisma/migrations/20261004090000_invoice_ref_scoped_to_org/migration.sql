-- D-28: scope invoiceRef uniqueness to the organization that issued it.
--
-- 20260921090000_invoice_reference_integrity moved this from
-- (provider, invoiceRef) to invoiceRef alone. Fixing the pair was right — it
-- let one reference exist twice under two providers, which is the collision a
-- reference exists to rule out. Making it global was the over-correction.
--
-- The sequence behind the reference is per organization
-- (OrgSequence("invoiceRef")), so under a global unique the only thing
-- separating two organizations' identical sequence numbers is four characters
-- of organization id in the format:
--
--     INV-{year}-{last 4 chars of organizationId}-{seq}
--
-- Two organizations sharing an id tail collide the first time both reach the
-- same sequence number, and a hard unique turns that into an owner unable to
-- issue an invoice at all. Nothing is corrupted and no money is misattributed;
-- it is an outage for one subscriber arriving on an ordinary action, and by
-- birthday arithmetic it stops being unlikely in the low hundreds of orgs.
--
-- (organizationId, invoiceRef) still rules out the original defect: one
-- reference cannot exist twice within an organization, whatever the provider.
-- It gives up only cross-organization uniqueness, which nothing uses — every
-- call site writes the reference at creation, reads it for display, or passes
-- it to a provider as metadata. No code path looks an invoice up by reference.
--
-- Applied while Invoice holds 0 rows, which is why the format is untouched:
-- there is no reference anywhere that has been quoted to a customer, so this is
-- the cheapest moment this change will ever have. It gets materially more
-- expensive the day after the first invoice is issued.

BEGIN;

-- Refuse rather than silently widen if reality has moved on since this was
-- written. A duplicate reference inside one organization is exactly what the
-- new constraint forbids, and discovering it by failing CREATE INDEX halfway
-- through a deploy is worse than refusing here with the count.
DO $$
DECLARE
  duplicate_count bigint;
BEGIN
  SELECT count(*) INTO duplicate_count FROM (
    SELECT 1 FROM "Invoice"
    GROUP BY "organizationId", "invoiceRef"
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'D-28 aborted: % organization/reference pairs are already duplicated', duplicate_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "Invoice_invoiceRef_key";

CREATE UNIQUE INDEX "Invoice_organizationId_invoiceRef_key"
  ON "Invoice"("organizationId", "invoiceRef");

COMMIT;
