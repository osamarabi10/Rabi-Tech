-- M8.1: granular restrictions that narrow one user below their role.
--
-- A role says what a *kind* of person may do. These narrow an individual — "this
-- supervisor may not export contacts" — without inventing a sixth role for every
-- combination somebody asks for, which is how a permission model becomes
-- unreadable.
--
-- Three columns, not four. `restrictIntegrationSettings` was specified in M8.1
-- and is deliberately NOT here: channel, gateway and webhook routes guard with
-- `requireAdmin` directly rather than through `requirePermission`, so a
-- restriction keyed on an operation name would match nothing. Shipping the
-- column and a checkbox that silently gated nothing would have been the same
-- defect this codebase has now found four times. See the note in
-- rbac.middleware.ts and the item in TODO.md.
--
-- Default false everywhere: an existing user's access is unchanged by this
-- migration. A restriction is something an admin applies, never something a
-- deploy applies on their behalf.

BEGIN;

ALTER TABLE "User"
  ADD COLUMN "restrictDataExport"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "restrictContactDeletion"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "restrictWorkspaceSettings" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
