-- The seventh restriction: integration settings.
--
-- Respond.io has seven per-user restrictions; we had six. This one was
-- deliberately WITHHELD rather than shipped broken, and the note in
-- rbac.middleware.ts recorded why:
--
--   "There is no `channel:`, `webhook:` or `integration:` operation in the
--    table above. Those routes guard with requireAdmin directly rather than
--    through requirePermission, so a restriction keyed on an operation name
--    would match nothing and gate nothing — declared and unenforced, which is
--    the exact shape this codebase has now hit four times."
--
-- Shipping the column and the checkbox without a route that consults them would
-- have been the fifth. So it waited for routes that could enforce it, and P1
-- built them: API tokens and webhooks are guarded through requirePermission,
-- and the channel routes move onto a named operation in the same change.

BEGIN;

ALTER TABLE "User"
  ADD COLUMN "restrictIntegrations" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
