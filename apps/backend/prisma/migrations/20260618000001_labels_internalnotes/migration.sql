-- Add labels array to Conversation
ALTER TABLE "Conversation" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT '{}';

-- Add isInternal flag to Message
ALTER TABLE "Message" ADD COLUMN "isInternal" BOOLEAN NOT NULL DEFAULT false;
