-- Collaborators: people working a conversation who are not its assignee.
--
-- The matrix calls this the largest inbox gap, and the reason is that a thread
-- has exactly one assignee and real work rarely does. A billing question that
-- needs the technical lead, a complaint that needs a manager reading along —
-- today both are handled by reassigning (which loses the original owner) or by
-- @mentioning and hoping (which notifies once and leaves no state).
--
-- ## Their removal rule, copied whole
--
--   "Any collaborator or the assignee can remove a collaborator — there's no
--    restriction on who can remove whom."
--
-- A permission model here is friction with no benefit. The people on a thread
-- are the people who can see who else is on it, and nobody outside it cares.

BEGIN;

CREATE TABLE "ConversationCollaborator" (
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  -- Who added them, for the activity trail. Nullable because a workflow or an
  -- @mention can add somebody, and neither is a user.
  "addedById"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The pair is the identity: one person is on a thread once. A surrogate id
  -- would allow the same person twice and make the count meaningless.
  CONSTRAINT "ConversationCollaborator_pkey"
    PRIMARY KEY ("organizationId", "conversationId", "userId")
);

-- The Collaborations inbox asks "which threads am I on", so the user leads.
CREATE INDEX "ConversationCollaborator_organizationId_userId_idx"
  ON "ConversationCollaborator"("organizationId", "userId");

ALTER TABLE "ConversationCollaborator"
  ADD CONSTRAINT "ConversationCollaborator_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Tenant-bound composites, like every other reference in this schema: a
-- collaborator from another workspace is refused by the database rather than
-- trusted from whichever route wrote it.
ALTER TABLE "ConversationCollaborator"
  ADD CONSTRAINT "ConversationCollaborator_conversation_fkey"
  FOREIGN KEY ("conversationId", "organizationId")
  REFERENCES "Conversation"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationCollaborator"
  ADD CONSTRAINT "ConversationCollaborator_user_fkey"
  FOREIGN KEY ("userId", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversationCollaborator"
  ADD CONSTRAINT "ConversationCollaborator_addedBy_fkey"
  FOREIGN KEY ("addedById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Whether an @mention also adds the mentioned person as a collaborator.
--
-- A workspace setting because it is genuinely a preference: on a small team
-- mentioning somebody means "come help", and on a large one it means "for your
-- information". Defaulting to false is the conservative reading — a mention
-- that silently adds people to a thread's permissions surprises the person who
-- wrote it.
ALTER TABLE "OrganizationConfig"
  ADD COLUMN "mentionAddsCollaborator" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
