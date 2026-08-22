-- Payment receipts.
--
-- An invoice records what is owed; a receipt confirms money was actually taken.
-- The platform could already produce the first and had nothing for the second,
-- so "did this subscriber pay?" was answerable only from the invoice's own
-- status field, with no record of how, when, or on whose authority.
--
-- Deliberately NOT a tax document. There is no sequential tax numbering, no
-- jurisdiction, no VAT breakdown, and nothing in the rendered output is
-- labelled חשבונית מס or فاتورة ضريبية. `reference` is an identifier for this
-- system's own document, and the renderer says so on the page. Issuing a
-- tax-valid document requires a real accounting provider behind it, and
-- implying otherwise would put the platform owner on the wrong side of their
-- own tax authority.
CREATE TABLE IF NOT EXISTS "PaymentReceipt" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "invoiceId"      TEXT,
  -- Human-facing identifier for this document. Unique so it can be quoted back
  -- in correspondence, but it carries no fiscal meaning.
  "reference"      TEXT NOT NULL,
  "amountCents"    INTEGER NOT NULL DEFAULT 0,
  "currency"       TEXT NOT NULL DEFAULT 'USD',
  -- How the money arrived: bank_transfer | cash | card | other. Free text
  -- rather than an enum because the platform owner settles however they settle,
  -- and a new method must not need a migration.
  "method"         TEXT NOT NULL DEFAULT 'other',
  -- The payer's own reference: a bank transfer id, a cheque number.
  "externalRef"    TEXT,
  "note"           TEXT,
  "paidAt"         TIMESTAMP(3) NOT NULL,
  -- Identity.id of the platform actor who recorded it. Nullable because an
  -- imported or provider-driven payment has no human behind it.
  "issuedByEmail"  TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaymentReceipt_pkey" PRIMARY KEY ("id")
);

-- Composite unique, as every tenant-scoped table here carries: it is what lets
-- a foreign key prove the parent belongs to the same organization.
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentReceipt_id_organizationId_key"
  ON "PaymentReceipt"("id", "organizationId");

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentReceipt_reference_key"
  ON "PaymentReceipt"("reference");

CREATE INDEX IF NOT EXISTS "PaymentReceipt_organizationId_paidAt_idx"
  ON "PaymentReceipt"("organizationId", "paidAt");

DO $$
BEGIN
  ALTER TABLE "PaymentReceipt"
    ADD CONSTRAINT "PaymentReceipt_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Composite FK: a receipt cannot point at an invoice belonging to a different
-- organization, because the database will not let it.
DO $$
BEGIN
  ALTER TABLE "PaymentReceipt"
    ADD CONSTRAINT "PaymentReceipt_invoiceId_organizationId_fkey"
    FOREIGN KEY ("invoiceId", "organizationId") REFERENCES "Invoice"("id", "organizationId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
