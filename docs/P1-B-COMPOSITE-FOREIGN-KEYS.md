# P1-B Composite Tenant Foreign Keys

Implemented 2026-08-19 in migration `20260819162000_add_composite_tenant_foreign_keys`.

The migration preflights historical rows, creates compound parent keys before child constraints, replaces global one-to-one conversation keys with tenant-local keys, and then installs 22 composite foreign keys. It aborts if any existing parent-child reference crosses organizations.

## Enforced Pairs

| Child | Parent | Delete behavior |
|---|---|---|
| `GroupMessage.sessionId` | `WhatsappSession` | Cascade |
| `Conversation.contactId` | `Contact` | Cascade |
| `Conversation.sessionId` | `WhatsappSession` | Cascade |
| `Conversation.assignedToId` | `User` | Restrict |
| `Message.conversationId` | `Conversation` | Cascade |
| `Message.sentById` | `User` | Restrict |
| `Ticket.conversationId` | `Conversation` | Restrict |
| `Ticket.createdById` | `User` | Restrict |
| `Ticket.assignedToId` | `User` | Restrict |
| `TicketNote.ticketId` | `Ticket` | Cascade |
| `TicketNote.authorId` | `User` | Restrict |
| `Campaign.sessionId` | `WhatsappSession` | Cascade |
| `CampaignRecipient.campaignId` | `Campaign` | Cascade |
| `CampaignRecipient.contactId` | `Contact` | Cascade |
| `AuditLog.userId` | `User` | Restrict |
| `CsatSurveyResponse.conversationId` | `Conversation` | Cascade |
| `CsatSurveyResponse.contactId` | `Contact` | Cascade |
| `CsatSurveyResponse.assignedToId` | `User` | Restrict |
| `Lead.contactId` | `Contact` | Cascade |
| `Lead.assignedToId` | `User` | Restrict |
| `Notification.userId` | `User` | Cascade |
| `Notification.conversationId` | `Conversation` | Restrict |

Every relation above binds `(parentId, organizationId)` to `(id, organizationId)`. Optional references use `Restrict` because setting both composite columns to null would violate the required child `organizationId`.

## Parent Keys

Compound `@@unique([id, organizationId])` keys were added to `User`, `WhatsappSession`, `Contact`, `Conversation`, `Ticket`, and `Campaign`. `Ticket.conversationId` and `CsatSurveyResponse.conversationId` are now unique per organization rather than globally.

## Deliberate Skips

- Relations directly to `Organization` already use the tenant root's globally unique ID; adding the same ID twice provides no additional boundary.
- `User.identityId → Identity` is global by design because `Identity` is a platform credential shared by organization memberships.
- `Contact.zoneId → Zone` and `Campaign.zoneId → Zone` target shared reference data.
- `WorkingHours → MessageTemplate` is deferred to P1-D because `WorkingHours` is still a platform-global singleton and has no `organizationId` yet.
- Tenant models that are not referenced as parents do not need an `(id, organizationId)` key until a tenant-child relation is introduced.

## Verification

- Live preflight found zero historical mismatches.
- Clean-schema migration completed through all 20 migrations.
- Backend build and Prisma constructor lint pass.
- P1-A improved from `14/22` to `15/22`.
- The harness performs a real nested write whose child carries another organization's ID; PostgreSQL rejects the transaction with a foreign-key violation.
