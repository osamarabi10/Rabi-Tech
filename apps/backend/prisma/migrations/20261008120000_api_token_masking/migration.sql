-- A token must not be able to see what the person who minted it cannot.
--
-- `User.maskPhoneAndEmail` hides contact phone numbers and email addresses from
-- an individual user; the edition flag `maskContactDetails` decides whether an
-- admin may set it at all. Both were enforced only on the console's own routes,
-- which read `req.user`.
--
-- An API token carries no user. So a masked admin — masked, but not restricted
-- from workspace settings, which are different flags — could mint a token with
-- `contacts:read` and read every unmasked phone number in the workspace. The
-- restriction was real everywhere except through the door we just built.
--
-- The token therefore inherits the constraint at issue time. Frozen rather than
-- resolved live from `createdById`, because that column is nullable and the
-- creator can be deleted: a token whose masking depends on a row that may not
-- exist would silently unmask itself the day that user is removed.
--
-- Default false, which is correct for the tokens already issued: they were all
-- created before this column existed, by admins whose masking state is
-- unchanged, and the console shows the flag on every row.

BEGIN;

ALTER TABLE "ApiToken"
  ADD COLUMN "maskContactDetails" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
