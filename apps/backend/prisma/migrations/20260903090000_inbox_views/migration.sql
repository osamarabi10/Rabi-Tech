-- M6.3 — saved views ("custom inboxes").
--
-- A named conversation filter that an agent keeps in column 1 of the inbox.
-- Private by default; a supervisor can share one with the workspace.
--
-- `ownerId` nullable *is* the sharing model, rather than a `shared` boolean
-- beside an owner. Two columns can express "shared, but owned by Layla", which
-- is a state nothing in the product means and every reader has to decide how to
-- interpret. One column cannot, and the foreign key does the cleanup for free:
-- deleting a user takes their private views with them and leaves the shared
-- ones standing, which is exactly the desired behaviour and would otherwise be
-- application code nobody remembers to write.
CREATE TABLE IF NOT EXISTS "InboxView" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  -- Null = shared with the whole workspace. Set = private to that user.
  "ownerId"        TEXT,
  "name"           TEXT NOT NULL,
  -- An InboxViewFilter. User input: validated on write and never trusted on
  -- read. A malformed filter that reaches the client breaks the inbox for
  -- everyone who can see the view, and for a shared view that is the workspace.
  "filter"         JSONB NOT NULL,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InboxView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InboxView_id_organizationId_key"
  ON "InboxView"("id", "organizationId");

-- The list query: this viewer's private views plus every shared one, in the
-- order they are displayed.
CREATE INDEX IF NOT EXISTS "InboxView_organizationId_ownerId_sortOrder_idx"
  ON "InboxView"("organizationId", "ownerId", "sortOrder");

DO $$
BEGIN
  ALTER TABLE "InboxView"
    ADD CONSTRAINT "InboxView_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Composite, not a plain reference to "User"("id"). The pair has to match a
-- single row, so the database itself refuses a view owned by a user in another
-- organization — the isolation guarantee stops depending on every query
-- remembering to filter.
DO $$
BEGIN
  ALTER TABLE "InboxView"
    ADD CONSTRAINT "InboxView_ownerId_organizationId_fkey"
    FOREIGN KEY ("ownerId", "organizationId") REFERENCES "User"("id", "organizationId")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
