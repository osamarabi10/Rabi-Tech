-- Add token versioning for logout-all functionality
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- Backfill: set initial version to 0 for all existing users
UPDATE "User" SET "tokenVersion" = 0 WHERE "tokenVersion" IS NULL;
