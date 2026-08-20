# RabiTech — Remaining Roadmap

**Authoritative list of what is left.** Updated 2026-08-20 after Phase 3.
Every phase below is self-contained: hand it to an agent with §0 and §1 and it can execute.

---

## 0. Standing rules (apply to every phase)

1. **Fail closed.** Missing tenant context on a tenant-scoped model must throw, never fall through.
2. **Nothing customer-facing is hardcoded.** Every message a subscriber's customer can receive
   resolves from an organization-owned row. If unconfigured → **send nothing**. Defaults live in
   provisioning seed data (`src/constants/default-auto-replies.ts`), never as runtime fallbacks.
3. **No platform branding in tenant-facing output.** A subscriber's customers must never see
   "RabiTech". Signatures come from `OrganizationBranding.productName`.
4. **Every new table** gets `organizationId` **and** composite FKs `[id, organizationId]`, so a
   cross-org write is rejected by the database, not by app logic.
5. Migrations are hand-written SQL under `apps/backend/prisma/migrations/<ts>_<name>/`.
6. Arabic copy stays Palestinian/Arab48 colloquial (`أهلين` not `مرحباً`, `شو` not `ماذا`).
7. Frontend uses logical CSS properties (`inline-start`/`inline-end`), never `left`/`right`.
8. **404, not 403,** for cross-tenant resource requests.

**Gate for every phase:**
```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/backend && npm run test:tenancy      # must stay at 45+
cd apps/frontend && npm run build
```
Back up first: `.tools/backups/rabitech-before-<phase>-<date>.dump`

**Two hard-won cautions:**
- **Never use `perl -0pi` with Arabic/emoji in the pattern.** It silently ate
  `inbox/page.tsx` whole. Use the Edit tool for non-ASCII.
- **`inbox/page.tsx` resists line-based edits** — it contains ~80 lines of unreachable JSX
  (`PREDEFINED_LABELS` is an empty array gating an entire filter row; a dead department switcher
  maps over `[]`). Use exact-match edits, or decompose it first (Phase 6).

---

## 1. Where things stand

**Done:** P0 hardening · P1-A→E tenancy · P1.5 branding · P3 metering · P6 billing foundation
(provider-agnostic) · configurable auto-replies · Groups deleted · ISP domain deleted.

**Live state:** 2 organizations, 45/45 isolation checks, backend + frontend healthy.

**Still ISP-free-but-unfinished:** navigation is 8 items where Respond.io has 5; Settings is a
1,120-line flat scroll; the inbox is a ~1,100-line single component with polling alongside sockets.

---

## PHASE 4 — Navigation & Settings IA · **completed 2026-08-20**

- Nav is the five Respond.io destinations; `/overview`, `/users`, `/billing`,
  `/templates` are redirect stubs.
- **`?tab=` is now honoured.** Those stubs redirect with `?tab=users|billing|templates`
  and nothing read the parameter, so they landed at the top of Settings with no
  sign of where the content went — `/templates` is linked from the composer and
  from Settings itself.
- **Snippet management was missing from the product entirely.** The standalone
  `/templates` page was folded into Settings during the nav rework but its UI was
  never rebuilt: snippets could be *used* from the composer and created nowhere.
  `components/settings/snippets-card.tsx` restores full CRUD — category filter,
  `:shortcode`, per-team scoping, enable/disable. Verified end-to-end:
  create → persisted → `:shortcode` lookup returns it.
- `fetchTemplates` hardcoded `active:true`, so a management screen could never
  show a disabled snippet. Now opt-in via `includeInactive`.

**Still open:** Reports aggregates live tables rather than `PlatformDailyMetric`
rollups. Correctness is fine; this is the scaling concern the original brief
flagged, and it is not urgent at current volume.

---

## PHASE 4 (original brief) — Navigation & Settings IA · ~3 days

Respond.io's IA is **Inbox · Contacts · Broadcasts · Reports · Settings**. We have 8 top-level items.

| Current page | Action |
|---|---|
| `/overview` | → **Reports**. Agent-performance table is its only unique content. |
| Reports content | First Response Time, resolution time, conversation volume, busiest hours, agent leaderboard, tag distribution, CSAT. **Read from `PlatformDailyMetric` rollups, never live tables** — Respond.io's own 100× win came from stopping heavy aggregates against production data. |
| `/templates` | → Settings tab "Snippets" (composer picker already exists) |
| `/users` | → Settings tab "Users". Also kills the dead stub in `settings/page.tsx` that claims users are managed via prisma studio. |
| `/billing` | → Settings tab "Billing & Usage". Merge with the existing usage card. |
| `/campaigns` | → rename **Broadcasts**, stays top-level |

**Settings becomes tabbed:** Branding · Channels · Teams · Users · Snippets · Auto-replies ·
Keywords · Working Hours · Billing & Usage.

**Also:**
- `/platform/subscribers` (338 lines, fully built) has **no nav entry** — unreachable from the UI.
  Surface it for `Identity.platformRole === 'OWNER'` only.
- Build **Settings → Keywords UI**. The API exists (`GET/POST/DELETE /api/system/keywords`,
  `requireSupervisor`) but there is no page, so admins cannot manage their own keywords.

**Files:** `components/app-sidebar.tsx`, `app/(dashboard)/settings/page.tsx`, route moves.

**Done when:** 5 top-level nav items; every admin-configurable thing reachable without an API call;
no dead nav links.

---

## PHASE 5 — Campaign Manager (Broadcasts) · **core delivered 2026-08-20**

**Done:**
- `Campaign.audienceFilter` (JSONB) + migration `20260820135057_campaign_audience_filter`
- `POST /api/campaigns/audience/preview` — live recipient count + sample before send
- `GET /api/campaigns/:id/report` — pending/sent/delivered/read/failed + failure list
- Recipients resolved from the filter DSL at create time (was: every contact, always)
- **Fixed a live outage:** the send route built `jobId` with `:`, which BullMQ rejects —
  every campaign send had been failing. Now `--`, matching every other queue.
- Guards: empty-message send refused; double-send returns 409
- Throttling: enqueue spacing `CAMPAIGN_SEND_SPACING_MS` (default 1200ms) + worker
  limiter `CAMPAIGN_RATE_MAX`/`CAMPAIGN_RATE_DURATION_MS`, concurrency 1
- Scheduled sends: `campaign-scheduler.worker.ts`, scans every 60s, claims conditionally
  (`updateMany` on status) so two instances can't double-dispatch
- UI: 3-step composer (Compose → Target → Review) with live audience count,
  WhatsApp-style preview with `{{variables}}` resolved, schedule picker, delivery report
- Removed surviving ISP hardcoding from the old dialog (`باقة 200 ميجا`, `200 Mbps`, `129`)

- **Delivery tracking wired** (migration `20260820140155_campaign_recipient_delivery`):
  `CampaignRecipient.waMessageId` / `deliveredAt` / `readAt`. The worker records the
  WhatsApp id at send time; the `message.ack` webhook advances the recipient.
  Acks are **monotonic** — WhatsApp redelivers them out of order, so a late duplicate
  can never walk `read` back to `delivered` and corrupt a report.
  Verified through the real webhook: sent→delivered→read, and a replayed `ack=2`
  correctly left `read` untouched.

**Still open in this phase:**
- Per-organization rate limits are not yet plan-aware — the limiter is global to the
  worker. Per-group rate limiting is a BullMQ Pro feature, so this needs either a
  queue per organization or a token bucket in Redis. Not a one-liner.
- CSV upload as a targeting path (filter DSL is the primary path and works).

Original brief follows.

Campaigns are currently a thin list + create dialog. Turn it into a real manager.

**Flow: Compose → Target → Preview → Schedule → Report**

1. **Compose** — reuse the inbox composer (snippet expansion, variable interpolation
   `{{contactName}}`). Not a second implementation.
2. **Target** — segment by `Tag` or `lifecycleStage` using the **existing filter DSL**
   (`lib/contact-filter-dsl.ts`, `components/contacts/contact-filter-builder.tsx`). Show the
   resolved recipient count live before sending. CSV upload as a secondary path.
3. **Preview** — WhatsApp-style bubble preview with variables resolved against a sample contact.
4. **Schedule** — send now or at a future time. Needs a scheduled-send worker.
5. **Report** — per-campaign card: Sent / Delivered / Read / Failed / Replied. `MessageStatus`
   already carries these; wire delivery callbacks through to campaign recipients.

**Throttling is not optional.** The campaign worker currently sends with a fixed delay. A real
broadcast must respect WhatsApp's rate limits or the gateway gets throttled or banned. Configure
BullMQ `limiter: { max, duration }` per organization, and make the cap plan-aware. Also validate
template content before send — a rejected template mid-blast strands half the audience.

**Schema:** add `audienceFilter` (JSON) and `scheduledAt` to `Campaign`; per-recipient status
already exists on `CampaignRecipient`.

**Done when:** an admin can segment by tag, preview, schedule, and read a delivery report without
touching an API.

---

## PHASE 6 — Inbox rebuild (3-pane) · ~3 weeks

`inbox/page.tsx` is ~1,100 lines with ~30 `useState` hooks in one component.

**Decompose into `components/inbox/`:**
`ConversationList` · `ConversationRow` · `MessageThread` · `MessageBubble` · `Composer` ·
`ContactPanel`

**The composer is the highest-value fix.** Today the internal-note toggle is a 28×36px padlock
icon stacked under a **decorative paperclip that has no `onClick` and no file input**. Replace with
a first-class segmented control:

```
┌──────────┬──────────┐
│  Reply   │ Comment  │   ← Comment tints the composer, disables channel send
└──────────┴──────────┘
```

Also: `handleSendDirect` and the quick-template chips always send with `isInternal: false`, so a
template can never be posted as an internal note.

**Contact panel** — exists but is thin. After the ISP purge it needs: editable fields, lifecycle
stage, custom field values (`CustomFieldDefinition` exists but is only consumed by `/contacts`),
inline tag add/remove, conversation history. **Reuse the `/contacts` detail component** rather than
building a second one.

**Remove polling.** `setInterval` at 8s runs alongside sockets that already cover
`new_message`, `new_conversation`, `conversation_resolved`, `unread_update`.

**Delete the dead JSX** while in here: `PREDEFINED_LABELS` and its ~60 lines of unreachable guards,
the dead department switcher, the unused `Pencil` import.

**Close-conversation UX:** ask for a closing `category` + `summary` (already in the schema) —
"context-aware actions" rather than a bare confirm.

---

## PHASE 7 — Auto-assignment · ~1 day · highest value per hour

**Confirmed absent.** `Conversation.assignedToId` exists; nothing ever sets it automatically. Every
conversation sits unassigned until a human claims it.

Respond.io ships exactly two strategies, both checking availability **at assignment time**:
- **Round Robin** — distribute equally across online agents
- **Least Open Conversations** — assign to the online agent with the fewest open

Plus **workload limits**: a per-agent cap on concurrent open conversations (e.g. max 5). An agent
at capacity is skipped by both strategies. Without this, round-robin happily buries your fastest
agent. Store as `Team.maxConcurrentPerAgent` (nullable = unlimited).

`User.isAway` already exists; combine with socket presence. When nobody is available *or everyone
is at capacity*: leave in the team queue and let the existing escalation worker fire. Never
silently drop routing.

Configurable per Team in Settings. Add a harness case proving assignment never crosses organizations.

*Deliberately not building skills-based routing — Respond.io does not ship it, and round-robin plus
least-open covers real usage.*

---

## PHASE 8 — Tenant self-service & plan visibility · **partially delivered 2026-08-20**

**Done:**
- **Seat limits now enforced.** `usersLimit` existed in `plans.ts` but was never checked —
  a FREE tenant (1 seat) could add unlimited agents. `assertSeatAvailable()` in
  `modules/usage/entitlements.ts` now refuses with HTTP **402** + `SEAT_LIMIT_REACHED`
  and an Arabic upgrade prompt. Only **active** users count, so deactivating an agent
  frees the seat — otherwise a tenant could never replace someone who left without paying more.
  The check runs *before* Identity creation, so a refused seat leaves no orphan login
  blocking that email forever. Verified: 402 returned, zero orphan identities,
  ENTERPRISE (`usersLimit: null`) unaffected.
- `GET /api/usage/seats` — used / limit / remaining / atLimit for the current plan.
- **Team management UI** (`components/settings/team-members.tsx`). `createSystemUser`
  existed in the data layer but was called from **nowhere** — there was no way to add an
  agent in the product at all. Now: member list with team + role, add-member dialog,
  delete, and a seat meter that shows the ceiling *before* it is hit. The add button
  disables at limit rather than failing on submit.

- **Automatic activation verified.** A signed provider webhook now upgrades the plan
  *and* queues gateway provisioning with no human step. Proven end-to-end:
  `webhook → 200 → tier FREE→GROWTH → queueGatewayAction('provision')`.
- **Webhook dispatch made provider-agnostic.** It previously branched on literal
  `manual.*` event names, so any real provider would have logged
  "Unhandled payment event type" and activated nobody. Providers now map their own
  vocabulary onto `PaymentEventKind` (`subscription_activated` / `payment_failed` /
  `subscription_canceled`), and an event with no organization is refused rather
  than guessed at.
- **`docker-compose.yml` was not passing several env vars through.** The backend
  block lists them explicitly, and `BACKEND_INTERNAL_URL`, `PAYMENT_*` and the
  campaign throttle settings were all missing — silently falling back to defaults.
- Pricing → signup **already carried the plan code** (roadmap was stale). Signup no
  longer renders it as an editable free-text field accepting any string.
- `/contact-us-to-activate` rewritten: Arabic, RTL, states plainly that online
  payment is not live yet and a person will make contact.
- Payment provider integration is **deliberately deferred** — see
  [BILLING-PROVIDER-GUIDE.md](BILLING-PROVIDER-GUIDE.md). The structure is ready;
  wiring one is a single class plus one line in `provider-registry.ts`.

**Still open in this phase:**
- Subscription panel: live MAC meter, invoice history, upgrade CTA.
- Gated features shown-not-hidden ("Broadcasts — available on Growth" + Upgrade button).
- Tenant-scoped API keys (mint/revoke) — nothing exists yet.
- A real payment provider (blocked on business entity / VAT — a business decision,
  not a technical one).

Original brief follows.

Make the subscriber feel in control rather than dependent on support.

- **Subscription & Usage panel**: live MAC meter ("740 / 1,000 active contacts"), plan name,
  invoice history, one-click upgrade into the P6 checkout.
- **Gated features are shown, not hidden.** A Free-tier admin sees "Broadcasts — available on
  Growth" with an Upgrade button, never a missing menu item. Builds desire instead of confusion.
  Entitlements are already centralized in `modules/billing/plans.ts`.
- **Public pricing page passes the chosen plan code into signup** — the page exists but the plan
  does not carry through to the signup flow.
- **Team management**: add an agent by email, assign to Teams, set role — no support ticket.
- **Seat limits enforced per plan.** We meter MAC but never enforce user count. Adding a user past
  the plan's seat allowance must be blocked with an upgrade prompt, not silently allowed.
- **API keys, self-service.** Tenants can mint and revoke their own API tokens for the public API
  (Respond.io: `Settings > Integrations > Developer API`). Currently there is no key management
  anywhere. Scope keys to the organization; never platform scope.

---

## PHASE 9 — Platform owner pricing control · ~1 week

Today the platform owner can create/suspend subscribers but **cannot vary commercial terms without
editing the database**.

**Schema (Organization):** `planOverride`, `mackQuotaOverride`, `discountPercent`,
`creditCents`, `overrideReason`, `overrideExpiresAt`.

**Console (`/platform/subscribers`):**
- **Custom plan override** — assign a bespoke plan or bump a subscriber's MAC quota
- **Discounts & credits** — apply a percentage discount or account credit reflected in the next cycle
- **Manual activation lifecycle** — see whether a bank transfer cleared, flip
  `MANUAL_REVIEW → ACTIVE` in one click (the ManualProvider already supports activation)

Every override goes through `runAsPlatform` and writes a `PlatformAuditLog` row with the reason.

---

## PHASE 10 — `ContactChannel` + omnichannel · ~4–5 weeks

**The defining Respond.io gap.** Their identity is one contact, many channels, one thread. Ours is
`Contact` welded to one `phone` on one `WhatsappSession`.

Until this ships, the honest pitch is **"a white-label WhatsApp business platform"** — a real,
sellable product. Do not promise omnichannel before it.

1. `ContactChannel` join: one contact ↔ many channels, each with the channel-native address.
2. Rename `WhatsappSession` → `Channel` with a `source` discriminator.
3. **Send routing exactly as Respond.io does:** when no channel is specified, send through the
   contact's **last interacted channel**. Explicit resolver, not implicit fallback; return the
   resolved channel so the composer can display it.
4. Adopt their custom-channel contract (see `RESPOND-IO-PARITY.md` §4.9): **one** send method with
   a typed message union returning the provider's `mId`, and **one** inbound handler taking a
   batch `events[]` envelope. Not one verb per message type.
5. `MockChannelProvider` proving the full flow with zero WhatsApp code in the path.
6. Then one real second channel — **Telegram** (simplest auth, no approval process).
7. Treat **WhatsApp Personal (QR)** and **WhatsApp Business Cloud API** as two providers, not one
   with a flag.

---

## PHASE 11 — Workflow builder · ~6–8 weeks

**Milestone 1, before any UI:** port the existing keyword/auto-reply/working-hours logic into a
workflow definition the engine executes. If the engine cannot express what
`utils/conversation-session.ts` does today, the design is wrong — find out in week 1.

Engine first (nodes, edges, versioned draft/published definitions, durable per-conversation
execution state, awaiting-reply suspension, timeouts), canvas second.

Trigger classes to support (from Respond.io): free-text intent, contact fields, real-time API
lookups, agent online status, contact tier/VIP, channel signals, language, timezone.

---

## Deferred / non-code

- **AI agents** — deferred by product decision. When revisited: Orchestrator + specialized
  micro-agents, not one generalist model. RAG is a **new query surface that bypasses the Prisma
  extension** — needs its own isolation test.
- **Payment provider adapter** — one adapter file once a provider is chosen. Consider Paddle or
  Lemon Squeezy: as merchant of record they handle VAT, which is otherwise a legal blocker.
- **Security blockers — still open, still required before a real client:**
  `POSTGRES_PASSWORD: secret`, **no rate limiting anywhere**, everything on `http://` at a
  hardcoded LAN IP. Agent passwords and customer messages cross the network in plaintext.
- **Custom domain DNS/TLS** — the verification-token API exists; wildcard DNS and certs are yours.
- **Legal** — ToS, privacy policy, DPA, business registration, MENA VAT. Charging money without
  these is exposure, not a technical gap.

---

## Suggested order

**Sell-ready fastest:** 4 → 7 → 8 → security blockers → 5
**Respond.io-parity fastest:** 4 → 6 → 10
**Revenue control fastest:** 8 → 9 → payment adapter

Phase 7 (auto-assignment) is one day and is the most-used feature in any team inbox. It has the
best value-per-hour of anything on this list.
