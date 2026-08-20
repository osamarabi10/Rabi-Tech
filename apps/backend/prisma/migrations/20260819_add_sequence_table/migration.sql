-- Add global sequence table for atomic ticket label generation
CREATE TABLE "Sequence" (
  "name" TEXT NOT NULL PRIMARY KEY,
  "value" BIGINT NOT NULL DEFAULT 0
);

-- Initialize tickets sequence at 0
INSERT INTO "Sequence" ("name", "value") VALUES ('ticketLabel', 0);
INSERT INTO "Sequence" ("name", "value") VALUES ('conversationDisplayId', 0);
