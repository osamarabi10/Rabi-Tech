-- Keep clean migration installs aligned with Message.autoType in schema.prisma.
-- IF NOT EXISTS preserves databases where this column was added manually.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "autoType" TEXT;
