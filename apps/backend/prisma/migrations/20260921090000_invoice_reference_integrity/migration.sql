-- Invoice reference integrity.
--
-- The reference becomes the identity of an invoice: required, and unique on
-- its own rather than only unique per provider. Numbering moves off
-- count(rows) + 1 and onto the existing OrgSequence high-water mark, so a
-- removed or voided document can no longer hand its number to the next one.
--
-- Safe on a non-empty database. The backfill below seeds the counter from the
-- highest reference already issued, so the first invoice written after this
-- migration continues the sequence instead of restarting it. On this database
-- both tables are empty and the backfill is a no-op, but a migration that is
-- only correct against an empty table is a trap for the next environment.

-- ── 1. Seed the high-water marks before anything depends on them ──────────
--
-- Reads the numeric tail of existing references (INV-YYYY-XXXX-NNNN → NNNN).
-- GREATEST against any existing row means re-running this cannot walk a
-- counter backwards, which is the one direction it must never move.

INSERT INTO "OrgSequence" ("organizationId", "kind", "value")
SELECT
    "organizationId",
    'invoiceRef',
    COALESCE(MAX(NULLIF(regexp_replace("invoiceRef", '^.*-', ''), '')::bigint), 0)
FROM "Invoice"
WHERE "invoiceRef" IS NOT NULL
GROUP BY "organizationId"
ON CONFLICT ("organizationId", "kind")
DO UPDATE SET "value" = GREATEST("OrgSequence"."value", EXCLUDED."value");

INSERT INTO "OrgSequence" ("organizationId", "kind", "value")
SELECT
    "organizationId",
    'receiptRef',
    COALESCE(MAX(NULLIF(regexp_replace("reference", '^.*-', ''), '')::bigint), 0)
FROM "PaymentReceipt"
GROUP BY "organizationId"
ON CONFLICT ("organizationId", "kind")
DO UPDATE SET "value" = GREATEST("OrgSequence"."value", EXCLUDED."value");

-- ── 2. The reference is now required ──────────────────────────────────────
--
-- Fails loudly if any row still has a NULL reference. That is the correct
-- outcome: a nameless invoice cannot be given a number retroactively without
-- deciding where it sits in the sequence, and that is a judgement call, not a
-- migration step.

ALTER TABLE "Invoice" ALTER COLUMN "invoiceRef" SET NOT NULL;

-- ── 3. Unique on the reference alone ──────────────────────────────────────
--
-- The old pair allowed one reference to exist twice under two providers,
-- which is precisely the collision a reference exists to rule out.

DROP INDEX "Invoice_provider_invoiceRef_key";

CREATE UNIQUE INDEX "Invoice_invoiceRef_key" ON "Invoice" ("invoiceRef");
