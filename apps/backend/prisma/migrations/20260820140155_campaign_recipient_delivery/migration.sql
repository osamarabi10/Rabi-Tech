-- Campaign delivery tracking. Acks from the gateway arrive keyed by the WhatsApp
-- message id, so a recipient must remember the id of its own send. Without this,
-- a campaign report can never progress past "sent".
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "waMessageId" TEXT;
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "CampaignRecipient" ADD COLUMN IF NOT EXISTS "readAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "CampaignRecipient_organizationId_waMessageId_idx"
  ON "CampaignRecipient" ("organizationId", "waMessageId");
