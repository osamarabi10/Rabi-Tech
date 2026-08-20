# Respond.io Blueprint → RabiTech: What Fits, What Doesn't, What's Next

Companion to [ROADMAP-REMAINING.md](ROADMAP-REMAINING.md), which stays the authoritative
list of committed work. This file maps the Respond.io architecture blueprint onto
RabiTech's **verified** current state (audited 2026-08-20 against the live schema,
module tree, and running containers) and says plainly which parts to build, which to
defer, and which to drop.

The blueprint is a good description of Respond.io. It is not automatically a good plan
for RabiTech, because it describes a mature product at scale and RabiTech is
pre-first-paying-customer. The gap between those two is where money gets wasted.

---

## 1. Verdict up front

**You already have ~55% of the blueprint's *operational* surface** — inbox, threading,
assignment, notes, snippets, broadcasts, RBAC, audit, multi-tenancy, usage metering,
billing. That's the expensive half and it works.

**The genuinely missing, genuinely valuable piece is the Visual Workflow Engine.** It is
the single feature that most defines Respond.io and the one prospects will ask about. It
is also the only Phase in the blueprint I'd fund at full scope.

**Three parts of the blueprint would actively hurt you right now**: the multi-datastore
persistence layer, the omnichannel adapter fan-out, and the light-canvas re-theme. Details
in §3.

---

## 2. Blueprint → RabiTech mapping

Verified against `prisma/schema.prisma` (35 models) and `src/modules/` (15 modules).

### Already built

| Blueprint capability | RabiTech reality |
|---|---|
| Unified inbox, linear timeline | `Conversation` + `Message`, three-pane inbox UI |
| Conversation state machine | `ConversationStatus` OPEN/PENDING/RESOLVED + `conversation-session.ts` |
| Manual transfer, Round-Robin, Least Busy | `modules/routing/assignment.service.ts` — both strategies + workload caps |
| Private internal notes | `Message.isInternal` |
| Canned responses / `/snippet` | `MessageTemplate.shortCode`, composer popover |
| Dynamic variable insertion | `utils/template.ts` |
| Voice note player | Implemented; `/media-proxy` sniffs magic bytes (OpenWA lies about OGG MIME) |
| Custom Fields Registry | `CustomFieldDefinition` + `CustomFieldValue` — **schema done, UI thin** |
| Tags | `Tag` + `ContactTag` |
| Mass broadcast + throttling | `campaign.worker.ts`, ~1.2s inter-send delay |
| CSV import with mapping | `modules/contacts` |
| WebSocket rooms per workspace/team/agent | `socket/index.ts` — `dept:*`, `conv:*`, `user:*`, `group:*` |
| Roles & permissions | `rbac.middleware.ts`, ADMIN→SUPERVISOR→AGENT→VIEWER/FINANCE |
| Operating-hours evaluator | `utils/working-hours.ts`, `utils/out-of-hours.ts` |
| Audit log | `AuditLog` + `PlatformAuditLog` |
| Org/workspace/user tables, encrypted channel tokens | `Organization`, `OrganizationChannel`, `lib/credential-crypto.ts` |
| Rate limiter | `middleware/rate-limit.middleware.ts` |
| FRT / resolution / CSAT reporting | `modules/analytics` + `CsatSurveyResponse` |

**Beyond the blueprint** (you have these, Respond.io's public docs don't emphasise them):
per-tenant gateway provisioning, fail-closed `AsyncLocalStorage` tenant isolation, usage
metering with exact MAC, provider-agnostic billing, platform owner read-only tenant view.

### Partially built

| Capability | Gap |
|---|---|
| Custom fields | Tables exist; no admin UI to define them, no rendering in contact panel |
| Segments | No `Segment` model. `lib/contact-filter-dsl.ts` exists — the filter grammar is there, it just isn't saved/named/reusable |
| Analytics | Agent + CSAT metrics exist; no SLA compliance, no channel-volume charts |
| Identity resolution | Contacts upsert by phone; **no cross-channel merge, no dedupe prompt** |

### Not built at all

| Capability | Model count |
|---|---|
| Visual Workflow Engine (DAG, nodes, canvas) | `Workflow` = 0 |
| AI / RAG / knowledge base | `KnowledgeBase` = 0, `Embedding` = 0 |
| Saved segments | `Segment` = 0 |
| Non-WhatsApp channels | zero adapters found for Telegram/Messenger/Instagram/Twilio |

---

## 3. Three decisions to make before writing code

> **Decided 2026-08-20: the full Respond.io look was adopted.** §3.1 below is kept
> as the record of the decision. What shipped:
> - `globals.css` rewritten to the light canvas (`#F8FAFC`), navy nav (`#0F172A`),
>   blue primary (`#0066FF`), plus status and per-channel tokens.
> - **The token swap alone did nothing.** `lib/branding.ts` injects
>   `--primary` as an inline custom property at runtime, and its default was still
>   Electric Violet — an inline style beats the stylesheet, so the theme silently
>   did not change. That default must track `globals.css`.
> - Semantic tokens are deliberately **darker than the canonical hexes**:
>   `#10B981` / `#F59E0B` / `#EF4444` land at 2.2–3.8:1 on white and fail AA as
>   text. `--success` / `--warning` / `--danger` are the text-safe shades;
>   `--*-vivid` keeps the bright hues for fills and dots.
> - `STATUS_CONFIG.OPEN` was **red**, which read as an error for what is simply the
>   normal working state. It is now blue.
> - Avatars moved from a 12% same-hue tint to a solid fill with a white initial
>   (the tint left initials at ~2.9:1).
> - Contrast verified in-browser by compositing every ancestor tint: **0 failures
>   on /inbox and /reports**. /settings retains a few inside the branding *preview*,
>   which intentionally renders the tenant's own chosen colours.
>
> Deliberately kept: the WhatsApp preview bubble in the campaign composer stays
> `#0b141a`/`#005c4b` — it is a facsimile of WhatsApp, not app chrome.

### 3.1 The palette — cheaper than it looks, but it is a real choice

Your current theme is **dark-first**: background `#060810`, primary **Electric Violet
`#8B5CF6`**, Cairo font, RTL. The blueprint specifies a **light canvas** (`#F8FAFC`) with
dark navy nav (`#0F172A`) and primary **blue `#0066FF`**.

The good news: `app/globals.css` already defines everything as shadcn-style HSL custom
properties (`--background`, `--primary`, `--surface-1…3`). **A theme flip is a token swap,
not a component rewrite.**

My recommendation — split it:

- **Adopt now (cheap, high value):** the *functional* and *channel* tokens. Success
  `#10B981`, Warning `#F59E0B`, Error `#EF4444`, Muted `#64748B`, internal-note yellow,
  and the per-channel brand colors (WhatsApp `#25D366`, Telegram `#229ED9`, …). These add
  meaning your UI currently lacks and don't fight your dark theme. Channel tokens become
  necessary the moment you add a second channel.
- **Defer the canvas flip.** Going light is a *branding* decision, not a technical one.
  Copying Respond.io's exact palette makes you look like a Respond.io clone, which is a
  weak position when you're selling against them. Your violet-on-near-black is
  differentiated and already built. Revisit only if customers ask.
- **Don't half-flip.** Mixing a light canvas into a dark shell is the one outcome that
  will genuinely look broken.

### 3.2 The persistence layer — do not do this

The blueprint calls for PostgreSQL **+ MongoDB/TimescaleDB + a vector DB + Redis Cluster**.

Adopting that now would be a serious mistake. You have one Postgres with hard-won
multi-tenant isolation (composite FKs, fail-closed scoping, a tenancy gate test suite).
Splitting messages into Mongo means **re-implementing that isolation in a second store
with different guarantees**, and every cross-store query loses transactionality.

Postgres handles your message volume for years. When you need it:
- time-series pressure → `pg_partman` partitioning on `Message`, or TimescaleDB *as a
  Postgres extension* (same database, same isolation)
- RAG → `pgvector`, not Pinecone/Qdrant

Revisit only on a measured bottleneck. One datastore is a competitive advantage at your
stage, not a limitation.

### 3.3 OpenWA vs WhatsApp Cloud API — the blueprint quietly assumes a migration

The blueprint's ingestion layer is built on **official Meta Cloud API** with HMAC webhook
validation. You run **OpenWA**, an unofficial library driving WhatsApp Web.

This matters commercially, not just technically:

| | OpenWA (today) | Cloud API (blueprint) |
|---|---|---|
| Account ban risk | Real — it's unofficial | None |
| Per-tenant cost | A container each | Meta conversation pricing |
| Template approval | N/A | Required |
| Enterprise sale | Hard to defend | Expected |
| Setup | QR scan | Business verification |

You cannot sell to a serious business on infrastructure that risks their WhatsApp number.
**Plan the Cloud API adapter as a first-class channel, keep OpenWA for SMB/self-serve.**
Your `OrganizationChannel` model already has room for this. That's a Phase of its own and
it is arguably worth more revenue than the workflow engine.

---

## 4. Recommended sequencing

Replaces the blueprint's Weeks 1–24, reordered by *revenue impact given what already
exists*. Phase numbering continues from ROADMAP-REMAINING.md.

**A. Custom fields + segments UI** — smallest effort, immediate demo value. Tables and
filter DSL already exist; this is mostly UI plus a `Segment` model. Unblocks targeted
broadcasts, which is what buyers actually evaluate.

**B. Visual Workflow Engine** — the flagship. Build in this order:
1. `Workflow` / `WorkflowNode` / `WorkflowRun` schema (DAG as JSON, runs as rows so pauses survive restarts)
2. Execution engine as a BullMQ worker — reuse the existing queue infra. Handle `Ask a Question` and `Wait` as **suspended runs**, not held processes.
3. Node set, in value order: `Send Message` → `If/Else` → `Assign` → `Date & Time Branch` → `Update Contact` → `Close Conversation` → `Ask a Question` → `HTTP Request`
4. React Flow canvas last — the engine is testable without it, the canvas is worthless without the engine

Everything in this phase already has a home: triggers map to your Socket events, assignment
reuses `assignment.service.ts`, hours reuse `working-hours.ts`.

**C. WhatsApp Cloud API adapter** — see §3.3. Gate on whether you're selling SMB or enterprise first.

**D. Identity resolution / contact merge** — required before a second channel exists, pointless before that. Sequence it *with* the channel work, not before.

**E. AI / RAG** — `pgvector` + document ingestion + AI-assist drafting. Deliberately last: it's the most demoed and least load-bearing feature in this category, and it's worthless without the workflow engine to host the AI node.

**Not scheduled:** MongoDB/TimescaleDB/Pinecone (§3.2), light-canvas re-theme (§3.1),
Zapier/Make nodes (build the generic `HTTP Request` node — it subsumes both).

---

## 5. What I'd drop from the blueprint entirely

- **`Random Split` A/B node** — no volume to make it meaningful; add when a customer asks.
- **GraphQL public API** — you have REST. Two API surfaces is two things to secure and version.
- **Skill-based routing** — round-robin and least-open cover real teams until roughly 20+ agents.
- **Separate Zapier + Make nodes** — one `HTTP Request` node plus outbound webhooks covers both.

---

## 6. Open questions for you

1. **SMB self-serve or enterprise sales first?** Decides whether §3.3 comes before or after the workflow engine.
2. **Is a second channel actually on the roadmap**, or is "omnichannel" aspirational? It changes whether identity-resolution work is urgent or premature.
3. **Do you want to look like Respond.io, or unlike them?** §3.1 hinges entirely on this and it's a positioning call, not a technical one.
