# RabiTech — Master Implementation Plan

**Single source of truth.** Everything an agent needs to take this codebase from a partly
multi-tenant WhatsApp inbox to a Respond.io-class omnichannel SaaS. Self-contained: no other
document is required.

- Repo root: `<rabitech-repo-root>`
- Verified against the working tree: **2026-08-19**
- Supersedes: `ARCHITECTURE-MULTITENANCY.md`, `RESPOND-IO-PARITY.md`, `IMPLEMENTATION-PROMPTS.md`
  (kept for history; this file is authoritative)

---

## 0. How to use this document

Work the phases **in order**. Each phase in §6 is a self-contained brief: paste it into a fresh
agent session together with §2 (current state) and §3 (rules).

Before starting any phase:

```bash
cd apps/backend && npx tsc --noEmit -p .
```

A phase is not done until its **Definition of done** passes and typecheck is clean.

**Do not skip P1-A.** It is the regression gate every later phase depends on.

---

## 1. What this system is

A multi-tenant WhatsApp operations platform. Customers message via WhatsApp; the system
auto-routes, auto-replies, creates IT tickets, and lets agents respond from a web dashboard.
Arabic RTL UI, Palestinian/Arab48 colloquial (`أهلين` not `مرحباً`, `شو` not `ماذا`).

| Service | Port | Role |
|---|---|---|
| `postgres` | 5432 | PostgreSQL 15 |
| `redis` | 6379 | BullMQ queues |
| `openwa` | 3000/3001 | WhatsApp gateway REST + QR UI |
| `backend` | 4000 | Express + Prisma + Socket.io |
| `frontend` | 8080 | Next.js 16 App Router |

**Authority model.** RabiTech is the platform owner, *not* a tenant.

| Actor | Stored as | Authority |
|---|---|---|
| RabiTech owner | `Identity.platformRole = OWNER` | Creates/suspends/inspects subscriber orgs |
| RabiTech support | `Identity.platformRole = SUPPORT` | Granted platform actions; cannot create owners |
| Subscriber | `Organization` | Isolation, billing, branding, WhatsApp ownership boundary |
| Subscriber admin | `User.role = ADMIN` | Connects WhatsApp by QR; manages workers in that org |
| Subscriber worker | `User.role = SUPERVISOR\|AGENT\|VIEWER\|FINANCE` | Works inside one org only |

`Identity` = global login credential. `User` = that identity's membership + role in one
organization. Platform scope and organization scope are **separate JWT scopes** and must never be
inferred from each other.

---

## 2. Verified current state (2026-08-19)

Everything below was confirmed by reading the working tree, not assumed.

### 2.1 Already implemented ✅

| Item | Evidence |
|---|---|
| Fail-closed tenant scope | `apps/backend/src/lib/tenant-context.ts` (103 lines) |
| Prisma `$extends` scoping | `apps/backend/src/prisma/extensions.ts` (99 lines) |
| `runAsPlatform` escape hatch | `tenant-context.ts:83` |
| Platform control plane | `apps/backend/src/modules/platform/platform.routes.ts` (121 lines) |
| Prisma constructor lint | `apps/backend/scripts/lint-prisma-client.js` (86 lines) |
| Tenancy models | `Organization`, `Identity`, `Sequence` in `prisma/schema.prisma` |
| Tenant columns + backfill | migration `20260819000000_add_tenancy_base` |
| Subscriber onboarding | migration `20260819010000_subscriber_onboarding` |
| Atomic sequences | migration `20260819_add_sequence_table` |
| JWT revocation | migration `20260819_add_token_version` |
| Org-namespaced BullMQ job IDs | inbound + escalation workers |
| Signed/authenticated media and organization-token webhooks | Phase 0/P1-E work |
| Composite parent-child FKs | 22 compound tenant FKs; see `docs/P1-B-COMPOSITE-FOREIGN-KEYS.md` |
| Socket room namespacing | Central `socketRoom` helper and live two-organization isolation test |
| Tenant, usage, provisioning, and branding harness | `npm run test:tenancy`; current gate is green at `38/38` |
| Organization configuration | DB-owned session names/numbers, alert group, and explicit `sharedLine` |
| Tenant working hours and sequences | One working-hours row per org; atomic `(organizationId, kind)` counters |
| Durable platform audit | `PlatformAuditLog` row written before every `runAsPlatform` operation |
| Organization-owned OpenWA | Encrypted channel credentials, tokenized webhooks, provider-local TTL cache |
| Usage metering and quotas | Append-only ledger, exact MAC, nightly rollups, send-path limits; see `docs/P3-USAGE-METERING.md` |
| Automated gateway provisioning | Resumable BullMQ/Compose lifecycle, isolated allocations, QR activation, suspend/resume/destroy; see `docs/GATEWAY-PROVISIONING.md` |

**Compound uniques already migrated** (`prisma/schema.prisma`):

```
User             @@unique([organizationId, identityId])          :168
WhatsappSession  @@unique([organizationId, sessionName])         :188
WhatsappSession  @@unique([organizationId, phoneNumber])         :189
Message          @@unique([organizationId, waMessageId])         :212
Contact          @@unique([organizationId, phone])               :247
GroupMessage     @@unique([organizationId, waMessageId])         :303
MessageTemplate  @@unique([organizationId, shortCode])           :398
CampaignRecipient @@unique([organizationId, campaignId, contactId]) :431
Keyword          @@unique([organizationId, category, phrase])    :469
```

### 2.2 NOT done — these block subscriber #2 🚫

| Gap | Verified evidence |
|---|---|

### 2.3 Known landmines

- **`prisma/seed.ts` and 4 files in `scripts/`** construct their own `new PrismaClient()` (25 query
  sites) and bypass the extension. On the lint exception list.
- **Bare aggregates**: `prisma.ticket.count()` and `prisma.contact.count()` in
  `src/modules/analytics/analytics.routes.ts` (~:263, ~:265).
- **`app/(dashboard)/inbox/page.tsx`** is ~1,500 lines with socket state *and* 8s/10s polling.
- **P1.5 branding is next.** Gateway provisioning, same-origin frontend API routing, the
  hardcoded LAN allowlist cleanup, and the frontend dependency security pass are complete.

---

## 3. Non-negotiable rules

1. **Fail closed.** If tenant context is absent on a tenant-scoped model, **throw**. Never fall
   through to unscoped. This is already implemented — do not weaken it.
2. **Never widen tenant scope to make a test pass.** If a query genuinely needs `runAsPlatform`,
   justify it in the commit message.
3. **Migrations are hand-written SQL** at
   `apps/backend/prisma/migrations/<timestamp>_<name>/migration.sql`, then `npx prisma generate`.
   Additive path only: nullable column → backfill → `NOT NULL`.
4. **Typecheck before done:** `cd apps/backend && npx tsc --noEmit -p .`
5. **No `new PrismaClient()`** outside `src/prisma/` except the reviewed lint exception list.
6. **No module-scope mutable caches holding tenant data.**
7. **Every socket room name carries the org.** No inline room-name concatenation.
8. **Arabic copy stays Palestinian/Arab48 colloquial.** Match `constants/arabic-templates.ts`.
9. **Frontend uses logical CSS properties** (`inline-start`/`inline-end`), not `left`/`right` — the
   app is RTL today but will have LTR tenants.
10. **404, not 403,** for cross-tenant resource requests. Never confirm existence.

---

## 4. Target model — Respond.io parity (logic)

Sourced, in order of authority, from: **`respond-io/typescript-sdk`** (official SDK — wins any
conflict), **`respond-io/custom-channel-integration-example`** (official reference channel), a
third-party OpenAPI profile, and public docs. All read 2026-08-19.

> `achasoft/roxana-backend` ("open source respond.io") was reviewed and is an early-stage C#
> scaffold — `Application.Data/Models` holds only `User.cs` and `UserToken.cs`. No domain model to
> borrow. Its one useful signal is in §4.9.

### 4.1 Vocabulary map

| Respond.io | RabiTech today | Action |
|---|---|---|
| **Space / Workspace** | none (`Organization` is the only tenant) | Add workspace layer inside Organization |
| **Channel** | `WhatsappSession` | Rename, add `source` discriminator |
| **Contact** | `Contact` | Expand (§4.2) |
| Conversation `open`/`close` | `OPEN \| PENDING \| RESOLVED` | Map `close` ⇐ `RESOLVED`; keep `PENDING` |
| **Comment** | `Message.isInternal` | Promote, add mentions |
| **Tag** (entity) | `Conversation.labels String[]` | Promote to model |
| **Custom Field** | none | New |
| **Lifecycle** (`Contact.status`) | `Lead.stage` | Move onto Contact |
| **Snippet** | `MessageTemplate.shortCode` | Align naming |
| **Broadcast** | `Campaign` | Rename in UI |

### 4.2 Contact identity — the deepest gap

Contacts are addressed by **`id:{id}` / `email:{email}` / `phone:{phone}`** and are
channel-independent, reachable on many channels.

```
Contact: id, firstName, lastName, email, phone, language, profilePic,
         countryCode, status (lifecycle), assignee, created,
         tags[], customFields[{name, value}]
```

Plus a **`ContactChannel`** join: one contact ↔ many channels, each holding the channel-native
address (`@c.us`, Messenger page-scoped ID, Telegram chat ID, email address).

**Contact merge** is first-class: `POST /contact/merge {primaryContactId, secondaryContactId}`,
consolidating conversations, tags, and fields onto the primary. This is **different** from the
existing `consolidateContactThreads()` in `utils/conversation-session.ts`, which merges threads.
Keep both.

### 4.3 Send routing — copy this rule exactly

> "If `channelId` is omitted, the message is sent through **the last interacted channel**."

That single rule is the whole omnichannel UX. Implement it as an explicit resolver, not an implicit
fallback, and return the resolved channel so the composer can display it.

### 4.4 Message content

```
type: text | attachment | quick_reply | whatsapp_template
attachment.type: image | video | audio | file
quickReplies: [{title, payload}]
template: {name, languageCode, components}
traffic: incoming | outgoing
status: sent | delivered | read | failed
```

Text supports interpolation: `Hello {{$contact.name}}, order #{{$contact.orderId}} is ready!`

**We have no `quick_reply`.** It is cheap and high-value — it converts the Arabic menu from "reply
with a number" into tappable buttons.

### 4.5 Conversation

```ts
conversations.updateStatus('id:123', {
  status: 'close', category: 'Resolved', summary: 'Resolved by providing docs',
});
conversations.assign('id:123', { assignee: 456 });                 // user id
conversations.assign('id:123', { assignee: 'agent@example.com' }); // or email
conversations.assign('id:123', { assignee: null });                // unassign
```

- Close = **`category` + `summary`**. Not a `ClosingNote` lookup table.
- Assignee is polymorphic: numeric id, email string, or `null`.
- Current assignees are human users only. AI-specific assignable principals are deferred with P5;
  do not add their schema or UI during the current phases.

### 4.6 Comments

Internal, never sent to the contact, with mentions: `{{@user.456}}`.
Same token family as `{{$contact.x}}` — write **one** tokenizer.

### 4.7 Space (workspace) API

```ts
space.listUsers({ limit: 50 });        // items[].firstName, .email, .role
space.listChannels();                  // items[].name, .source
space.createTag({ name, description, colorCode, emoji });
space.updateTag({ currentName, name, colorCode });
space.deleteTag({ name });
space.createCustomField({ name, slug, description, dataType, allowedValues });
```

- **Tags are addressed by name**, not id (note `currentName`). Name is the business key.
- Tags carry `colorCode` and `emoji`. Our `labels String[]` has neither.
- Custom fields are **typed** (`dataType`), with `allowedValues` for lists and a `slug` distinct
  from display name.

### 4.8 Filter DSL — build once, use three times

```ts
contacts.list({
  search: '', timezone: 'UTC',
  filter: { $and: [
    { category: 'contactField', field: 'assigneeUserId',
      operator: 'isEqualTo', value: '123' },
  ]},
}, { limit: 50, cursorId: 0 });
```

`$and`/`$or` over `{category, field, operator, value}`. This powers saved segment views — **and**
Broadcast audience selection **and** Workflow trigger conditions. One build, three modules.

### 4.9 The custom-channel contract — copy exactly

Respond.io's own reference implementation reduces an entire channel to **two endpoints and one
bearer token**.

**Outbound — they call your server:**
```
POST /message
Authorization: Bearer <CHANNEL_API_TOKEN>
{ "contactId": "+60123456789", "message": { "type": "text", "text": "Hello" } }
→ 200 { "mId": "<provider message id>" }
→ 400 { "error": { "message": "..." } }
```

**Inbound — your server calls them:**
```
POST https://app.respond.io/custom/webhook
Authorization: Bearer <CHANNEL_API_TOKEN>
{ "channelId": "...", "contactId": "<sender>",
  "events": [ { "type": "message", "mId": "...", "timestamp": 1699999999000,
                "message": { "type": "text", "text": "Hi" } } ] }
```

Four decisions to adopt:
1. **One send method with a typed union** — not one verb per message type.
2. **`events[]` is a batch array.** Write the inbound handler as a loop from day one.
3. **`mId` is the provider's ID, returned synchronously** — the correlation key for delivery
   status. Our `waMessageId` plays this role; generalize the name.
4. **One per-channel bearer token, checked in both directions.** The credential is also the
   identity.

Timestamps are **epoch milliseconds**. Normalize at the adapter boundary.

### 4.10 WhatsApp Personal ≠ WhatsApp Business

Roxana splits these into separate services, and that is correct:

| | WhatsApp Personal (QR) | WhatsApp Business Cloud API |
|---|---|---|
| Pairing | QR scan, session state on disk | Meta app + number registration |
| We run | OpenWA | — |
| Templates | none | required outside 24h window |
| Ban risk | real | none |
| Cost | free | per-conversation |

Two **providers**, not one provider with a flag.

### 4.11 API conventions

- Bearer token from `Settings > Integrations > Developer API`
- Cursor pagination: `{items, pagination:{cursorId, hasMore}}`, `limit` max 100, default 10
- Rate limit: 5 req/s per method, `429` + `Retry-After`
- Client: exponential backoff, 3 retries, 30s timeout
- Error taxonomy: `isRateLimitError()` (+`rateLimitInfo.retryAfter`), `isNotFoundError()`,
  `isAuthError()`, `isValidationError()`, `isServerError()`
- Outbound webhooks: new message, message status, new contact, conversation opened/closed

> Do not inherit their inconsistency: create takes `custom_fields` (snake), response returns
> `customFields` (camel). **Use camelCase everywhere.**

---

## 5. UI target

### 5.1 Shell

Left **icon rail** (right in RTL — use logical properties) with workspace switcher:

```
Inbox · Contacts · Workflows · Broadcasts · Reports · Growth · Settings
```

### 5.2 Inbox — three panes

```
┌───────────────┬──────────────────────────┬────────────────────┐
│ Conversation  │  Message thread          │  Contact sidebar   │
│ list          │                          │                    │
│ Tabs:         │  channel-tinted bubbles  │  Profile fields    │
│  Mine         │                          │  Lifecycle         │
│  Unassigned   │  ── Composer ──────────  │  Assignee          │
│  All          │  [channel ▾][snippet]    │  Tags              │
│ Filters:      │  [attach][template]      │  Custom fields     │
│  channel tag  │  ( Reply | Comment )     │  Channels          │
│  assignee     │                          │  History           │
│  status       │                          │                    │
└───────────────┴──────────────────────────┴────────────────────┘
```

Behaviours that matter:
- **Reply/Comment is a toggle in ONE composer.** Comment mode changes background and disables the
  channel selector. Most-copied interaction in the category; we already have the data model.
- Channel selector defaults to last-interacted and shows what resolved.
- Close offers `category` + `summary`.
- Snippet expansion on `:` (already works via `MessageTemplate.shortCode`).
- Keyboard: `Ctrl/Cmd+Enter` send, `Esc` deselect, `J`/`K` through list.

### 5.3 Other modules

- **Contacts** — table, column chooser, saved views (§4.8 DSL), bulk tag/assign, CSV, merge.
  Detail drawer shares a component with the inbox sidebar.
- **Workflows** — canvas, Trigger → Steps → Branches; palette grouped Triggers / Messaging / Logic
  / Data / Integrations; draft-published versioning; per-contact execution log.
- **Broadcasts** — compose → audience (§4.8 DSL) → channel → schedule → review; post-send report.
- **Reports** — conversations opened/closed, first response time, resolution time, messages by
  channel, agent leaderboard, tag distribution.
- **Growth** — channel connect wizard (QR), click-to-chat links, QR generator, website widget.

---

## 6. The phases

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
                        │                                │
                        └────────► P2-C inbox UI ◄───────┘
                                        │
                          P4 workflows ─► P6 billing ──► P7 platform analytics

                          P5 AI agents: DEFERRED until explicitly resumed
```

Sizing assumes one experienced full-stack dev; ×1.4 if new to the codebase.
**Total ≈ 28–38 dev-weeks.** P1-A→P1.5 is roughly 12 weeks and yields a sellable product.

---

### P1-A · Two-tenant bleed harness · ~1 week · DO THIS FIRST

Everything in §2.1 is asserted, not proven. Build the gate before writing more tenancy code.

**Implemented**

1. Seed org A with a fixed fixture (contacts, conversations, messages, tickets, templates,
   keywords, working hours).
2. Snapshot the full JSON body of **every** authenticated GET endpoint as an org-A user, plus every
   socket event org A receives.
3. Seed org B with 10× volume, deliberately overlapping: same customer phone, same
   `sessionName` (`it-support`), same template `shortCode`, same keyword phrase.
4. Re-run org A's snapshot. Assert **byte-identical**. Any count, list length, or `displayId` that
   moved is a failure.

**Negative assertions**
- Org A's token requesting org B's conversation / contact / message / media by ID → **404**.
- Org A's socket calling `join_conversation` with org B's ID → rejected.
- Each BullMQ worker handler invoked with **no tenant context** → throws, zero rows.
- Bare aggregates in `analytics.routes.ts` return org-scoped numbers.
- Two orgs with the same `sessionName` route inbound correctly and do **not** merge contacts.

**Grep audit step (must fail the build)**
- `new PrismaClient(` outside `src/prisma/` beyond the lint exception list
- module-scope mutable domain caches
- socket emits whose room name lacks an org prefix

**Definition of done** — one npm script runs it all. **Report honestly which assertions fail today;
do not fix them in this phase.** Failing tests are the deliverable — they define P1-B…P1-E.

**Implementation checkpoint — 2026-08-19:** `npm run test:tenancy` now runs the disposable-schema,
HTTP, socket, worker, aggregate, collision, sequence-concurrency, durable-audit, and static-audit
suite in CI. After P3: `30/30` passing. The P1-A subscriber-isolation gate is green; each new
subscriber must still receive its own provider deployment and activated channel before QR pairing.

---

### P1-B · Composite foreign keys · ~1 week

The Prisma extension sees only top-level `args`. It cannot see nested writes
(`conversation.create({ data: { messages: { create: [...] } } })`), so it is a convenience layer,
not a boundary. Since RLS was declined, composite FKs are the only defense-in-depth.

**Implemented**

1. Add `@@unique([id, organizationId])` to every tenant-scoped **parent** model.
2. Redeclare each child's `@relation` over `[parentId, organizationId] → [id, organizationId]`.
   Known offenders: `Message → Conversation`, `Conversation → Contact`, `TicketNote → Ticket`.
   Enumerate the full set first.
3. Hand-write the migration. **Order matters:** the parent's composite unique must exist and be
   populated before the child FK is added. Must be safe on already-backfilled data.

```prisma
model Conversation {
  id             String @id @default(cuid())
  organizationId String
  @@unique([id, organizationId])
}
model Message {
  conversationId String
  organizationId String
  conversation   Conversation @relation(
    fields: [conversationId, organizationId], references: [id, organizationId])
}
```

**Definition of done** — a test constructs a cross-org nested write and asserts **the database**
rejects it with an FK violation, not the extension. List every pair changed and every pair
deliberately skipped, with reasons. Run P1-A before and after; report newly passing assertions.

**Completed 2026-08-19:** 22 composite child-parent constraints are live; the nested-write assertion
passes and P1-A improved from `14/22` to `15/22`. Pair inventory and deliberate skips are recorded
in `docs/P1-B-COMPOSITE-FOREIGN-KEYS.md`.

---

### P1-C · Socket room namespacing · ~3 days

Join authorization exists, but room **names** are global, so every emit fans out across tenants.

**Task**

1. In `src/socket/index.ts`, read `organizationId` from the JWT in `io.use()`, store on
   `socket.data`. Reject connections with no org scope.
2. Add a helper building room names from `(organizationId, kind, id)`. **Never concatenate room
   names inline again.**
3. Namespace all rooms as `org:{organizationId}:<existing>`: `dept:it`, `dept:marketing`,
   `alerts`, `conv:{id}`, `user:{id}`, `group:{id}`.
4. Update **every** emit site — grep `.to(` and `.emit(` across `apps/backend/src` and list them
   before editing. Workers emit too; they take the org from the job's tenant scope.
5. Frontend: `app/(dashboard)/inbox/page.tsx`, `app/(dashboard)/groups/page.tsx`,
   `components/notification-bell.tsx`. The client keeps sending **bare IDs** — the server scopes.

**Definition of done** — two sockets in different orgs; an event emitted in A; B receives nothing.

**Completed 2026-08-19:** organization-scope JWTs are required at socket connection time. Every
join, leave, and backend emit builds its room through `src/socket/rooms.ts`; clients continue to
send bare resource IDs. P1-A's room audit, cross-organization join test, and live delivery-isolation
test pass, improving the gate from `15/22` to `17/22`. The inventory and contract are recorded in
`docs/P1-C-SOCKET-NAMESPACING.md`.

---

### P1-D · Organization-scoped configuration · ~1 week

**Task**

1. **`WorkingHours`** — drop the `id @default("default")` singleton; one row per org,
   `@@unique([organizationId])`. Update `utils/out-of-hours.ts` and the system routes.
2. **Keyword cache** — `src/constants/keywords.ts` becomes org-keyed with invalidation on write.
3. **Sequences** — `nextTicketLabel()` is atomic but still platform-global;
   `Conversation.displayId` is still a global autoincrement (`schema.prisma:277` TODO), which
   visibly discloses platform-wide volume to tenant B. Key by `(organizationId, kind)`, allocate in
   a transaction, test simultaneous allocation in two orgs.
4. **`whatsapp-sessions.ts`** — move `IT_SESSION_NAME`, `MARKETING_SESSION_NAME`, `IT_NUMBER`,
   `MARKETING_NUMBER`, `IT_ALERT_GROUP_ID` from env to per-org config. Each function becomes
   `async (organizationId) => …` behind a per-org cache.
5. **`runAsPlatform`** (`tenant-context.ts:90`) currently only calls `logger.info`. Make it write a
   **durable audit row** via `src/lib/audit.ts` before the query.

**Before touching `isSharedWhatsAppLine()`:** read the bootstrap subscriber's actual data to
determine whether live behavior depends on the missing-env accident (§2.3). Encode the answer as an
explicit per-org `sharedLine` boolean. **Report what you found before changing anything.**

**Definition of done** — grep for module-scope `new Map(` / `let cached` across
`apps/backend/src` returns no domain-data caches.

**Completed 2026-08-19:** `WorkingHours`, keywords, WhatsApp route configuration, alert-group
configuration, ticket labels, and conversation display IDs are organization-scoped. Platform scope
writes a durable audit row before its query. The bootstrap subscriber has two distinct live session
rows and phone numbers, so its explicit configuration is `sharedLine = false`; the previous `true`
result came only from missing container number variables. Concurrent two-org sequence allocation and
durable audit assertions pass. See `docs/P1-D-ORGANIZATION-CONFIGURATION.md`.

---

### P1-E · Per-organization OpenWA · ~2 weeks · unblocks subscriber #2

`openwa.service.ts:3` builds ONE axios client at import time; `:16` holds a module-level
`sessionIdCache` (name→UUID) with no tenant key and no TTL. With two orgs both naming a session
`it-support`, org B's send resolves to org A's cached UUID — **a message sent over the wrong
subscriber's WhatsApp line.**

**Task**

1. `OrganizationChannel` model: `organizationId`, `kind`, `baseUrl`, `apiKeyEnc` (encrypted at
   rest), `webhookToken` (globally unique, unguessable), `status`. Support rotation from day one.
2. Replace the singleton with `getClient(organizationId)` returning a per-org cached axios
   instance. Scope `sessionIdCache` **per client instance**, add a TTL. Fix `sessionNameById()`'s
   reverse scan the same way.
3. Extract sending behind the §4.9 contract: **one** `send(contactRef, message)` returning the
   provider's `mId`. Keep pairing (`getQR`, `startSession`, `stopSession`, `createSession`,
   `getStatus`) on a **separate** `PairingProvider`.
4. Webhook → `POST /webhooks/openwa/:webhookToken`. Token resolves the org and enters tenant scope;
   `sessionName` then routes **within** that org. Unresolvable token → **404**. Make the
   `waMessageId` dedupe lookup org-scoped, or one org's message is swallowed as another's duplicate.
5. Provisioning as a resumable state machine:
   `PENDING → PROVISIONING → AWAITING_QR → ACTIVE → SUSPENDED`. Template the `openwa` service out
   of `docker-compose.yml` with a per-org volume. **Do not build an orchestrator** — a host-side
   provisioning service is right at this scale.

~28 OpenWA call sites across 12 files. **List them all before editing.**

**Definition of done** — P1-A passes including the same-`sessionName` collision case.

**Completed 2026-08-19:** `OrganizationChannel` owns each provider base URL, AES-256-GCM encrypted
API key, rotating webhook token, and lifecycle status. OpenWA clients and session UUID caches are
created inside organization scope with a TTL. Webhooks use
`/webhooks/openwa/:webhookToken`, resolve the organization before session routing, and return `404`
for unknown tokens. Both bootstrap sessions are registered idempotently. A host-side isolated
deployment template lives under `deploy/`; new subscribers receive a managed `PENDING` channel and
an organization-namespaced BullMQ job. The resumable host worker drives
`PENDING -> PROVISIONING -> AWAITING_QR -> ACTIVE -> SUSPENDED`, records failed steps/reasons, and
supports suspend/resume/destroy. The tenancy, provisioning, and branding harness is green at `38/38`. See
`docs/P1-E-OPENWA-ISOLATION.md` and `docs/GATEWAY-PROVISIONING.md`.

---

### P1.5 · White-label branding · ~1–1.5 weeks

The frontend is on Next.js 16.3.1 with `npm audit` clean at 0 vulnerabilities. The old
CVE-2025-29927 blocker was cleared before middleware work. `runtime-url.ts` already uses same-origin
browser calls and `next.config.js` no longer has a hardcoded LAN `serverActions.allowedOrigins`
allowlist.

Implementation checkpoint: see `docs/P1-5-BRANDING.md`.

P1.5 branding is implemented; `tailwind.config.ts` and `globals.css` use HSL CSS variables with
server-injected tenant overrides.

**Task**

1. Per-org branding record: product name, signed local logo/favicon asset URLs, primary/accent HSL
   values, locale, direction, custom footer, custom domain, and verification token/status.
2. Replace hardcoded violet literals: `tailwind.config.ts` `boxShadow` + `backgroundImage`, and the
   four spots in `globals.css` (body radial gradient, `::selection`, scrollbar hover, `.glow-ring`).
   Grep `262 83% 63%` and violet/purple classes. **Distinguish brand colors (themeable) from
   semantic status colors (amber = warning, emerald = success — leave those).**
3. `<BrandLogo />` replaces the hardcoded logo in `components/app-sidebar.tsx` and
   `app/(auth)/login/page.tsx`, and dashboard pages render server-enforced footer attribution.
4. `BrandingProvider` beside `lib/i18n.tsx`, mounted in `components/providers.tsx`. CSS variables
   are injected **server-side** in `app/layout.tsx`; theme-bearing violet utilities now read CSS
   variables, with remaining violet/HSL literals kept as defaults.
5. `apps/frontend/proxy.ts` resolving host → tenant for **presentation only**. Never for data
   scoping — the JWT is in `localStorage`, invisible to proxy/middleware. Backend stays the
   authority.
6. Fix `lib/runtime-url.ts` (host-derived API base) and the `next.config.js` LAN allowlist —
   replace with same-origin `/api` + Next rewrites.
7. **Remove all prefilled login credentials from the login page.**

Verification complete: backend typecheck passed, tenancy harness is green at `38/38`, frontend build
passed, and frontend audit is clean at 0 vulnerabilities. DNS/TLS/proxy cutover for custom domains
is documented in `docs/P1-5-BRANDING.md` as an operations checklist.

**Definition of done** — provision a throwaway tenant, set colors + logo + name, screenshot-diff
every page against the default tenant; only branded elements differ.

---

### P2-A · Respond.io parity data model · ~3 weeks · requires P1-B

Every new table gets `organizationId` **and** composite FKs per P1-B. Doing this before P1-B means
retrofitting every table.

**Task**

1. **Contact** — add `firstName`, `lastName`, `email`, `language`, `profilePic`, `countryCode`,
   `status` (lifecycle), `assigneeId`. Keep `phone`. Support `id:` / `email:` / `phone:` addressing.
2. **`ContactChannel`** join — one contact reachable on many channels with the channel-native
   address. Foundation for everything omnichannel.
3. **`WhatsappSession` → `Channel`** with `source` (`whatsapp | messenger | telegram | sms | email
   | webchat`). Mechanical but wide — list every touched file first.
4. **`Tag`** — `name`, `description`, `colorCode`, `emoji`. Addressed **by name**
   (`@@unique([organizationId, name])`). Replaces `Conversation.labels String[]`; write the data
   migration off the array.
5. **`CustomFieldDefinition`** (`name`, `slug`, `description`, `dataType`, `allowedValues[]`) +
   **`CustomFieldValue`**. `dataType` at minimum: text, number, date, list.
6. **Conversation close** takes `category` + `summary`. **Not** a closing-note lookup table.
   Category is a workspace-configurable enum; summary is free text.
7. **Comment** — promote `Message.isInternal` to first-class with `{{@user.456}}` mentions, reusing
   the notification service.
8. **Interpolation** — `{{$contact.name}}`, `{{$contact.<slug>}}`. **One tokenizer** handling both
   `{{$contact.x}}` and `{{@user.x}}`.
9. **Filter DSL** (§4.8) — build now even if only Contacts uses it; Broadcasts and Workflows need
   the identical shape.
10. **Contact merge** — `POST /contact/merge {primaryContactId, secondaryContactId}`. Different
    from `consolidateContactThreads()`; keep both.

AI-specific principals are excluded from P2-A and remain deferred with P5.

**Definition of done** — reversible migration + data-migration script for existing rows; P1-A passes.

---

### P2-B · Channel abstraction + second channel · ~3–4 weeks · requires P1-E, P2-A

Build the §4.9 contract, not a verb-per-message-type interface.

**Task**

1. Outbound: **one** `send(contactRef, message)` with a discriminated union
   (`text | attachment | quick_reply | whatsapp_template`), returning the provider's `mId`.
2. Inbound: one handler taking `{channelId, contactId, events: [...]}`. **`events` is an array —
   loop from day one.** Timestamps epoch ms; normalize at the adapter boundary.
3. Auth: one per-channel bearer token checked in both directions.
4. Pairing stays on a separate `PairingProvider`.
5. Canonical address type. Pull `@c.us` / `@g.us` / `@lid` out of `webhooks/openwa.webhook.ts`,
   `utils/phone.ts`, `utils/group-id.ts` into a WhatsApp adapter. No WhatsApp string formats
   outside it.
6. Send routing per §4.3 — explicit resolver, returns the resolved channel.
7. Add `quick_reply` — upgrades the Arabic menu to tappable buttons.
8. WhatsApp Personal and WhatsApp Business Cloud API are **two providers** (§4.10). Only Personal
   exists today; don't foreclose Cloud API.
9. `MockChannelProvider` — full inbound → auto-reply → ticket → outbound with **zero** WhatsApp
   code in the path.
10. One real second channel — **Telegram** recommended (simplest auth, no approval).
11. Per-provider capability flags so the UI hides what a channel can't do.

**Stretch, high leverage:** expose **our own** custom-channel endpoint pair using the identical
contract. Nearly free once the above exists, and makes RabiTech integrable by third parties.

**Definition of done** — adding a third channel touches only one new directory.

---

### P2-C · Inbox UI parity · ~3 weeks · requires P2-A

**Task**

1. Left icon rail per §5.1, **logical CSS properties only**.
2. Three-pane inbox per §5.2.
3. Composer with **Reply/Comment toggle in one box**; comment mode changes background and disables
   the channel selector. Channel selector defaults to last-interacted and shows what resolved. Keep
   `:shortCode` expansion.
4. Close action offers `category` + `summary`.
5. Keyboard: `Ctrl/Cmd+Enter`, `Esc`, `J`/`K`.
6. Contacts module with saved views built on the §4.8 DSL. **Build the filter-builder as a reusable
   component** — Broadcasts and Workflows need the same widget.
7. **Decompose `app/(dashboard)/inbox/page.tsx`** (~1,500 lines) and drop the 8s/10s polling where
   sockets now cover it.

Arabic copy stays Palestinian/Arab48 colloquial.

---

### P3 · Usage metering + quotas · COMPLETE 2026-08-19

Must land **before** AI agents or the first enthusiastic tenant is an uncapped cost liability.

1. Append-only `UsageEvent` (`organizationId`, `metric`, `quantity`, `timestamp`) at send, receive,
   and AI-call boundaries.
2. Nightly rollup → `PlatformDailyMetric`. This also feeds P7 — design for both consumers now.
3. Plan limits enforced at the send path. Graceful degradation with a clear in-app error, never a
   crash.
4. Usage display in subscriber settings.

**Definition of done** — a tenant at 100% quota gets a clear error and zero outbound sends;
counters reconcile with `Message` rows within 1% over a 24h synthetic run.

**Implementation checkpoint — 2026-08-19:** `UsageEvent` is an append-only tenant ledger;
`PlatformDailyMetric` is an idempotent rollup keyed by organization, date, and metric. MAC is the
distinct count of contacts with inbound or outbound traffic in the UTC calendar month. OpenWA
enforces outbound, active-contact, and campaign limits before provider calls; inbound recording is
never blocked. A nightly BullMQ scheduler and `npm run usage:backfill -- YYYY-MM-DD [YYYY-MM-DD]`
support normal operation and repair. Subscriber and owner usage views are live. The expanded
tenant/MAC/rollup/quota harness passes `30/30`; see `docs/P3-USAGE-METERING.md`.

---

### P4 · Workflow builder · ~6–8 weeks · requires P2-B

**Milestone 1, before any UI:** port the existing Arabic menu logic from
`utils/conversation-session.ts`, `utils/menu.ts`, and `utils/out-of-hours.ts` into a workflow
definition the engine executes. **Those files already are a hand-rolled workflow engine.** If the
new engine can't express that flow, the design is wrong — find out in week 1, not week 4.

Engine first: nodes, edges, versioned definitions (draft/published), durable per-conversation
execution state, awaiting-reply suspension, timeouts.

Node types: `trigger`, `condition`, `send_message`, `delay`, `create_ticket`, `assign_agent`,
`webhook`, `tag_contact`, `update_contact`, `close_conversation`, `escalate`,
`send_broadcast`, `feedback`, `end`.

Canvas second; palette grouped Triggers / Messaging / Logic / Data / Integrations; per-contact
execution log. Trigger conditions reuse the §4.8 DSL.

P5 is deferred by product decision. P4 must not implement an AI node, model-provider integration,
knowledge base, prompt configuration, or AI controls. Keep the engine extensible without shipping
AI-specific behavior.

**Definition of done** — current behavior runs entirely on the engine, **old code paths deleted**,
and a non-engineer can build a 5-node flow that sends a real WhatsApp message.

---

### P5 · AI agents · DEFERRED BY PRODUCT DECISION

Do not start this phase until the product owner explicitly resumes it. It is not part of the current
implementation sequence, and no placeholder UI, provider integration, or knowledge-base schema
should be added meanwhile.

An AI agent is **one node type** in the engine, not a parallel system. P2-A already made agents
assignable principals.

1. Per-org knowledge base with RAG retrieval.
2. Per-org model config and system prompt.
3. Confidence scoring + handoff-to-human node.
4. Token metering via P3 with **hard per-org spend caps**.
5. Use current Claude models — check the `claude-api` skill for model IDs; **do not guess**.

**Critical:** RAG retrieval is a **new query surface that does not pass through the Prisma
extension.** P1-A will not cover it for free. Add an explicit KB-isolation case proving tenant A's
knowledge base is unreachable from tenant B's agent, **including via prompt injection in message
content.**

---

### P6 · Billing · ~3–4 weeks · requires P3

Stripe, plan tiers, subscription lifecycle → organization status, self-serve signup wired to the
P1-E provisioning state machine, dunning.

Use Stripe Checkout / Elements — **card data must never touch our servers.**

**Definition of done** — signup → provisioned org with a live WhatsApp gateway → paid subscription,
no manual step. A failed payment suspends the org **without deleting data**.

---

### P7 · Platform analytics + super-admin · ~2–3 weeks · LAST

Deliberately cross-tenant — build only once the isolation invariant is trusted.

1. Super-admin console over `PlatformDailyMetric` rollups. **Never** run cross-tenant aggregates
   against live tables.
2. Impersonation via `runAsPlatform` — always audited, always visibly banner-flagged in the UI.
3. Per-org health: gateway status, queue depth, error rate.

**Definition of done** — every cross-tenant read appears in the platform audit log with a reason
string; files permitted to import the platform-scope helper ≤ 6, enforced by lint.

---

## 7. Release gate

Subscriber #2 may **not** be connected to live WhatsApp traffic until **all** of the following pass:

- [x] P1-A bleed harness green, wired into CI
- [x] P1-B composite FKs on every tenant child relation
- [x] P1-C every socket room org-namespaced
- [x] P1-D `WorkingHours`, keyword cache, and sequences org-scoped; `runAsPlatform` audited
- [x] P1-E isolation and resumable automatic provider provisioning are complete
- [x] `isSharedWhatsAppLine()` resolved into explicit per-org config, with the live-behavior
      question answered
- [x] P3 usage ledger, exact MAC, quota enforcement, nightly rollups, and usage visibility

A checked box in §2.1 is **not** evidence the phase is complete. Only the harness is.
