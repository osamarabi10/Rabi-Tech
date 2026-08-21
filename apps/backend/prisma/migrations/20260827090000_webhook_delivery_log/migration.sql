-- Webhook delivery logging (M7 item 5).
--
-- Covers BOTH directions, because they are different faults with different
-- causes and the reporting gap needed both:
--
--   OUTBOUND — a workflow `HTTP_WEBHOOK` step calling a subscriber's endpoint.
--   INBOUND  — the gateway delivering a message to `/webhooks/openwa/:token`.
--
-- The gateway runbook's central fact applies here too: inbound-broken and
-- outbound-broken are separate faults. A workflow webhook failing says nothing
-- about whether WhatsApp messages are still arriving, and it is the inbound
-- side that goes silent when the platform stops receiving traffic at all.
--
-- `webhookId` identifies the *configured endpoint*, not a row in some webhook
-- table — there is no such table. A webhook is an action step inside a
-- workflow, so the identity is derived from the workflow and its step index
-- (see `webhookIdentity()`), which is what lets the health view group repeated
-- deliveries by destination. `workflowId` / `executionId` are the real
-- references alongside it.

CREATE TABLE "WebhookDeliveryLog" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,

  -- 'OUTBOUND' | 'INBOUND'. Text rather than an enum so adding a third
  -- transport later is an insert, not a migration on a hot table.
  "direction"      TEXT NOT NULL,

  -- Stable identity of the endpoint this delivery belongs to.
  "webhookId"      TEXT NOT NULL,
  "eventType"      TEXT NOT NULL,

  "workflowId"     TEXT,
  "executionId"    TEXT,

  -- Host only. The full URL can carry credentials in userinfo or a token in the
  -- query string, and a delivery log is exactly the place those would sit in
  -- plaintext forever.
  "targetHost"     TEXT,

  "statusCode"     INTEGER,
  -- Denormalised so the success rate is an indexed count rather than a scan
  -- with arithmetic over `statusCode`. A transport error has no status code at
  -- all, and that is a failure too.
  "ok"             BOOLEAN NOT NULL DEFAULT false,
  "errorMessage"   TEXT,

  -- Truncated in code before they arrive here. An unbounded response body from
  -- a misbehaving endpoint would otherwise be stored verbatim, and these two
  -- columns are the ones that carry customer message content.
  "requestPayload" TEXT,
  "responseBody"   TEXT,

  "durationMs"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WebhookDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- The tenancy invariant: every tenant row carries organizationId and is
-- reachable by a composite key, so a child row can never be attached across
-- organizations.
ALTER TABLE "WebhookDeliveryLog"
  ADD CONSTRAINT "WebhookDeliveryLog_id_organizationId_key" UNIQUE ("id", "organizationId");

ALTER TABLE "WebhookDeliveryLog"
  ADD CONSTRAINT "WebhookDeliveryLog_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FKs, nullable on purpose: an inbound receipt belongs to no
-- workflow. Postgres MATCH SIMPLE skips enforcement when any referencing
-- column is NULL, which is precisely the behaviour wanted here and the same
-- shape `Conversation.teamId` already uses.
ALTER TABLE "WebhookDeliveryLog"
  ADD CONSTRAINT "WebhookDeliveryLog_workflowId_organizationId_fkey"
  FOREIGN KEY ("workflowId", "organizationId") REFERENCES "Workflow"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDeliveryLog"
  ADD CONSTRAINT "WebhookDeliveryLog_executionId_organizationId_fkey"
  FOREIGN KEY ("executionId", "organizationId") REFERENCES "WorkflowExecution"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Recent-first listing, which is every query this table serves.
CREATE INDEX "WebhookDeliveryLog_organizationId_createdAt_idx"
  ON "WebhookDeliveryLog"("organizationId", "createdAt" DESC);

-- Success rate and the failures list, both filtered by direction.
CREATE INDEX "WebhookDeliveryLog_organizationId_direction_ok_createdAt_idx"
  ON "WebhookDeliveryLog"("organizationId", "direction", "ok", "createdAt" DESC);

-- Per-endpoint health.
CREATE INDEX "WebhookDeliveryLog_organizationId_webhookId_createdAt_idx"
  ON "WebhookDeliveryLog"("organizationId", "webhookId", "createdAt" DESC);

-- Retention sweeps delete by age across all tenants, so this one is not
-- organization-scoped. Without it the pruning job would seq-scan the largest
-- table in the schema on every pass.
CREATE INDEX "WebhookDeliveryLog_createdAt_idx"
  ON "WebhookDeliveryLog"("createdAt");
