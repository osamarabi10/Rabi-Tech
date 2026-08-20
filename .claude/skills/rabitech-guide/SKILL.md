---
name: rabitech-guide
description: Architecture and conventions guide for the RabiTech WhatsApp operations platform (Express + Prisma backend, Next.js frontend). Use this whenever working on this codebase — adding/changing conversation flows, ticket auto-creation, Arabic auto-reply templates, WhatsApp webhook/group handling, zone broadcasts, or the IT/Marketing shared-line setup. Also consult before running Prisma migrations or typechecking the backend.
---

# RabiTech guide

A WhatsApp-based customer support + marketing inbox for an ISP based in Kfar Qasim
(Arab48 / Palestinian-Israeli community). Backend: Express + Prisma (Postgres) in
`apps/backend/src`. Frontend: Next.js in `apps/frontend`. WhatsApp connectivity goes
through OpenWA (gateway service), driven via webhooks.

## Architecture map

| Concern | File |
|---|---|
| Inbound WhatsApp webhook (messages, groups, session status) | `apps/backend/src/webhooks/openwa.webhook.ts` |
| One-thread-per-contact, ticket auto-creation, auto-replies | `apps/backend/src/utils/conversation-session.ts` |
| Priority/category keyword detection | `apps/backend/src/constants/keywords.ts` |
| Arabic auto-reply text | `apps/backend/src/constants/arabic-templates.ts` |
| Shared-line / IT vs Marketing routing helpers | `apps/backend/src/utils/whatsapp-sessions.ts` |
| Group id normalization + group message handling | `apps/backend/src/utils/group-id.ts`, `webhooks/openwa.webhook.ts` |
| Zone broadcasts (outage/resolved) | `apps/backend/src/modules/alerts/alerts.routes.ts` |
| Client feedback / star-rating after resolve | `apps/backend/src/utils/client-feedback.ts` |
| Conversation/ticket REST API | `apps/backend/src/modules/conversations/`, `modules/tickets/` |
| Prisma schema | `apps/backend/prisma/schema.prisma` |

## Shared WhatsApp line (IT + Marketing)

`IT_NUMBER` and `MARKETING_NUMBER` in `.env` may point at the **same** WhatsApp number.
`isSharedWhatsAppLine()` in `whatsapp-sessions.ts` detects this. When true:

- All inbound messages arrive under the `it-support` OpenWA session — there is no
  separate `marketing` session to query.
- The Marketing tab deliberately shows the **same conversation list** as IT
  (`conversationFilterForDept`) — this is intentional, not a bug.
- `Conversation.department` (`IT` | `MARKETING`, nullable) tags which tab a
  conversation was *initiated from* (set in `conversations.routes.ts` `/start`).
  Use this to gate department-specific automation — e.g.
  `maybeCreateTicketAndAutoReply` skips ticket creation entirely when
  `department === 'MARKETING'`, so marketing replies don't spawn IT tickets.
- `dbSessionForRoute()` / `openWaSessionForRoute()` redirect "marketing route"
  actions to the `it-support` session row when the line is shared. Always go
  through these helpers rather than hardcoding `it-support` / `marketing`.

If `MARKETING_NUMBER` is ever set to a *different* number, all of the above
short-circuits to normal per-department behavior automatically — don't special-case
the non-shared path separately.

## Conversation / ticket auto-flow

For every inbound 1:1 message (`handleInboundMessage` in the webhook):

1. `getOrCreateActiveConversation` — finds/reopens/creates the one thread for this
   contact+session. Reopens RESOLVED threads rather than creating duplicates.
2. `handleClientFeedback` — if the customer recently got a "resolved" message
   (within 72h, tracked via `hadRecentResolvePrompt`), a short reply (1-5, "شكراً",
   etc.) is treated as a CSAT rating/thanks and does **not** open a ticket. This
   check runs *before* ticket logic and short-circuits it.
3. If not handled as feedback and outside working hours → `maybeSendOutOfHoursReply`.
4. `maybeCreateTicketAndAutoReply`:
   - Runs `detectPriority(body)` from `keywords.ts` → CRITICAL/HIGH/MEDIUM/LOW +
     category (`network`/`hardware`/`speed`/`service`/`other`) + `alreadyTried`
     flag (customer says they already restarted/retried — escalates MEDIUM→HIGH
     and swaps in the `ALREADY_TRIED` template instead of basic troubleshooting
     steps).
   - Skips entirely for `department === 'MARKETING'` conversations.
   - Creates or reopens a `Ticket`, sends the matching `TEMPLATES[priority]` (or
     `ALREADY_TRIED`) reply via `pickReplyTemplate`.
   - `pickFollowUp` may send a second message: `SPEED_TEST` for `category ===
     'speed'`, or `UPGRADE_LEAD` if the matched keyword is an upgrade request
     ("ترقية"/"تغيير باقة").
   - CRITICAL tickets also notify `IT_ALERT_GROUP_ID` via `OpenWAService.sendGroup`.

When adding a new auto-reply scenario, follow this pattern: add keywords to
`keywords.ts`, add the message text to `arabic-templates.ts`, and wire the
trigger into `conversation-session.ts` (or `client-feedback.ts` for post-resolve
flows) — don't scatter new logic into the webhook itself.

## Group messages

Group payloads are detected via `isGroupPayload`/`resolveGroupId` (`group-id.ts`),
stored in `GroupMessage` (separate from `Message`/`Conversation`), and broadcast on
socket room `group:${normalizedGroupId}`. **Always normalize the group id with
`normalizeGroupId()` before using it for storage, room names, or comparisons** —
raw payloads sometimes include a `:device` suffix that must be stripped, and a
mismatch between the stored/joined id and the emitted room id silently breaks
live updates (this has been a real bug before).

## Zone broadcasts

`alerts.routes.ts` has `POST /zone-outage` and `POST /zone-resolved`, which loop
over all `Contact`s with a given `zoneId` and send `TEMPLATES.ZONE_OUTAGE` /
`ZONE_RESOLVED` via `OpenWAService.sendText`, with a ~1.2s delay between sends to
avoid WhatsApp rate limits. Zones are defined in `constants/zones.ts`
(`RABITECH_ZONES` — Kfar Qasim, Kfar Bara, Jaljulia, Tayibe, Tira).

## Arabic dialect convention

This is **not** MSA (Modern Standard Arabic). The company is in Kfar Qasim
(Arab48 / Palestinian dialect). Customer-facing text should sound like a local
person texting — e.g. "أهلين" not "مرحباً", "بدي/بدك" not "أريد/تريد", "شو" not
"ماذا", "فيني/فيك" for "I/you can". When writing or editing anything in
`arabic-templates.ts`, match the existing colloquial tone (see `WELCOME_START`,
`RESOLVED`, `ALREADY_TRIED` for reference) rather than formal/Gulf/Egyptian Arabic.

## Required commands after backend changes

- **Schema changes**: edit `prisma/schema.prisma`, write a migration under
  `prisma/migrations/<timestamp>_<name>/migration.sql` (DB may not be reachable
  from the dev sandbox — write the SQL by hand if `prisma migrate dev` can't
  reach `localhost:5432`), then run `npx prisma generate`. When the live DB *is*
  reachable, run `npx prisma migrate deploy` — forgetting this causes every
  query touching the new column to fail at runtime even though `tsc` is clean.
- **Typecheck**: `cd apps/backend && npx tsc --noEmit -p .` — run this after any
  backend `.ts` edit, it's fast and catches most mistakes before runtime.
- If the backend dev server (`npm run dev`, port 4000) appears to have crashed
  after a schema change, restart it with `npm run dev` from `apps/backend`.
