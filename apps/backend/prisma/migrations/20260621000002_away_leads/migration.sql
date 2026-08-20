-- Agent away mode
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isAway" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "awayAt" TIMESTAMP(3);

-- Lead pipeline enum
DO $$ BEGIN
  CREATE TYPE "LeadStage" AS ENUM ('INTERESTED','OFFER_SENT','WAITING','SUBSCRIBED','LOST');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lead table
CREATE TABLE IF NOT EXISTS "Lead" (
  "id"           TEXT NOT NULL,
  "contactId"    TEXT NOT NULL,
  "stage"        "LeadStage" NOT NULL DEFAULT 'INTERESTED',
  "source"       TEXT,
  "notes"        TEXT,
  "assignedToId" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Lead_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Lead_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "Lead_stage_idx" ON "Lead"("stage");
CREATE INDEX IF NOT EXISTS "Lead_assignedToId_idx" ON "Lead"("assignedToId");
