-- H1: gateway health probe results.
--
-- Append-only and short-lived. This answers "is the gateway up right now", not
-- "what happened last quarter", and the failure rule ("2 of the last 3 attempts
-- failed") needs a few rows of history rather than a counter.

CREATE TABLE IF NOT EXISTS "GatewayHealthCheck" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  -- 'status' (free HTTP poll) | 'selfSend' (real WhatsApp message to our own number)
  "probe"          TEXT NOT NULL,
  "ok"             BOOLEAN NOT NULL,
  "error"          TEXT,
  "latencyMs"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GatewayHealthCheck_pkey" PRIMARY KEY ("id")
);

-- Composite unique, per the project rule that every tenant table can be joined
-- tenant-locally.
CREATE UNIQUE INDEX IF NOT EXISTS "GatewayHealthCheck_id_organizationId_key"
  ON "GatewayHealthCheck" ("id", "organizationId");

-- The failure window reads the last N rows for one org and one probe.
CREATE INDEX IF NOT EXISTS "GatewayHealthCheck_org_probe_createdAt_idx"
  ON "GatewayHealthCheck" ("organizationId", "probe", "createdAt");

-- The retention sweep deletes by age across all orgs.
CREATE INDEX IF NOT EXISTS "GatewayHealthCheck_createdAt_idx"
  ON "GatewayHealthCheck" ("createdAt");

ALTER TABLE "GatewayHealthCheck"
  ADD CONSTRAINT "GatewayHealthCheck_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
