-- Reverse of migration.sql, for the rollback rehearsal ONLY.
--
-- Prisma has no native down-migration; this file is applied by hand. It exists
-- so the rollback was actually exercised once, while the data was still
-- expendable, rather than first attempted during an incident.
--
-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ HARD RULE — this file is USELESS once any invoice or receipt exists. │
-- └──────────────────────────────────────────────────────────────────────┘
--
-- Note what is deliberately ABSENT below: nothing touches OrgSequence. The
-- 'invoiceRef' and 'receiptRef' rows are the high-water marks. Deleting or
-- resetting them would let the restored count-based code reissue numbers that
-- already exist on real documents — two different amounts answering to one
-- reference, discovered by the customer being billed.
--
-- So: run this only against a database with zero invoices and zero receipts.
-- Past that point, recovery is snapshot-restore or forward-fix, never this
-- file. See docs/RESPONDIO-PARITY-CHECKPOINT.md.

-- Restore the weaker per-provider uniqueness.
DROP INDEX "Invoice_invoiceRef_key";

CREATE UNIQUE INDEX "Invoice_provider_invoiceRef_key"
  ON "Invoice" ("provider", "invoiceRef");

-- Make the reference optional again.
ALTER TABLE "Invoice" ALTER COLUMN "invoiceRef" DROP NOT NULL;

-- OrgSequence rows are intentionally left in place. See the header.
