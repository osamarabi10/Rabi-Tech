-- Consent history.
--
-- Contact already carried `marketingConsent`, `consentSource` and
-- `consentUpdatedAt` — the current value, how it last changed, and when. What it
-- could never answer is *who*, and it kept no history at all: the previous value
-- was overwritten by the next one.
--
-- That gap is why the contact panel showed a consent control with no provenance
-- beside it. "This customer opted out" is a claim a business may have to stand
-- behind, and standing behind it means being able to say where it came from.
CREATE TABLE IF NOT EXISTS "ConsentEvent" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "contactId"      TEXT NOT NULL,
  -- Null on the first recorded change: earlier history predates this table.
  "fromValue"      TEXT,
  "toValue"        TEXT NOT NULL,
  -- keyword | agent | import | api
  "source"         TEXT NOT NULL,
  -- The agent who made the change, when a person made it. Null for a keyword
  -- the customer sent, and for an import. Denormalised name so the record stays
  -- readable after the user is deleted — an audit trail that becomes a dangling
  -- id is not an audit trail.
  "actorUserId"    TEXT,
  "actorName"      TEXT,
  "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConsentEvent_id_organizationId_key"
  ON "ConsentEvent"("id", "organizationId");

CREATE INDEX IF NOT EXISTS "ConsentEvent_organizationId_contactId_at_idx"
  ON "ConsentEvent"("organizationId", "contactId", "at");

DO $$
BEGIN
  ALTER TABLE "ConsentEvent"
    ADD CONSTRAINT "ConsentEvent_contactId_organizationId_fkey"
    FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
