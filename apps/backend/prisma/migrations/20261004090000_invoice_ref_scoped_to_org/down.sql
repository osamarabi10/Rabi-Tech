-- Reverses 20261004090000_invoice_ref_scoped_to_org.
--
-- **Check first. This one fails late rather than early.**
--
-- Restoring the global unique validates every existing row, so it succeeds only
-- while no two organizations share an invoice reference. The moment two do —
-- which is the entire condition D-28 exists to prevent — this CREATE INDEX
-- fails, and it fails *after* any code rollback has already happened, leaving a
-- system half-reverted. That is the same shape as the plan-code-space rule in
-- RESPONDIO-PARITY-CHECKPOINT.md, and it has the same answer: check before
-- running, not after.
--
--   SELECT "invoiceRef", count(DISTINCT "organizationId") AS orgs
--   FROM "Invoice"
--   GROUP BY "invoiceRef"
--   HAVING count(DISTINCT "organizationId") > 1;
--
-- Anything returned means this reversal is not available. Forward-fix or
-- restore a snapshot instead.
--
-- The DO block below performs that check itself, so a reversal run without
-- reading this comment still refuses rather than half-applying. It is belt and
-- braces on purpose: the failure mode is a partially reverted billing schema.
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261004090000_invoice_ref_scoped_to_org';

BEGIN;

DO $$
DECLARE
  shared_count bigint;
BEGIN
  SELECT count(*) INTO shared_count FROM (
    SELECT 1 FROM "Invoice"
    GROUP BY "invoiceRef"
    HAVING count(DISTINCT "organizationId") > 1
  ) shared;

  IF shared_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % reference(s) are in use by more than one organization. '
      'Restoring the global unique would fail on them. Forward-fix instead.', shared_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "Invoice_organizationId_invoiceRef_key";

CREATE UNIQUE INDEX "Invoice_invoiceRef_key" ON "Invoice"("invoiceRef");

COMMIT;
