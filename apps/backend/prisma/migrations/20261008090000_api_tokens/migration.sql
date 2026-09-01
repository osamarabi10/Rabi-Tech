-- P1a: bearer tokens for the public API.
--
-- Scoped and expiring from the first row, deliberately. Respond.io's own
-- developer documentation records the alternative as a gap: "No expiry,
-- rotation, revocation procedure or scoping mechanism is documented anywhere…
-- the token is workspace-wide." A workspace-wide eternal token is one
-- credential that reads every conversation a subscriber has ever had, and
-- retrofitting auth is the most expensive change in software.
--
-- The secret is never stored. `tokenHash` is SHA-256 of the secret half — not
-- bcrypt, because this is a high-entropy random value rather than a human
-- password, so a slow KDF buys nothing against brute force and costs a hash on
-- every API request. `prefix` is the public half, stored in clear so a token
-- can be identified in a list and found in one indexed lookup without hashing
-- every row.

BEGIN;

CREATE TABLE "ApiToken" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "prefix"         TEXT NOT NULL,
  "tokenHash"      TEXT NOT NULL,
  -- Empty is "nothing", never "everything". A scope list that defaults open is
  -- how a restricted credential silently becomes an unrestricted one.
  "scopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt"      TIMESTAMP(3),
  "revokedAt"      TIMESTAMP(3),
  "lastUsedAt"     TIMESTAMP(3),
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- Platform-wide unique: an inbound request carries a token and nothing else, so
-- the lookup has no tenant hint to narrow by.
CREATE UNIQUE INDEX "ApiToken_prefix_key" ON "ApiToken"("prefix");
CREATE UNIQUE INDEX "ApiToken_id_organizationId_key" ON "ApiToken"("id", "organizationId");
CREATE INDEX "ApiToken_organizationId_revokedAt_idx" ON "ApiToken"("organizationId", "revokedAt");

ALTER TABLE "ApiToken"
  ADD CONSTRAINT "ApiToken_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-bound, like every other user reference in this schema: the pair has to
-- match one User, so a token attributed to another organization's user is
-- refused by the database rather than trusted from whichever route wrote it.
ALTER TABLE "ApiToken"
  ADD CONSTRAINT "ApiToken_createdById_organizationId_fkey"
  FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
