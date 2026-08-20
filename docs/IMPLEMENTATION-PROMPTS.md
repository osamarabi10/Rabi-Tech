# RabiTech — Phase Implementation Prompts

Paste one prompt into a fresh coding-agent session from the RabiTech repository root.
Each is self-contained. **Run them in order** — the dependency notes are load-bearing.

Every prompt assumes the agent will first read
[ARCHITECTURE-MULTITENANCY.md](ARCHITECTURE-MULTITENANCY.md) and
[RESPOND-IO-PARITY.md](RESPOND-IO-PARITY.md).

**Standing rules to keep in every session:**
- Never widen tenant scope to make a test pass. If a query needs `runAsPlatform`, justify it in the PR.
- Typecheck before declaring done: `cd apps/backend && npx tsc --noEmit -p .`
- Write migration SQL by hand under `apps/backend/prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma generate`.

---

## Gate order

```
P1-A bleed harness ──► P1-B composite FKs ──► P1-C socket namespacing
                                                      │
                              P1-D org config ────────┤
                              P1-E per-org OpenWA ────┘
                                        │
                                        ▼
                          ✅ SUBSCRIBER #2 UNBLOCKED
                                        │
        ┌───────────────┬───────────────┼───────────────┐
        ▼               ▼               ▼               ▼
   P1.5 branding   P2-A data model   P3 metering    P2-B channels
                        │
                        ▼
                   P2-C inbox UI ──► P4 workflows ──► P5 AI agents ──► P6 billing ──► P7 platform
```

---

## P1-A — Two-tenant bleed harness (do this FIRST)

```
Read docs/ARCHITECTURE-MULTITENANCY.md, especially §7 Phase 1 "Definition of done".

The tenancy work is partly implemented but nothing proves it. Build the bleed harness BEFORE
any more tenancy code, so every subsequent phase has a regression gate.

Build an automated test suite that:
1. Seeds organization A with a fixed, known fixture (contacts, conversations, messages, tickets,
   templates, keywords, working hours).
2. Snapshots the full JSON response body of EVERY authenticated GET endpoint as an org-A user,
   plus every socket event org A receives.
3. Seeds organization B with 10x the data volume, overlapping deliberately: the same customer
   phone number, the same WhatsApp sessionName ('it-support'), the same template shortCode,
   the same keyword phrase.
4. Re-runs org A's snapshot and asserts BYTE-IDENTICAL output. Any count, list length, or
   displayId that moved is a failure.

Also assert these negatives:
- Org A's token requesting org B's conversation/contact/message/media by ID returns 404 (not 403).
- Org A's socket calling join_conversation with org B's conversation ID is rejected.
- Invoking each BullMQ worker handler with NO tenant context throws and returns zero rows.
- Bare aggregates (prisma.ticket.count(), prisma.contact.count() in
  apps/backend/src/modules/analytics/analytics.routes.ts) return org-scoped numbers.
- Two orgs with the same sessionName route inbound messages correctly and do NOT merge contacts.

Add a grep-based audit step that fails on: `new PrismaClient(` outside src/prisma/ (excluding the
reviewed exception list), module-scope mutable domain caches, and socket emits whose room name
lacks an org prefix.

Wire it into a single npm script. Report honestly which assertions FAIL today — do not fix them
in this session. Failing tests are the deliverable; they define the remaining Phase 1 work.
```

---

## P1-B — Composite foreign keys

```
Read docs/ARCHITECTURE-MULTITENANCY.md §0. Composite parent-child FKs are the one unchecked
item that turns the Prisma extension from a convenience layer into a real boundary.

Currently Message → Conversation, Conversation → Contact, and TicketNote → Ticket use
single-column parent IDs, so a nested write can silently attach a child to another org's parent.

For every tenant-scoped child relation in apps/backend/prisma/schema.prisma:
1. Add @@unique([id, organizationId]) to the parent model.
2. Redeclare the child's @relation over [parentId, organizationId] → [id, organizationId].

Write the migration SQL by hand. Order matters: the parent's composite unique must exist and be
populated before the child FK is added. The migration must be safe on a database that already
has backfilled data.

Then prove it: add a test that constructs a cross-org nested write
(conversation.create with a nested messages.create carrying a foreign organizationId) and assert
the DATABASE rejects it with a foreign key violation — not the extension.

Enumerate every parent-child pair you changed and every one you deliberately skipped, with reasons.
Run the P1-A bleed harness before and after; report which assertions newly pass.
```

---

## P1-C — Socket room namespacing

```
Read docs/ARCHITECTURE-MULTITENANCY.md §2 "Socket" and §5 risk 7.

Record authorization exists on socket joins, but room NAMES are still global — so every emit
fans out across all tenants. Rooms today: dept:it, dept:marketing, alerts, conv:{id},
user:{id}, group:{groupId}.

Namespace all of them as org:{organizationId}:<existing name>.

1. In apps/backend/src/socket/index.ts, read organizationId from the JWT in the io.use() handler
   and store it on socket.data. Reject connections whose token has no org scope.
2. Add a helper that builds room names from (organizationId, kind, id). Never concatenate room
   names inline again.
3. Update EVERY emit site. Find them all first — grep for .to( and .emit( across
   apps/backend/src — and list them before editing. Workers emit too, and they must take the org
   from the job's tenant scope, not from a parameter.
4. Update the frontend join/leave calls in apps/frontend/app/(dashboard)/inbox/page.tsx,
   app/(dashboard)/groups/page.tsx, and components/notification-bell.tsx. The client should NOT
   construct org-prefixed names itself — the server should scope the socket so the client keeps
   sending bare IDs.

Then add a test: two sockets authenticated to different orgs, an event emitted in org A, and org
B's socket receives nothing.
```

---

## P1-D — Organization-scoped configuration

```
Read docs/ARCHITECTURE-MULTITENANCY.md §2 "Per-org sequences" and §4 "isSharedWhatsAppLine".

Three pieces of tenant data still live in process-global state or global keys.

1. WorkingHours: drop the id @default("default") singleton. One row per organization,
   @@unique([organizationId]). Update all call sites (utils/out-of-hours.ts and the system routes).

2. Keyword cache: apps/backend/src/constants/keywords.ts caches at module level, refreshed once
   at boot. Make it an org-keyed cache with explicit invalidation whenever a keyword is written.

3. Sequences: nextTicketLabel() is now atomic but still uses a platform-global key, and
   Conversation.displayId is still a global autoincrement — so tenant B's first conversation
   visibly discloses platform-wide volume. Key sequences by (organizationId, kind) and allocate
   inside a transaction. Test simultaneous allocation in two orgs.

4. whatsapp-sessions.ts: move IT_SESSION_NAME / MARKETING_SESSION_NAME / IT_NUMBER /
   MARKETING_NUMBER / IT_ALERT_GROUP_ID from env into per-org config. Every function becomes
   async (organizationId) => ... behind a per-org config cache.

BEFORE changing isSharedWhatsAppLine(): it currently returns !mkt || mkt === it, and
MARKETING_NUMBER is NOT passed to the backend container in docker-compose.yml — so it always
returns true in production and the marketing inbox collapses onto the IT session. Read the
bootstrap subscriber's actual data to determine whether current behavior depends on that, then
encode the answer as an explicit per-org sharedLine boolean. Report what you found before you
change anything.

Finally: grep for module-scope `new Map(` and `let cached` across apps/backend/src and report
every remaining process-global cache holding domain data.
```

---

## P1-E — Per-organization OpenWA provider (unblocks subscriber #2)

```
Read docs/ARCHITECTURE-MULTITENANCY.md §4 in full.

apps/backend/src/modules/whatsapp/openwa.service.ts builds ONE axios client at import time from
OPENWA_URL and OPENWA_API_KEY, and holds a module-level sessionIdCache (name → UUID) with no
tenant key and no TTL. With two orgs both naming a session 'it-support', org B's send resolves to
org A's cached UUID and sends a message over the wrong subscriber's WhatsApp line.

1. Add an OrganizationChannel model: organizationId, kind, baseUrl, apiKeyEnc (encrypted at rest),
   webhookToken (globally unique, unguessable), status. Support key rotation from day one.

2. Replace the singleton with getClient(organizationId) returning a per-org cached axios instance.
   Scope sessionIdCache PER CLIENT INSTANCE and add a TTL. Fix sessionNameById()'s reverse scan
   the same way.

3. Extract the four send verbs (sendText, sendMedia, sendGroup, sendGroupMedia) behind a
   ChannelProvider interface. Keep WhatsApp-only pairing (getQR, startSession, stopSession,
   createSession, getStatus) on a separate PairingProvider interface. Do NOT merge them.

4. Move the webhook to POST /webhooks/openwa/:webhookToken. The token resolves the org and enters
   tenant scope; sessionName then routes WITHIN that org. An unresolvable token returns 404, not
   401. Make the dedupe lookup on waMessageId org-scoped, or one org's message gets swallowed as
   a duplicate of another's.

5. Provisioning: model organization channel setup as a resumable state machine
   (PENDING → PROVISIONING → AWAITING_QR → ACTIVE → SUSPENDED). Template the openwa service out of
   docker-compose.yml with a per-org volume. Do not build an orchestrator — a host-side
   provisioning service is correct at this scale.

There are ~28 OpenWA call sites across 12 files. List them all before you start editing.
Run the P1-A bleed harness at the end, including the same-sessionName collision case.
```

---

## P1.5 — White-label branding

```
Read docs/ARCHITECTURE-MULTITENANCY.md §7 Phase 1.5 and docs/RESPOND-IO-PARITY.md §3.1.

The frontend is ~80% ready: apps/frontend/tailwind.config.ts and app/globals.css already drive
semantic colors through HSL CSS variables.

1. Add a per-org branding record: colors, logo URL, product name, favicon, default locale and
   direction, custom domain.
2. Replace the hardcoded violet literals — in tailwind.config.ts boxShadow and backgroundImage,
   and the four spots in globals.css (body radial gradient, ::selection, scrollbar hover,
   .glow-ring). Grep for 262 83% 63% and the violet/purple Tailwind classes; distinguish BRAND
   colors (themeable) from SEMANTIC status colors (amber = warning, emerald = success — leave those).
3. Parameterize the logo in components/app-sidebar.tsx and app/(auth)/login/page.tsx into one
   <BrandLogo /> reading from context.
4. Add a BrandingProvider beside lib/i18n.tsx, mounted in components/providers.tsx. Inject CSS
   variables server-side in app/layout.tsx so there is no flash of default violet — convert the
   static `metadata` export to generateMetadata() to read headers().
5. Add apps/frontend/middleware.ts resolving host → tenant for PRESENTATION ONLY. Never for data
   scoping: the JWT lives in localStorage and is invisible to middleware. The backend stays the
   authority.
6. Remove all prefilled credentials from the login page.

Verify by provisioning a throwaway tenant, setting colors + logo + name, and screenshot-diffing
every page against the default tenant. The only differences should be branded elements.
```

---

## P2-A — Respond.io parity data model

```
Read docs/RESPOND-IO-PARITY.md §2 in full. Do NOT start this until P1-B (composite FKs) is done,
or every new table here needs retrofitting.

Bring the schema to Respond.io's shape. All new tables get organizationId AND composite FKs to
their parents, per architecture doc §0.

1. Contact: add firstName, lastName, email, language, profilePic, countryCode,
   status (lifecycle stage), assigneeId. Keep phone. Support addressing a contact by
   id:{id} | email:{email} | phone:{phone}.
2. ContactChannel join table: one contact reachable on MANY channels, each with the
   channel-native address. This is the foundation of omnichannel — everything else depends on it.
3. Rename WhatsappSession → Channel with a `source` discriminator (whatsapp | messenger |
   telegram | sms | email | webchat). Mechanical but wide; list every touched file first.
4. Tag as a workspace-scoped entity: name, description, colorCode, emoji. Respond.io addresses
   tags BY NAME (update uses `currentName`), so name is effectively the business key — enforce
   @@unique([organizationId, name]). Replaces Conversation.labels String[]; write the data
   migration off the string array.
5. CustomFieldDefinition (name, slug, description, dataType, allowedValues[]) + CustomFieldValue.
   dataType at minimum: text, number, date, list. allowedValues only meaningful for list.
6. Conversation close takes `category` + `summary` — NOT a closing-note lookup table. (The
   third-party OpenAPI said closingNoteId; the official SDK proves otherwise. See parity §2.4.)
   Category is a workspace-configurable enum; summary is free text.
7. Comment: promote Message.isInternal into first-class comments with @mentions, reusing the
   existing notification service. Mention token syntax is `{{@user.456}}`.
8. Variable interpolation in message text: `{{$contact.name}}`, `{{$contact.<customFieldSlug>}}`.
   Write ONE tokenizer that handles both `{{$contact.x}}` and `{{@user.x}}` — same family.
9. Contact filter DSL per parity §2.7: {$and|$or: [{category, field, operator, value}]}. Build it
   now even if only the Contacts list uses it — Broadcast audiences and Workflow trigger
   conditions need the identical shape, so this is one build serving three modules.
10. Add contact merge: POST /contact/merge {primaryContactId, secondaryContactId} consolidating
    conversations, tags, and fields onto the primary. Note this is DIFFERENT from the existing
    consolidateContactThreads() in utils/conversation-session.ts — keep both.
11. Make AI agents assignable principals alongside human users NOW, even before agents exist.
    Assignee must accept a numeric user id, an email string, OR null — polymorphic, as the
    official SDK does. Retrofitting this later means touching every assignment path.

Provide a reversible migration and a data-migration script for existing rows. Run the bleed harness.
```

---

## P2-B — Channel abstraction + second channel

```
Read docs/RESPOND-IO-PARITY.md §2.9 and §2.10 CAREFULLY, then §2.2. Depends on P1-E and P2-A.

IMPORTANT CORRECTION: an earlier draft specced ChannelProvider as four verbs (sendText, sendMedia,
sendGroup, sendGroupMedia). That was wrong. Respond.io's own reference implementation
(github.com/respond-io/custom-channel-integration-example) reduces a channel to TWO endpoints and
a typed message union. Build that shape instead.

1. Outbound: ONE method, `send(contactRef, message)`, where message is a discriminated union
   (text | attachment | quick_reply | whatsapp_template). It returns the PROVIDER's message id
   ("mId") synchronously — that is the correlation key for later delivery-status callbacks. Our
   waMessageId plays this role today; generalize the name.
2. Inbound: ONE handler taking a batch envelope
   { channelId, contactId, events: [{ type, mId, timestamp, message }] }.
   events is an ARRAY — write it as a loop from day one. Timestamps are epoch MILLISECONDS;
   normalize at the adapter boundary.
3. Auth: a single per-channel bearer token, compared on every request in BOTH directions. The
   channel's credential is also its identity — same shape as the per-org webhookToken from
   architecture doc §4.
4. Keep WhatsApp-only pairing (getQR, startSession, stopSession, createSession, getStatus) on a
   SEPARATE PairingProvider interface. Do not merge it into the send interface.
5. Canonical address type. Pull @c.us / @g.us / @lid handling out of webhooks/openwa.webhook.ts,
   utils/phone.ts, and utils/group-id.ts into a WhatsApp adapter. No WhatsApp string formats
   outside that adapter.
6. Send routing EXACTLY as Respond.io does: when no channel is specified, send through the
   contact's LAST INTERACTED channel. An explicit resolver, not an implicit fallback; return the
   resolved channel so the composer can display it.
7. Add quick_reply ({title, payload}) — this upgrades the Arabic menu flow from "reply with a
   number" to tappable buttons.
8. Treat WhatsApp Personal (our OpenWA, QR-paired) and WhatsApp Business Cloud API as TWO
   PROVIDERS, not one provider with a flag — see parity §2.10. Only Personal exists today; just
   don't build a shape that forecloses Cloud API.
9. Build a MockChannelProvider and prove the full inbound → auto-reply → ticket → outbound flow
   passes end-to-end with ZERO WhatsApp code in the path.
10. Then one real second channel — recommend Telegram (simplest auth, no approval process).
11. Per-provider capability flags so the UI hides what a channel cannot do.

STRETCH, high leverage: expose OUR OWN custom-channel endpoint pair using the identical contract.
It costs almost nothing once the above exists and makes RabiTech integrable by third parties —
the same property that makes Respond.io sticky.

Definition of done: adding a third channel touches only one new directory.
```

---

## P2-C — Inbox UI parity

```
Read docs/RESPOND-IO-PARITY.md §3 in full. Depends on P2-A.

Restructure the frontend to Respond.io's information architecture.

1. Left ICON RAIL with workspace switcher: Inbox, Contacts, Workflows, Broadcasts, Reports,
   Growth, Settings. Build it with logical CSS properties (inline-start/inline-end), NOT left/right
   — the app is RTL Arabic today but will have LTR tenants.
2. Inbox three-pane: conversation list (tabs Mine/Unassigned/All; filters channel, tag, assignee,
   status) | message thread | contact sidebar (profile, lifecycle, assignee, tags, custom fields,
   channels, conversation history).
3. Composer with a Reply/Comment TOGGLE in one box — comment mode changes the background color and
   disables the channel selector. Channel selector defaults to last-interacted and shows which
   channel resolved. Keep the existing :shortCode snippet expansion.
4. Close action offers a closing note.
5. Keyboard: Ctrl/Cmd+Enter send, Esc deselect, J/K through the list.
6. Contacts module: table with column chooser, saved filter views, bulk tag/assign, CSV
   import/export, merge action. The contact detail drawer shares a component with the inbox sidebar.
   Saved views are built on the P2-A filter DSL ({$and|$or: [{category, field, operator, value}]}) —
   build the filter-builder UI as a REUSABLE component, because Broadcast audience selection and
   Workflow trigger conditions need the same widget.

app/(dashboard)/inbox/page.tsx is already ~1,500 lines with socket state AND 8s/10s polling
intervals. Decompose it as part of this work and drop the polling where sockets now cover it.
Keep all Arabic copy in Palestinian/Arab48 colloquial per CLAUDE.md.
```

---

## P3 — Usage metering + quotas

```
Read docs/ARCHITECTURE-MULTITENANCY.md §7 Phase 3.

This must land BEFORE AI agents, or the first enthusiastic tenant is an uncapped cost liability.

1. Append-only UsageEvent (organizationId, metric, quantity, timestamp) written at send, receive,
   and AI-call boundaries.
2. Nightly rollup into PlatformDailyMetric — this also feeds the Phase 7 super-admin console, so
   design it for both consumers now.
3. Plan limits with enforcement at the send path. Graceful degradation with a clear in-app error,
   never a crash.
4. Usage display in subscriber settings.

Verify: a tenant at 100% of message quota gets a clear error and zero outbound sends; counters
reconcile with actual Message rows within 1% over a 24h synthetic run.
```

---

## P4 — Workflow builder

```
Read docs/ARCHITECTURE-MULTITENANCY.md §7 Phase 4 and docs/RESPOND-IO-PARITY.md §3.4.

MILESTONE 1, before any UI: port the existing Arabic menu logic from utils/conversation-session.ts,
utils/menu.ts, and utils/out-of-hours.ts into a workflow definition that the engine executes.
Those files ALREADY ARE a hand-rolled workflow engine. If the new engine cannot express that flow,
the engine design is wrong — find out in week 1, not week 4.

Engine first: nodes, edges, versioned definitions (draft/published), durable per-conversation
execution state, awaiting-reply suspension, timeouts.

Node types: trigger, condition, send_message, delay, create_ticket, assign_agent, webhook,
ai_agent, tag_contact, update_contact, close_conversation, escalate, send_broadcast, feedback, end.

Canvas second. Palette grouped: Triggers, Messaging, Logic, Data, Integrations, AI.
Execution log per contact.

Definition of done: RabiTech's current behavior runs entirely on the engine, the old code paths are
DELETED, and a non-engineer can build a 5-node flow that sends a real WhatsApp message.
```

---

## P5 — AI agents

```
Read docs/ARCHITECTURE-MULTITENANCY.md §7 Phase 5. Depends on P4 (engine) and P3 (metering).

An AI agent is ONE NODE TYPE in the workflow engine, not a parallel system. P2-A already made AI
agents assignable principals.

1. Per-org knowledge base with RAG retrieval.
2. Per-org model config and system prompt.
3. Confidence scoring and a handoff-to-human node.
4. Token metering through Phase 3, with HARD per-org spend caps.
5. Use the current Claude models — check the claude-api skill for model IDs; do not guess.

CRITICAL: RAG retrieval is a NEW query surface that does NOT pass through the Prisma extension.
The P1-A bleed harness will not cover it for free. Add an explicit KB-isolation case proving
tenant A's knowledge base is unreachable from tenant B's agent, including via prompt injection in
message content.
```

---

## P6 — Billing

```
Read docs/ARCHITECTURE-MULTITENANCY.md §7 Phase 6. Depends on P3 (metering counters).

Stripe integration, plan tiers, subscription lifecycle → organization status, self-serve signup
wired to the P1-E provisioning state machine, dunning and failed-payment handling.

Verify: signup → provisioned org with a live WhatsApp gateway → paid subscription, with NO manual
step. A failed payment suspends the organization WITHOUT deleting data.

Do not implement card handling directly — use Stripe Checkout / Elements so card data never
touches our servers.
```

---

## P7 — Platform analytics + super-admin

```
Read docs/ARCHITECTURE-MULTITENANCY.md §3 and §7 Phase 7. Do this LAST — it is deliberately
cross-tenant, so build it only once the isolation invariant is trusted.

1. Super-admin console over PlatformDailyMetric rollups. Do NOT run cross-tenant aggregates
   against live tables.
2. Impersonation via runAsPlatform — always audited, always visibly banner-flagged in the UI.
3. runAsPlatform must write a DURABLE AUDIT ROW (via src/lib/audit.ts) before the query, not just
   a log line. That upgrade is still outstanding.
4. Per-org health: gateway status, queue depth, error rate.

Definition of done: every cross-tenant read appears in the platform audit log with a reason
string, and the number of files permitted to import platform-scope.ts is ≤ 6, enforced by lint.
```
