-- Owner & admin command centre: staff, mail, and credential self-service.
--
-- Three problems, each of which currently requires someone to open a database
-- client against production.

-- ── 1. Platform staff ───────────────────────────────────────────────────────
--
-- `Identity.platformRole` already existed and was only ever set by the seed
-- script, so hiring a support advisor meant an UPDATE against the live
-- database. These columns make an advisor account a record with an owner, a
-- reason and a lifecycle rather than a hand-edited row.
--
-- `platformPermissions` is a list rather than more role names. Support work is
-- not a ladder — one advisor may need to extend trials and never touch billing,
-- another the reverse — and every new shape of that need would otherwise be a
-- new role and a migration.
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "platformPermissions" TEXT[] NOT NULL DEFAULT '{}';
-- Disabling is not deleting: an advisor who leaves must stop being able to sign
-- in while their name stays attached to everything they did.
ALTER TABLE "Identity" ADD COLUMN IF NOT EXISTS "platformDisabledAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Identity_platformRole_idx" ON "Identity"("platformRole");

-- ── 2. The outbox ───────────────────────────────────────────────────────────
--
-- There is no email sender in this product. Not "a basic one" — none. Signup
-- verification hands its link back in the API response and hopes somebody
-- notices.
--
-- A table rather than a direct call, because every message this system sends is
-- sent *because of* something else succeeding: a payment failed, a trial ended,
-- a password was reset. Calling a mail API inline makes the mail provider's
-- availability a condition of that transaction committing, and a provider
-- outage would start rolling back payment state.
--
-- So: the transaction records what should be sent, and a worker sends it. A
-- send that fails is retried; a send that keeps failing is visible instead of
-- lost.
CREATE TABLE IF NOT EXISTS "EmailOutbox" (
  "id"             TEXT NOT NULL,
  -- Nullable: password resets and staff invitations belong to an identity, not
  -- to a workspace, and platform notices belong to neither.
  "organizationId" TEXT,
  "toEmail"        TEXT NOT NULL,
  -- Which message this is. Drives the template and, more importantly, the
  -- deduplication below.
  "kind"           TEXT NOT NULL,
  "subject"        TEXT NOT NULL,
  "body"           TEXT NOT NULL,
  -- PENDING | SENT | FAILED
  "status"         TEXT NOT NULL DEFAULT 'PENDING',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "lastError"      TEXT,
  "sentAt"         TIMESTAMP(3),
  -- Do not send before this. Dunning sends one warning per stage, not one per
  -- pass, and the retry backoff writes here too.
  "sendAfter"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set by the caller to mean "this exact message, once". A dunning warning
  -- carries the invoice and the stage, so a pass that runs twice in a minute
  -- cannot warn the same customer twice.
  "dedupeKey"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- The uniqueness *is* the deduplication. Enforcing it in application code means
-- two workers can both decide the message has not been sent yet.
CREATE UNIQUE INDEX IF NOT EXISTS "EmailOutbox_dedupeKey_key"
  ON "EmailOutbox"("dedupeKey") WHERE "dedupeKey" IS NOT NULL;

-- The worker's query: what is due, oldest first.
CREATE INDEX IF NOT EXISTS "EmailOutbox_status_sendAfter_idx"
  ON "EmailOutbox"("status", "sendAfter");

CREATE INDEX IF NOT EXISTS "EmailOutbox_organizationId_createdAt_idx"
  ON "EmailOutbox"("organizationId", "createdAt");

DO $$
BEGIN
  ALTER TABLE "EmailOutbox"
    ADD CONSTRAINT "EmailOutbox_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 3. Credential self-service ──────────────────────────────────────────────
--
-- Only the hash is stored, for the same reason a password is only stored
-- hashed: a readable table of live reset tokens is a readable table of live
-- account takeovers.
CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"         TEXT NOT NULL,
  "identityId" TEXT NOT NULL,
  "tokenHash"  TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  -- Single use. Recorded rather than deleted so a second attempt can be told
  -- apart from a token that never existed.
  "consumedAt" TIMESTAMP(3),
  -- Kept for the security notice: "your password was changed from this
  -- address". Useless for prevention, decisive for detection.
  "requestedIp" TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key"
  ON "PasswordResetToken"("tokenHash");

CREATE INDEX IF NOT EXISTS "PasswordResetToken_identityId_createdAt_idx"
  ON "PasswordResetToken"("identityId", "createdAt");

DO $$
BEGIN
  ALTER TABLE "PasswordResetToken"
    ADD CONSTRAINT "PasswordResetToken_identityId_fkey"
    FOREIGN KEY ("identityId") REFERENCES "Identity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
