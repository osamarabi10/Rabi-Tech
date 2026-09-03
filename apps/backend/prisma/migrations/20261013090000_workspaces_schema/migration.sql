-- Workspaces, commit 1 of 2: schema and backfill only.
--
-- Nothing under src/ changes in this commit and nothing reads or writes
-- workspaceId. That is deliberate, and it is what makes this safe to deploy on
-- its own: the running application is unaware of every object created here.
--
-- ## The shape
--
-- Organization remains the tenancy boundary. workspaceId is a THIRD key column
-- beside it, never a replacement — every composite foreign key added below
-- carries organizationId as well, so a workspace can only ever address rows in
-- the organization that owns it. A workspace is a division inside a tenant; it
-- is not a tenant.
--
-- ## Why workspaceId is nullable here
--
-- NOT NULL, the widened unique constraints and the code that reads the column
-- are one change and they arrive together in commit 2. Making the column
-- mandatory now would oblige every INSERT in the application to supply it, and
-- the application in this commit does not know the column exists. A schema the
-- running code cannot write to is an outage, not a migration.
--
-- ## Why the composite foreign key can land now anyway (step 7)
--
-- A multi-column foreign key in PostgreSQL defaults to MATCH SIMPLE, which
-- skips the check entirely when ANY of its columns is NULL. So the constraint
-- is real from the moment it is created — it enforces on every row that has a
-- workspace — and it is inert for a row written by the unchanged application,
-- which leaves workspaceId NULL. The alternative was to defer the constraint to
-- commit 2 and spend the interval with a column nothing guarantees. This gets
-- the guarantee early at no cost to the running system.
--
-- ## Cost
--
-- Steps 1-5 are metadata-only. ADD COLUMN with no default and no NOT NULL does
-- not rewrite a table on any supported PostgreSQL. Step 6 is a full UPDATE of
-- four tables and is the only part whose duration scales with data. Step 7
-- scans each of those tables once to validate the new constraint.
--
-- ## Deliberately NOT here
--
-- No (organizationId, workspaceId) indexes. There is no query that filters on
-- workspace until commit 2, and an index with no query is the same defect as a
-- table with no reader: something that looks maintained, costs write throughput
-- on every insert, and is justified by nothing. They land in commit 2, beside
-- the queries that need them.

-- Step 1: the workspace table.
--
-- The id is 'ws_' || organization.id — see the schema comment on model
-- Workspace for why the coupling is deliberate and the condition under which it
-- must be undone. In short: it makes step 6 idempotent and lets down.sql
-- recognise exactly what it created.
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- Step 2: membership.
--
-- role is NOT NULL with no default, on purpose. A default would let this table
-- be populated by something other than the copy in step 6, and the copy is the
-- only thing that makes "no behaviour change" a fact rather than a claim.
CREATE TABLE "WorkspaceMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- Step 3: constraints on the new tables.
--
-- The (id, organizationId) uniques are what let anything reference these tables
-- compositely. They are the same pattern every tenant-scoped table here uses
-- and they are the reason a stolen id from another tenant does not resolve.
CREATE INDEX "Workspace_organizationId_idx" ON "Workspace"("organizationId");
CREATE UNIQUE INDEX "Workspace_id_organizationId_key" ON "Workspace"("id", "organizationId");
CREATE UNIQUE INDEX "Workspace_organizationId_name_key" ON "Workspace"("organizationId", "name");

-- Exactly one default workspace per organization.
--
-- Partial, so Prisma cannot express it and it is written by hand; it will not
-- appear in `prisma migrate diff` output afterwards. The predicate is the
-- point: it constrains only the rows where isDefault is true and says nothing
-- about how many ordinary workspaces an organization may have, which from
-- commit 2 onward is many.
--
-- This exists because commit 2 depends on the invariant and nothing else
-- enforces it. Step 6 creates one default per organization and, having run
-- once, is not a guarantee about anything created afterwards — it is a fact
-- about the past. An invariant a later commit relies on, held up by nothing but
-- the absence of code that would break it, holds until somebody writes that
-- code, and then fails somewhere that does not look like the cause.
--
-- Note that it is created BEFORE the backfill, so it constrains step 6 rather
-- than being checked against a result step 6 already produced. If the backfill
-- were ever changed to insert two defaults, this refuses at the point of the
-- mistake instead of leaving the mistake to be discovered by whatever assumed
-- there was one.
CREATE UNIQUE INDEX "Workspace_organizationId_default_partial_key"
  ON "Workspace"("organizationId")
  WHERE "isDefault";

CREATE INDEX "WorkspaceMember_organizationId_idx" ON "WorkspaceMember"("organizationId");
CREATE UNIQUE INDEX "WorkspaceMember_id_organizationId_key" ON "WorkspaceMember"("id", "organizationId");
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- Step 4: the new tables point at the tenant and at each other.
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_organizationId_fkey"
  FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_organizationId_fkey"
  FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Step 5: the column, on the four tables that will be workspace-scoped.
--
-- Channels are scoped at WhatsappSession because a gateway is shared across an
-- organization while a channel belongs to one workspace. Nullable, no default:
-- metadata-only on every supported server, so this is instant regardless of
-- table size.
ALTER TABLE "WhatsappSession" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "Message" ADD COLUMN "workspaceId" TEXT;

-- Step 6: the backfill. One workspace per organization, every user a member of
-- it, every existing row moved into it.
--
-- Every id here is derived, never generated, so this block is idempotent: run
-- it twice and the second run changes nothing. That matters because a partly
-- applied migration that cannot be re-run is the worst state to be in at 3am.
--
-- ON CONFLICT DO NOTHING rather than an existence check, because the unique
-- constraint is the authority on whether the row is already there and a
-- separate SELECT would be a race with itself.
INSERT INTO "Workspace" ("id", "organizationId", "name", "isDefault", "createdAt", "updatedAt")
SELECT 'ws_' || o."id", o."id", o."name", true, NOW(), NOW()
FROM "Organization" o
ON CONFLICT ("id") DO NOTHING;

-- role is copied from User.role. Not defaulted, not assumed: the new table has
-- to say exactly what the old one said, or the first thing this migration does
-- is silently re-permission everybody.
INSERT INTO "WorkspaceMember" ("id", "organizationId", "workspaceId", "userId", "role", "createdAt", "updatedAt")
SELECT 'wsm_' || u."id", u."organizationId", 'ws_' || u."organizationId", u."id", u."role", NOW(), NOW()
FROM "User" u
ON CONFLICT ("workspaceId", "userId") DO NOTHING;

-- The four content updates. WHERE "workspaceId" IS NULL keeps them idempotent
-- and means a re-run touches no rows rather than rewriting every one of them.
UPDATE "WhatsappSession" SET "workspaceId" = 'ws_' || "organizationId" WHERE "workspaceId" IS NULL;
UPDATE "Contact" SET "workspaceId" = 'ws_' || "organizationId" WHERE "workspaceId" IS NULL;
UPDATE "Conversation" SET "workspaceId" = 'ws_' || "organizationId" WHERE "workspaceId" IS NULL;
UPDATE "Message" SET "workspaceId" = 'ws_' || "organizationId" WHERE "workspaceId" IS NULL;

-- Step 7: the composite foreign keys.
--
-- MATCH SIMPLE is the default and is the point: NULL in workspaceId skips the
-- check, so a row written by the unchanged application is accepted, while any
-- row that names a workspace must name one belonging to its own organization.
-- The constraint is enforcing from this line onward and costs the application
-- nothing until commit 2 starts writing the column.
--
-- ON DELETE NO ACTION rather than RESTRICT: see the schema comment on
-- Contact.workspace. RESTRICT is checked before the same statement's cascade
-- has removed the dependent rows, so deleting an organization would fail on an
-- ordering PostgreSQL does not promise.
ALTER TABLE "WhatsappSession" ADD CONSTRAINT "WhatsappSession_workspaceId_organizationId_fkey"
  FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_organizationId_fkey"
  FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_organizationId_fkey"
  FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "Message" ADD CONSTRAINT "Message_workspaceId_organizationId_fkey"
  FOREIGN KEY ("workspaceId", "organizationId") REFERENCES "Workspace"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;
