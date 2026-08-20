-- Remove the ISP domain.
--
-- RabiTech began as one ISP's helpdesk. These tables encode that vertical and have no
-- place in a general customer-conversation platform:
--   Zone   - 5 seeded town names, drove contact/campaign targeting
--   Alert  - network outage notices
--   Lead   - superseded by contact lifecycle stage
--   Ticket / TicketNote - Respond.io has no ticket object; a conversation carries its own
--            status, assignee, tags and closing category. Both tables were empty.
--   Department - replaced by org-configurable Teams
--
-- Verified empty before dropping: Alert, Lead, Ticket, TicketNote = 0 rows.
-- Zone held only its 5 seed rows.

ALTER TABLE "Contact"  DROP COLUMN IF EXISTS "zoneId";
ALTER TABLE "Campaign" DROP COLUMN IF EXISTS "zoneId";

ALTER TABLE "MessageTemplate" DROP COLUMN IF EXISTS "dept";
ALTER TABLE "Conversation"    DROP COLUMN IF EXISTS "department";
ALTER TABLE "User"            DROP COLUMN IF EXISTS "department";
ALTER TABLE "WhatsappSession" DROP COLUMN IF EXISTS "department";

DROP TABLE IF EXISTS "TicketNote";
DROP TABLE IF EXISTS "Ticket";
DROP TABLE IF EXISTS "Alert";
DROP TABLE IF EXISTS "Lead";
DROP TABLE IF EXISTS "Zone";

DROP TYPE IF EXISTS "TicketStatus";
DROP TYPE IF EXISTS "TicketPriority";
DROP TYPE IF EXISTS "AlertSeverity";
DROP TYPE IF EXISTS "LeadStage";
DROP TYPE IF EXISTS "Department";
