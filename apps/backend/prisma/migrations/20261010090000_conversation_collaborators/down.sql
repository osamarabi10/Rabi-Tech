-- Reverses 20261010090000_conversation_collaborators.
--
-- Dropping this loses who was working alongside each assignee. That is not
-- recoverable from anywhere else: the activity trail records the addition as an
-- event, but the current membership lives only here, so every thread reverts to
-- "one assignee and nobody else" with no way to reconstruct it.
--
--   SELECT count(*) FROM "ConversationCollaborator";
--
-- Remember `_prisma_migrations` afterwards — Prisma Migrate is forward-only:
--
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261010090000_conversation_collaborators';

BEGIN;

DO $$
DECLARE
  live_count bigint;
BEGIN
  SELECT count(*) INTO live_count FROM "ConversationCollaborator";

  IF live_count > 0 THEN
    RAISE EXCEPTION
      'Reversal refused: % collaborator assignment(s) exist and are not '
      'recoverable from anywhere else. Clear them deliberately first if that '
      'is the intent.', live_count;
  END IF;
END $$;

ALTER TABLE "OrganizationConfig" DROP COLUMN IF EXISTS "mentionAddsCollaborator";
DROP TABLE IF EXISTS "ConversationCollaborator";

COMMIT;
