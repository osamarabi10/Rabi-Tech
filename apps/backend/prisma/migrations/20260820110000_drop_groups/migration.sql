-- Remove WhatsApp Groups.
--
-- RabiTech is a 1:1 customer conversation platform. Group browsing/sending existed in three
-- duplicated surfaces (a standalone page, an inbox mode, and a settings card) and has no
-- equivalent in the product we are converging on. Inbound group messages are now ignored
-- at the webhook rather than stored.

DROP TABLE IF EXISTS "GroupMessage";

ALTER TABLE "OrganizationConfig" DROP COLUMN IF EXISTS "itAlertGroupId";
