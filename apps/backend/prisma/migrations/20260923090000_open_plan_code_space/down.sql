-- Reverse of migration.sql. Applied by hand; see the procedure in
-- docs/RESPONDIO-PARITY-CHECKPOINT.md.
--
-- ┌──────────────────────────────────────────────────────────────────────┐
-- │ USELESS once any plan code outside the original five exists.         │
-- └──────────────────────────────────────────────────────────────────────┘
--
-- Run this ONLY while every Organization.planOverride is null or one of the
-- five codes below. Check first — it is one query, and it is the difference
-- between a clean rollback and a half-reverted system:
--
--   SELECT DISTINCT "planOverride" FROM "Organization"
--   WHERE "planOverride" IS NOT NULL
--     AND "planOverride" <> ALL (ARRAY['FREE','STANDARD','GROWTH','BUSINESS','ENTERPRISE']);
--
-- Any row returned means STOP. Recovery from that point is snapshot-restore or
-- forward-fix, never this file.
--
-- Note also what this does NOT reverse: Plan rows carrying new codes. Nothing
-- constrains Plan.code, so they survive, and the restored code rejects them —
-- they remain in the catalogue, resolve to nothing, and every subscriber on
-- one is entitled to nothing. Reversing the SQL is the easy half.

ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planOverride_check"
  CHECK (
    "planOverride" IS NULL
    OR "planOverride" = ANY (ARRAY['FREE', 'STANDARD', 'GROWTH', 'BUSINESS', 'ENTERPRISE'])
  );
