-- Add AWAITING_CLIENT to ConversationStatus enum
ALTER TYPE "ConversationStatus" ADD VALUE IF NOT EXISTS 'AWAITING_CLIENT';

-- Add pendingMenuChoice to Conversation (tracks routing confirmation state)
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "pendingMenuChoice" TEXT;
