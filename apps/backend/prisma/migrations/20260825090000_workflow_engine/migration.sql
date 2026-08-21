-- P11: automation workflow engine.

CREATE TABLE IF NOT EXISTS "Workflow" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "isActive"       BOOLEAN NOT NULL DEFAULT false,
  -- CONVERSATION_CREATED | KEYWORD_MATCHED | TAG_ADDED | TAG_REMOVED | OUT_OF_HOURS
  "triggerType"    TEXT NOT NULL,
  -- { trigger: {...}, conditions: [...], actions: [...] } — validated in code
  -- against the same vocabulary the builder renders, so a stored graph cannot
  -- reference an action the executor does not implement.
  "configJson"     JSONB NOT NULL,
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Workflow_id_organizationId_key"
  ON "Workflow" ("id", "organizationId");
-- The dispatcher asks "which active workflows listen for this trigger" on every
-- inbound message; without this that is a scan of every workflow in the table.
CREATE INDEX IF NOT EXISTS "Workflow_org_trigger_active_idx"
  ON "Workflow" ("organizationId", "triggerType", "isActive");
-- Names are unique per tenant while live, and freed by delete. Partial and
-- case-insensitive for the same reasons as Segment.
CREATE UNIQUE INDEX IF NOT EXISTS "Workflow_organizationId_name_unique"
  ON "Workflow" ("organizationId", LOWER("name"));

ALTER TABLE "Workflow"
  ADD CONSTRAINT "Workflow_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "WorkflowExecution" (
  "id"               TEXT NOT NULL,
  "organizationId"   TEXT NOT NULL,
  "workflowId"       TEXT NOT NULL,
  "contactId"        TEXT,
  "conversationId"   TEXT,
  -- RUNNING | WAITING | COMPLETED | FAILED | SKIPPED
  "status"           TEXT NOT NULL DEFAULT 'RUNNING',
  "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
  -- Capped in code. An unbounded per-step log on a busy workflow is how a JSONB
  -- column becomes the largest thing in the database.
  "executionLog"     JSONB,
  "error"            TEXT,
  -- Guards against a workflow whose action re-fires its own trigger
  -- (ADD_TAG action feeding a TAG_ADDED trigger is the obvious one).
  "depth"            INTEGER NOT NULL DEFAULT 0,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkflowExecution_id_organizationId_key"
  ON "WorkflowExecution" ("id", "organizationId");
CREATE INDEX IF NOT EXISTS "WorkflowExecution_org_workflow_createdAt_idx"
  ON "WorkflowExecution" ("organizationId", "workflowId", "createdAt");
-- The loop guard looks up recent executions for one workflow + contact.
CREATE INDEX IF NOT EXISTS "WorkflowExecution_org_workflow_contact_idx"
  ON "WorkflowExecution" ("organizationId", "workflowId", "contactId", "createdAt");
CREATE INDEX IF NOT EXISTS "WorkflowExecution_createdAt_idx"
  ON "WorkflowExecution" ("createdAt");

ALTER TABLE "WorkflowExecution"
  ADD CONSTRAINT "WorkflowExecution_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FKs: the join key carries organizationId on both sides, so an
-- execution can never reference another tenant's workflow, contact or thread.
ALTER TABLE "WorkflowExecution"
  ADD CONSTRAINT "WorkflowExecution_workflowId_organizationId_fkey"
  FOREIGN KEY ("workflowId", "organizationId") REFERENCES "Workflow"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowExecution"
  ADD CONSTRAINT "WorkflowExecution_contactId_organizationId_fkey"
  FOREIGN KEY ("contactId", "organizationId") REFERENCES "Contact"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkflowExecution"
  ADD CONSTRAINT "WorkflowExecution_conversationId_organizationId_fkey"
  FOREIGN KEY ("conversationId", "organizationId") REFERENCES "Conversation"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
