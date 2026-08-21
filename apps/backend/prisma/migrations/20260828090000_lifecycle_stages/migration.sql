-- Configurable lifecycle stages (M6).
--
-- `Contact.lifecycleStage` has been free text since it was introduced: anything
-- up to 40 characters, with no vocabulary behind it. That made a stage selector
-- impossible to build honestly — a dropdown has to offer *something*, and
-- hardcoding "Lead / Customer / …" in the frontend would put product vocabulary
-- somewhere a subscriber can never change it.
--
-- So the vocabulary becomes data, per organization, on the same shape `Tag`
-- already uses. `Contact.lifecycleStage` deliberately stays a string rather than
-- becoming a foreign key:
--
--   * existing values were typed by hand and by CSV import, and some will match
--     no stage — a FK would have to either drop them or block the migration;
--   * the contact filter DSL already treats `lifecycleStage` as a text field,
--     and stored campaign audience filters reference it that way. Changing the
--     column type would silently invalidate every saved filter that uses it.
--
-- The stage list therefore drives the *selector*, and a contact carrying a value
-- outside it still shows that value rather than appearing blank.

CREATE TABLE "LifecycleStage" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "color"          TEXT,
  -- Explicit order, because a lifecycle is a sequence and alphabetical would
  -- put "Customer" before "Lead".
  "orderIndex"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LifecycleStage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LifecycleStage"
  ADD CONSTRAINT "LifecycleStage_id_organizationId_key" UNIQUE ("id", "organizationId");

-- One stage per name per tenant. Case-sensitive, matching how `Tag` behaves.
ALTER TABLE "LifecycleStage"
  ADD CONSTRAINT "LifecycleStage_organizationId_name_key" UNIQUE ("organizationId", "name");

ALTER TABLE "LifecycleStage"
  ADD CONSTRAINT "LifecycleStage_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "LifecycleStage_organizationId_orderIndex_idx"
  ON "LifecycleStage"("organizationId", "orderIndex");

-- Seed the default pipeline for every existing organization.
--
-- `gen_random_uuid()` rather than a cuid because this runs in SQL; the column is
-- a plain string id and nothing parses its shape. New organizations are seeded
-- in application code — see `seedLifecycleStages()`.
--
-- ON CONFLICT DO NOTHING so re-running against a tenant that already has a
-- stage of that name is a no-op rather than a failed migration.
INSERT INTO "LifecycleStage" ("id", "organizationId", "name", "color", "orderIndex")
SELECT
  gen_random_uuid()::text,
  o."id",
  stage."name",
  stage."color",
  stage."orderIndex"
FROM "Organization" o
CROSS JOIN (
  VALUES
    ('Lead',        '#64748B', 0),
    ('Contacted',   '#0066FF', 1),
    ('Qualified',   '#8B5CF6', 2),
    ('Customer',    '#10B981', 3),
    ('Unqualified', '#EF4444', 4)
) AS stage("name", "color", "orderIndex")
ON CONFLICT ("organizationId", "name") DO NOTHING;
