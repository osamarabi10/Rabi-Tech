# RabiTech — Deep System Analysis

> **Historical snapshot — 2026-08-19. Superseded by
> [PROJECT-SPEC.md](PROJECT-SPEC.md).**
>
> This is the audit that drove the cleanup work; most issues it raises have since
> been fixed. It is kept as a record of what was found and why decisions were
> made, **not** as a description of the current system. For current state, read
> PROJECT-SPEC.md. References here to an earlier single-tenant, ISP-specific
> deployment describe what was being removed — that code and data are gone.

**Audited against the running system: 2026-08-19.** Every claim below was verified by reading
the working tree, querying the live database, or running the code — not inferred from docs.

---

## 1. Verdict

You have built **an unusually solid multi-tenant foundation with a thin, ISP-shaped product on
top of it.**

The infrastructure is genuinely better than most funded startups at this stage: fail-closed
tenant scoping, 22 composite foreign keys enforcing isolation *at the database*, per-organization
WhatsApp gateways, exact usage metering, and a provider-agnostic billing layer. 45/45 isolation
checks pass and I re-ran them to confirm.

The product surface is roughly **one third** of what you're comparing yourself to, and what
exists is still shaped like a single ISP's helpdesk rather than a commercial conversation
platform.

**The gap is not effort — it's that the foundation was rebuilt commercially and the product
above it never was.**

---

## 2. What the system actually is today

### 2.1 Scale

| | |
|---|---|
| Backend | 70 files, 10,319 LOC |
| Frontend | 44 components, 6,915 LOC |
| Models + enums | 48 |
| API route groups | 15 |
| Background workers | 7 |
| Live organizations | 2 (`rabitech-demo`, `ostudio`) |
| Total messages in DB | 6 |

**You are pre-launch.** That is the single most important fact in this document, and §7 explains
why.

### 2.2 The onboarding flow (works today)

```
RabiTech owner → creates subscriber (name + admin email)
      ↓
Organization row + first admin Identity/User + default Team
      ↓
Gateway provisioner (BullMQ) → dedicated OpenWA container + volume + credentials
      ↓
AWAITING_QR → admin scans with their phone → ACTIVE
      ↓
Admin creates worker users
```

Verified live: `ostudio` runs on `rabitech-ostudio-gateway-openwa-1` (ports 3100/3101) with its
own Redis, fully isolated from the legacy shared gateway.

### 2.3 The message flow (works today)

```
Customer WhatsApp
      ↓
Org's own OpenWA gateway
      ↓
POST /webhooks/openwa/:webhookToken   ← token resolves the tenant
      ↓
BullMQ incoming-message queue (jobId namespaced by org)
      ↓
Worker → tenant scope → contact upsert → conversation → keyword match
      ↓  → auto-reply, usage metering
      ↓
Socket.io emit to org:{orgId}:team:{teamId}
      ↓
Agent inbox
```

### 2.4 The money flow (works, unbilled)

```
Every message → UsageEvent (append-only)
      ↓ nightly 00:15 UTC
PlatformDailyMetric rollup → exact MAC (distinct contacts with activity)
      ↓
Quota check at send path
      ↓
over quota → outbound BLOCKED, inbound STILL PROCESSES
```

That last rule is correct and rare. Most teams get it backwards.

---

## 3. What is genuinely strong

Do not rebuild any of this.

| Capability | Why it's good |
|---|---|
| **Tenant isolation** | Fail-closed `AsyncLocalStorage` + Prisma `$extends`. Absence of context *throws*. 22 composite FKs mean a cross-org write is rejected by Postgres, not by app logic. |
| **Gateway isolation** | One OpenWA container + volume + encrypted credential + webhook token per org. Real isolation, not logical. |
| **Provisioning** | Resumable state machine (`PENDING→PROVISIONING→AWAITING_QR→ACTIVE→SUSPENDED`) driven by BullMQ. |
| **Metering** | Append-only ledger, exact MAC definition, idempotent nightly rollup. |
| **Billing abstraction** | `PaymentProvider` interface with zero provider SDK installed and no vendor names in the schema. Swapping in Stripe/Paddle is one adapter. |
| **Platform/tenant split** | Separate JWT scopes, `PlatformAuditLog` written before every cross-tenant read. |
| **Test gate** | 45 isolation checks including a DB-level cross-org nested-write rejection. |

---

## 4. Gap analysis vs Respond.io

Sourced from their official SDK, their reference channel implementation, and their published
engineering material.

### 4.1 The defining gap: single channel

Respond.io's entire identity is **one contact, many channels, one thread**. A customer messages
on WhatsApp, replies by email, calls — same conversation.

RabiTech: `Contact` is welded to one `phone` on one `WhatsappSession`. There is no
`ContactChannel` join. **This is the difference between "WhatsApp inbox" and "omnichannel
platform"**, and everything else in this section is secondary to it.

### 4.2 No auto-assignment — confirmed absent

I grepped for round-robin, least-open, and auto-assign logic. **There is none.** `assignedToId`
exists on `Conversation`; nothing ever sets it automatically.

Respond.io ships exactly two strategies — Round Robin and Least Open Contacts — both checking
agent online status at assignment time.

This is the **highest value-per-hour item in the entire backlog.** It is roughly a day's work
and it is the single most-used feature in any team inbox. Right now every conversation sits
unassigned until a human manually claims it.

### 4.3 Inbox is a 1,385-line monolith

`app/(dashboard)/inbox/page.tsx` mixes socket state, polling loops, and rendering. Respond.io's
three-pane layout (queue │ thread │ contact context) is not cosmetic — the contact sidebar is
what lets an agent resolve without leaving the conversation.

Also missing: the Reply/Comment toggle in one composer, which is the most-copied interaction in
the category. You already have `Message.isInternal` — the data model supports it; the UI doesn't.

### 4.4 No workflow builder

`utils/conversation-session.ts` + `utils/menu.ts` are a hand-rolled workflow engine with the
rules compiled in. Respond.io exposes triggers (intent, contact fields, API lookups, agent
status, VIP tier, language, timezone), conditions, and branches to the admin.

### 4.5 Smaller but real

| Gap | Cost |
|---|---|
| Tags exist as a model but `Conversation.labels String[]` still coexists | Low |
| No thread events ("assigned to X", "tag added") | Low |
| No snooze state (has `AWAITING_CLIENT`, not snooze-until) | Low |
| Keywords are API-only — **no Settings UI**, admins can't self-serve | Low |
| No outbound webhooks for integrators | Medium |
| No AI agents | Deferred by your decision |

---

## 5. Risk register — what breaks with a real client

Ranked by (likelihood × damage).

### 🔴 CRITICAL — fix before anyone logs in

**1. `POSTGRES_PASSWORD: secret`**
Literally the word "secret" in `docker-compose.yml:10`. Every customer conversation in that
database.

**2. No rate limiting anywhere**
Confirmed absent. Login is open to unlimited brute force. Public signup is open to automated
abuse — and signup *provisions Docker containers*, so it's also a resource-exhaustion vector.

**3. Everything is `http://` on a hardcoded LAN IP**
`docker-compose.yml` pins `192.168.1.38`. Agent passwords, JWTs, and customer message content
cross the network in plaintext. If the client is not physically on your LAN, this does not work
at all — and if they are, it's still unencrypted.

### 🟠 HIGH

**4. Templates are signed "RabiTech 🌐"**
On a **white-label** product, your client's customers see *your* brand. `arabic-templates.ts`
also still contains a real business's support and contact numbers, hardcoded.

**5. Provisioning cannot self-heal from FAILED**
`reconcileProvisioning()` queries `PENDING|PROVISIONING|AWAITING_QR|SUSPENDED` — **`FAILED` is
not in the list.** A channel that fails is stranded permanently until someone hand-edits the
database. This already happened once (`ostudio`). The resume logic exists at
`gateway-provisioning.service.ts:223` but reconcile never reaches it.

**6. No backup restore has ever been tested**
Dumps exist. Restoring one has never been verified. An untested backup is not a backup.

### 🟡 MEDIUM

**7. No monitoring or alerting** — nobody is told when a gateway dies or a queue backs up.
**8. WhatsApp session loss is undocumented** — this *will* happen; there's no runbook.
**9. `PlatformDailyMetric` index isn't org-prefixed** — `@@index([date, metric])` but it's
queried per-org. Respond.io's 100× win came from exactly this class of mistake.

---

## 6. Dead weight inventory

Verified: **there is no Malan tenant and no ISP data.** `Zone` has 5 seed rows; `Alert`, `Lead`,
`Ticket`, `Campaign`, `Keyword` all have **zero**.

| Artifact | Schema | Code refs | Rows | Verdict |
|---|---|---|---|---|
| `Department` enum | present | **0** | — | Dead. Delete. |
| `Zone` | present | 5 files | 5 seeds | Delete. |
| `Alert` + `AlertSeverity` | present | 6 files | 0 | Delete. |
| `Lead` + `LeadStage` | present | 2 files | 0 | Delete — lifecycle belongs on Contact. |
| `Ticket` + `TicketNote` | present | 8 files | **0** | Decide (§7). |
| `isSharedWhatsAppLine` | — | present | — | Delete. |
| ISP templates | — | — | **purged 2026-08-19** | ✅ done |

**On tickets:** Respond.io has no ticket object — it has conversations with status, assignee,
tags, and a closing category. You have `ConversationStatus` with 4 states already. Ticket is
0 rows, duplicates conversation state, and its auto-creation logic is ISP-shaped. My
recommendation is **delete it**; keeping it is inertia, not a decision.

---

## 7. The rebuild sequence

### The strategic fact

**6 messages. 9 contacts. 2 orgs.** You are pre-launch, and destructive refactoring will never
be cheaper than it is this week. The moment a real client sends their first message, every
change in §6 needs backfills, dual-writes, and migration windows. Today they need none.

**Do the deletions now.** Not carefully, not behind feature flags — just delete them.

### Order

| # | Phase | Why here | Size |
|---|---|---|---|
| **0** | **Security blockers** — DB password, rate limiting, TLS | Client cannot log in safely without these | 1–2 days |
| **1** | **Provisioning self-heal** — add FAILED to reconcile with bounded retry | Will strand a real client otherwise | 0.5 day |
| **2** | **Purge ISP** — Department, Zone, Alert, Lead, Ticket, shared-line, template rewrite | Never cheaper than now | 2–3 days |
| **3** | **Auto-assignment** — Round Robin + Least Open | Highest value per hour in the backlog | 1 day |
| **4** | **Backup restore test + runbook** | Untested backup ≠ backup | 0.5 day |
| **5** | **Inbox rebuild** — 3-pane, Reply/Comment toggle, contact sidebar | The visible product gap | 2–3 weeks |
| **6** | **`ContactChannel` + channel abstraction + 2nd channel** | The *defining* Respond.io gap | 4–5 weeks |
| **7** | **Workflow builder** | Admin-configurable automation | 6–8 weeks |
| **8** | **Payment adapter** | When you pick a provider | 1 week |

**Phases 0–4 total under a week** and take you from "works on my LAN" to "safe to put a paying
client on."

Phases 5–6 are what let you honestly say *"like Respond.io."* Until then the accurate pitch is
**"a white-label WhatsApp business platform"** — which is a real, sellable product. Sell that.
Don't promise omnichannel until §4.1 ships.

---

## 8. What I fixed during this audit

- **Message loss on send** — `conversations.routes.ts` called OpenWA *before* persisting, so a
  provider timeout after successful delivery discarded the record. The customer received the
  message; the agent saw an error and an empty thread; re-sending duplicated it. Now persists
  as `PENDING` → sends → `SENT`/`FAILED`, and always returns the message. Fixed in both
  agent-facing send paths.
- **Malan greeting** — lived in the **database** (`seed-welcome-start`), not source, which is
  why earlier source cleanups missed it. Replaced.
- **11 ISP templates purged** — router restarts, zone outages, ticket scripts, plan offers.
  Backed up to `.tools/backups/rabitech-before-template-purge-20260819.dump`.
- **Traced "auto-send on open"** — `sendStartWelcome` at `conversations.routes.ts:88` fires when
  a conversation is started with no message body.

Verified after: typecheck clean, backend healthy, **45/45 isolation checks passing**.
