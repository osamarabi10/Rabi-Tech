-- P1d: outbound webhooks.
--
-- Respond.io's own documentation records the gap this closes on their side:
-- their webhooks have no delivery log, and it is an open feature request. A
-- webhook you cannot see is a webhook you cannot debug — "did you send it?" is
-- unanswerable by both parties, and the subscriber's only recourse is to ask us
-- to read a server log. `WebhookDeliveryLog` already exists for the workflow
-- step; this reuses it rather than building a second one.
--
-- The signing secret is stored in clear, unlike an API token. That is not an
-- oversight and not the same problem: HMAC requires the *same* secret at both
-- ends to compute a signature, so a hash would make signing impossible. The
-- mitigation is different in kind — it is shown once on creation, rotatable,
-- and scoped to one endpoint.

BEGIN;

CREATE TABLE "WebhookEndpoint" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "url"            TEXT NOT NULL,
  -- Shared with the receiver so they can verify. Never returned by the list
  -- endpoint after creation.
  "secret"         TEXT NOT NULL,
  -- Empty means this endpoint receives nothing. Deliberately not "everything":
  -- an endpoint subscribed to every event by omission is how a receiver starts
  -- getting message bodies it never asked for.
  "events"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  "isActive"       BOOLEAN NOT NULL DEFAULT true,
  /*
    Auto-deactivation, and the two columns that make it explainable.

    An endpoint that fails persistently is switched off, because retrying a dead
    URL forever costs the sender and floods the receiver when it returns. What
    matters more is that the subscriber can find out WHY without asking us:
    Respond.io emails you and leaves you to find the switch. These two columns
    are what the console renders instead.
  */
  "disabledAt"     TIMESTAMP(3),
  "disabledReason" TEXT,

  "lastDeliveryAt" TIMESTAMP(3),
  "lastSuccessAt"  TIMESTAMP(3),
  "lastFailureAt"  TIMESTAMP(3),

  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEndpoint_id_organizationId_key" ON "WebhookEndpoint"("id", "organizationId");
-- The dispatcher's hot query: every live endpoint for one workspace.
CREATE INDEX "WebhookEndpoint_organizationId_isActive_idx" ON "WebhookEndpoint"("organizationId", "isActive");

ALTER TABLE "WebhookEndpoint"
  ADD CONSTRAINT "WebhookEndpoint_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-bound, like every other user reference in this schema.
ALTER TABLE "WebhookEndpoint"
  ADD CONSTRAINT "WebhookEndpoint_createdById_organizationId_fkey"
  FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which delivery attempt this was. The log already records outcome and latency;
-- without the attempt number a retry is indistinguishable from a fresh event,
-- and "we sent it four times" reads as four separate failures.
ALTER TABLE "WebhookDeliveryLog"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;

COMMIT;
