-- Workspaces, commit 2b: the plan column that gates creating one.
--
-- maxWorkspaces sits on Plan beside usersLimit and is read through
-- resolveEntitlements, so a platform-owner plan override moves it for free:
-- overriding an organization to BUSINESS grants BUSINESS's workspaces for the
-- same reason it already grants BUSINESS's seats.
--
-- Nullable with no default, so this is metadata-only and instant. Null means
-- unlimited, matching every other limit column on this table.
ALTER TABLE "Plan" ADD COLUMN "maxWorkspaces" INTEGER;

-- Seed the shipped editions. 1 is not "off": every organization has a default
-- workspace and always did, so 1 is the ceiling that makes a SECOND one the
-- paid capability. BUSINESS gets five, ENTERPRISE is left null for unlimited.
--
-- WHERE "maxWorkspaces" IS NULL keeps this idempotent and, more importantly,
-- stops it overwriting a value a platform owner has already set by hand on a
-- re-run.
UPDATE "Plan" SET "maxWorkspaces" = 1
  WHERE "code" IN ('FREE', 'STANDARD', 'GROWTH') AND "maxWorkspaces" IS NULL;
UPDATE "Plan" SET "maxWorkspaces" = 5
  WHERE "code" = 'BUSINESS' AND "maxWorkspaces" IS NULL;
