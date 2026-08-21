# RabiTech — TODO

Execution checklist derived from [PROJECT-SPEC.md](PROJECT-SPEC.md) §6.
Work top to bottom. A box is ticked only when its **verify** line has been run
and passed — never on "code written".

Standing gate for every phase:
`npx tsc --noEmit -p apps/backend` · `npm run test:tenancy` (45/45) ·
frontend build · deploy · live check. New tables get `organizationId` +
composite FK `[id, organizationId]`. New env vars go into `docker-compose.yml`
explicitly or they don't exist in the container.

---

## 🔴 P-OWNER — only you can do these (blocks paying clients)

- [ ] **O1. Rotate the database password**
  run the `ALTER USER admin WITH PASSWORD …` command (see SECURITY-ROTATION),
  update `POSTGRES_PASSWORD` + `DATABASE_URL` in `.env`, restart stack
- [ ] **O2. Rotate `OPENWA_API_KEY`** off `dev-admin-key` in `.env` (+ restart)
- [ ] **O3. Set `ALLOW_INSECURE_SECRETS=0`** — verify: boot log no longer shows
  `RUNNING WITH INSECURE SECRETS`
- [ ] **O4. Domain + VPS + TLS** — reverse proxy (Caddy/nginx) in front of
  frontend + backend; set `FRONTEND_URL`, `APP_BASE_URL`, `FRONTEND_PUBLIC_URL`
  to the https origin — verify: login over https, socket connects
- [ ] **O5. Decide payments**: merchant-of-record (Paddle/LemonSqueezy — no VAT
  work) vs direct (Stripe/Israeli gateway — needs entity + VAT) → unblocks P10-b
- [ ] **O6. ToS + privacy policy** drafted and linked from `/pricing` + `/signup`

---

## P8-b — Tenant subscription panel · ~3 days

- [x] **1. Backend: `GET /api/billing/summary`** (tenant-scoped): plan name +
  code, price, period end, MAC used/limit (from usage service), invoice list
  via `provider.listInvoices(customerRef)`
  — **done 2026-08-20.** Verified: FREE org returns plan FREE, seats 7/1
  atLimit, six usage meters, entitlements, invoices, plans. One call rather
  than three so the panel cannot render a stale meter beside a new plan name.
  — **Bonus: `quotaDrift` detection.** `Organization.tier` and
  `OrganizationConfig` are two stores that can silently diverge, and
  enforcement follows the config — so a tenant can keep quotas they no longer
  pay for. Proven both ways: injected drift reported
  `{planAllows:100, enforced:10000}`, cleared to `[]` on repair; ENTERPRISE
  unlimited-sentinel path also `[]`.
  — **Repaired live data**: rabitech-demo was FREE tier holding GROWTH quotas
  (2500/10000/5000), left over from an earlier webhook test. Now 100/100/0.
- [x] **2. Settings "الاشتراك" card** in the `usage` section: plan badge, MAC
  progress bar, invoice table (date/amount/status/hosted link), upgrade CTA
  (→ `/pricing` until payments live)
  — **done 2026-08-20.** `components/settings/subscription-card.tsx`, its own
  `#subscription` section above the existing usage meters (deliberately does not
  repeat them). Shows plan + price + renewal, seats with at-limit warning,
  invoice list, upgrade CTA hidden on ENTERPRISE, quotaDrift banner, and the
  downgrade-grace notice. `/billing` now redirects here rather than to `usage`.
  — Verified in browser: FREE org renders "Free / مجاني / 7 / 1 / وصلت للحد
  الأقصى / لا توجد فواتير بعد", and the same card in en/he.
- [x] **3. Gated-features-shown-not-hidden**: central `useEntitlements()` hook
  reading plan from `/api/billing/summary`
  — **done 2026-08-21.** `lib/entitlements.tsx`: provider mounted in the
  dashboard layout so one fetch serves every page. Gates `broadcasts`,
  `customDomain`, `whiteLabel`, `autoGateway`. **Fails open** while loading or
  on error — hiding UI on a failed fetch would look like a broken product, and
  the server is the real gate.
  — Verified: FREE → campaignSends 0 = GATED, all flags false;
  ENTERPRISE → campaignSends null = ALLOWED, all flags true.
- [x] **4. Apply to Broadcasts**: FREE tenant sees the campaigns page with an
  upsell panel "البث — متوفر في باقة Growth" + upgrade button, NOT a missing
  nav item; server still enforces via `assertMetricAvailable` (never trust UI)
  — **done 2026-08-21.** `components/upgrade-gate.tsx` wraps the campaigns page.
  Browser as FREE org: nav still lists البث, page renders
  "البث — متوفر في باقة Growth" + description + "باقتك الحالية: Free" + CTA.
  — **Server enforcement proven independently.** Ran `assertMetricAvailable`
  in tenant scope inside the container rather than through the send route,
  because the demo org is linked to a real WhatsApp number and a broken gate
  would have messaged real contacts. Both qty=1 and qty=8 returned
  `USAGE_QUOTA_EXCEEDED`; nothing was sent.
- [x] **5. Docs**: tick this block in TODO, update spec ledger — done 2026-08-21.

## P9 — Platform owner pricing control · ~1 week

- [ ] **1. Migration**: `Organization` + `planOverride`, `macQuotaOverride`,
  `discountPercent`, `creditCents`, `overrideReason`, `overrideExpiresAt`
  (hand-written SQL, `prisma generate`, `migrate deploy`)
- [ ] **2. Entitlement resolution honors overrides** in one place
  (`plans.ts` resolver: override → subscription plan → tier), incl. expiry
  — verify: tenancy gate still 45/45 + unit check on resolver
- [ ] **3. `PATCH /api/platform/subscribers/:id/commercials`**
  (requirePlatformOwner) writes overrides + `PlatformAuditLog` row
  — verify: curl sets a MAC override; audit row exists
- [ ] **4. Console UI**: "Commercial terms" dialog per subscriber — plan
  override select, MAC quota, discount %, credit, reason (required), expiry
  — verify: set override in browser → tenant's `/api/usage/seats` + meters
  reflect it
- [ ] **5. Billing summary (tenant side) shows effective values**, marked
  "عرض خاص" when overridden — verify in browser

## P10-a — Saved segments · ~4 days

- [ ] **1. Migration**: `Segment` model (id, organizationId, name, filter Json,
  createdById, timestamps; composite FK; unique `[organizationId, name]`)
- [ ] **2. CRUD routes** `/api/segments` (list/create/rename/delete;
  `requirePermission('contact:read'/'contact:manage')`)
  — verify: curl round-trip; cross-org id returns 404
- [ ] **3. Contacts page**: "حفظ كشريحة" on the filter builder; segment chips
  to load a saved filter — verify in browser
- [ ] **4. Campaign Target step**: segment picker alongside the builder;
  audience preview uses the segment's filter
  — verify: saved segment shows same live count in composer
- [ ] **5. Tenancy**: add harness case — segment from org A invisible to org B
  — verify: gate 46/46

## P10-b — Payments live · ~1 week · **blocked on O5**

- [ ] **1. Provider class** implementing `PaymentProvider`
  (map events → `PaymentEventKind` per BILLING-PROVIDER-GUIDE — the table for
  Stripe is already written; `organizationId` travels in provider metadata)
- [ ] **2. Registry line** + env (`PAYMENT_PROVIDER`, provider keys, webhook
  secret) in `.env` **and** compose
- [ ] **3. Point provider webhook** at `https://<domain>/api/billing/webhook`
  (needs O4) — verify: provider test event → 200 `{processed:true}`
- [ ] **4. Sandbox purchase end-to-end**
  — verify: checkout → tier flips → gateway provision queued, zero manual steps
- [ ] **5. Replace `/contact-us-to-activate`** copy with real checkout redirect;
  wire upgrade CTA from P8-b to `createCheckout`
- [ ] **6. Failure paths**: sandbox `payment_failed` → PAST_DUE;
  `subscription_canceled` → cancel — verify both

## P11 — Visual workflow builder · 6–8 weeks · **flagship**

Engine before canvas. Reuse: socket events as triggers, assignment service,
working-hours util. Skip (documented): Random Split, Zapier/Make nodes, GraphQL.

- [ ] **1. Schema migration**: `Workflow` (name, status, trigger, graph Json),
  `WorkflowRun` (workflowId, conversationId/contactId, currentNodeId, state
  Json, status RUNNING|WAITING|DONE|FAILED, wakeAt), composite FKs
- [ ] **2. Executor worker** (BullMQ): walk graph from trigger payload;
  `Ask a Question`/`Wait` = persist run WAITING + return (no held process);
  scheduler-style scan resumes runs whose `wakeAt` passed or whose
  conversation got a reply
  — verify: run survives `docker compose restart backend` mid-wait
- [ ] **3. Trigger wiring**: inbound-message + conversation-opened/closed +
  tag-added hooks enqueue matching workflows (org-scoped lookup, cached)
- [ ] **4. Nodes, in value order** (each lands with an executor test):
  - [ ] Send Message (template/variable interpolation; resolve-or-silent law)
  - [ ] If/Else multi-branch (equals/contains/isSet/regex on contact+context)
  - [ ] Assign (agent/team/round-robin via existing service)
  - [ ] Date & Time branch (working-hours util)
  - [ ] Update Contact (tags, fields, lifecycle)
  - [ ] Close Conversation
  - [ ] Ask a Question (wait + validate email/phone/number + write field)
  - [ ] HTTP Request (GET/POST/PUT/DELETE, bearer/basic, JSON body builder,
    response→variable mapping, exponential backoff, **SSRF-guarded**)
- [ ] **5. Run log**: per-run timeline (node, input, output, ts) for debugging
  — verify: failed HTTP node shows attempt trail
- [ ] **6. Canvas UI (React Flow)**: drag nodes, connect edges, config side
  panel, validation (no orphan nodes, one trigger), enable/disable workflow
  — verify DoD: admin builds "new conversation outside hours → template X,
  assign team Y, tag Z" on canvas; it executes; survives restart mid-wait
- [ ] **7. Tenancy harness cases** for Workflow/WorkflowRun — gate green
- [ ] **8. Entitlement**: workflows count gated per plan (`plans.ts`)

## P12 — WhatsApp Cloud API channel · ~4–5 weeks · after P11

- [ ] **1. Provider abstraction**: extract `MessagingChannel` interface from
  OpenWA service (send/media/status/webhook-verify)
- [ ] **2. CloudApiChannel**: Meta Graph send, HMAC webhook verify, template
  send, 24-h window check before free-form send
- [ ] **3. `OrganizationChannel.kind = CLOUD_API`** onboarding UI (token,
  phone-number id, webhook verify token; encrypted via credential-crypto)
- [ ] **4. Identity resolution / contact merge** (same phone across channels →
  one contact; merge prompt) — lands *with* this phase, not before
- [ ] **5. Routing**: conversation remembers its channel; replies go out the
  same channel; campaigns pick channel per session
- [ ] **6. Channel badges** in inbox/list using `--ch-*` tokens (already themed)

## P13 — AI / RAG · last

- [ ] **1. `pgvector` extension** migration (same DB — no external vector store)
- [ ] **2. KnowledgeDoc ingestion**: upload PDF/TXT/URL → chunk → embed →
  org-scoped vectors
- [ ] **3. AI-assist drafting** in composer (suggest reply from history + KB;
  agent reviews, one click to send — never auto-send)
- [ ] **4. AI node** in P11 engine (classify intent / generate reply with
  fallback-to-human threshold)
- [ ] **5. Metering**: `ai_tokens_in/out` already in usage enum — wire and gate
  per plan

---

## 🔧 Continuous hardening (slot between phases)

- [ ] **H1. Gateway health monitor**: scheduled self-send every 15 min +
  `PlatformAlert` on failure — kills the "customer discovers the outage" mode
  (runbook: this WILL break again)
- [ ] **H2. Per-org campaign rate limits** (plan-aware): queue-per-org or Redis
  token bucket — BullMQ group limiting is Pro-only, so not a one-liner
- [ ] **H3. Reports onto `PlatformDailyMetric` rollups** (scale, not
  correctness)
- [ ] **H4. Custom-field editing** in the inbox contact panel
- [ ] **H5. @mentions in internal notes** (+ notification fan-out)
- [ ] **H6. Backup job**: nightly `pg_dump` to `.tools/backups` + retention

---

*When a box is ticked: note the date + verify evidence inline, and mirror the
change into PROJECT-SPEC.md §6. This file is the working surface; the spec is
the record.*

---

# Marasil-parity phases

Derived from [MARASIL-SPEC-FIT.md](MARASIL-SPEC-FIT.md). Meta-only requirements
(24-h window, template approval, quality ratings, cost estimation, Embedded
Signup) are **deliberately excluded** — they do not exist on OpenWA. What remains
is ordered by value, cheapest-liability-first.

## M1 — Consent & opt-out · ~1 day · 🔴 **liability, do first**

Marasil FR-16.6 / BR-16.2. On Meta the platform enforces some of this; on OpenWA
**nothing does**, so today a tenant can broadcast to a contact who has said STOP.

- [x] **1. Migration**: `Contact.marketingConsent` enum
  (`UNKNOWN|OPTED_IN|OPTED_OUT`, default `UNKNOWN`), `consentSource`,
  `consentUpdatedAt`; index `[organizationId, marketingConsent]`
- [x] **2. Opt-out keywords**: org-configurable list, seeded
  `STOP / UNSUBSCRIBE / توقف / إلغاء / הפסק`, matched case-insensitively on
  inbound text in the existing worker (beside the CSAT intercept)
  — verify: send "STOP" through the webhook → contact flips to `OPTED_OUT`
- [x] **3. Broadcast exclusion**: `audienceWhere()` excludes `OPTED_OUT`
  **unconditionally** — no override flag, per BR-16.2
  — verify: opted-out contact disappears from the live audience count
- [x] **4. Exclusion transparency** (Marasil UX bet #4, "explain every
  exclusion"): the composer's Review step reports "N excluded (opted out)"
  rather than silently shrinking the number
- [x] **5. Contact panel**: consent state visible and manually settable
  — the CSV-import half is carried forward: **RabiTech has no contact import**
  (no route, no parser dependency, no UI), so the opt-in declaration has nothing
  to attach to yet. Recorded as a blocking requirement on M8.3.
- [x] **6. Tenancy**: harness case — consent state is org-scoped

**M1 evidence (2026-08-21).** Migrations `..._contact_marketing_consent` and
`..._consent_confirm_autoreplies`. `utils/consent.ts` matches opt-out keywords on
the **whole trimmed message**, never as a substring — "stop" inside "please
don't stop sending offers" is not an opt-out, and treating it as one would mute a
customer who wanted the opposite. Covers en/ar/he, plus opt-in so a customer can
undo without contacting support.

Wired into the inbound worker **ahead of** the CSAT and keyword paths, so someone
who types STOP cannot receive a keyword auto-reply in the same breath.
Confirmation fires only on an actual *change* — repeating the unsubscribe notice
every time someone types STOP again is the noise opt-out exists to stop.

Verified live through the real webhook: STOP → `OPTED_OUT` / `keyword`, and only
in that organization (an identical phone number in the other tenant was
untouched). Audience preview 8 → 7 with `excludedOptedOut: 1`; campaign create
materialised 7 recipients, not 8. Tenancy gate **45/45**. All test data restored.

`OPT_OUT_CONFIRM` / `OPT_IN_CONFIRM` seed **active**, unlike the other optional
auto-replies: a customer who asks to stop should be told it worked, because
silence reads as being ignored and is what makes people report the number.

**M1.5 / M1.6 evidence (2026-08-21).** `PATCH /api/contacts/:id` gained a
*separate* consent branch rather than an entry in `contactPayload()`'s allow-list:
consent must record `consentSource` and `consentUpdatedAt`, which a blind field
copy would not do. Verified live — `"BOGUS"` → 400, `OPTED_OUT` → 200 and the row
reads `OPTED_OUT | agent | <timestamp>`, then restored to `UNKNOWN`. Zero residue.

The panel shows consent to **every** agent, not just admins: whoever is in the
conversation is the person told "stop sending me these", and they need to honour
it in that moment. `OPTED_OUT` also draws a warning line so nobody plans a
broadcast around a contact who will be silently dropped from it.

Tenancy gate **45/45 → 46/46**. The new case proves three things, not one: org A's
opt-out persists with source `agent`; org B's contact is untouched; and org A
calling `setContactConsent` with an org B contact id **rejects** rather than
silently succeeding. It then checks the audience count moves by exactly one in
org A and not at all in org B — counts are taken relative to a baseline, because
hardcoding fixture sizes is how a harness starts failing for the wrong reason.

## M2 — RTL correctness · ~0.5 day · serves the core market daily

Marasil §32.2. Their headline differentiator, and we measurably fail parts of it.

- [x] **1. Per-message direction detection** — first-strong-character detection
  sets `dir` per message bubble, so a Hebrew customer's one English sentence
  renders LTR inside an RTL interface
  — verify: mixed-direction messages render correctly in one thread
- [x] **2. Bidi isolation** — phone numbers, IDs and timestamps wrapped so they
  never reorder inside RTL text ("the single most common bidi bug")
- [x] **3. Physical→logical CSS** — fix the app-level offenders (`pr-9` on the
  contacts and inbox search inputs, `ml-1` in inbox/reports)
  — verify: search icon on the correct side in both directions
- [x] **4. Tabular figures** for phone numbers and IDs so columns align

**M2 evidence (2026-08-21).** `lib/text-direction.ts` implements the Unicode
first-strong heuristic: scan for the first strongly-directional character,
treating digits, punctuation and emoji as neutral and skipping them. Applied to
message bubbles and to conversation-list previews.

Logic verified across 9 cases, all passing — including neutrals-skipped
("!!! Hello" is LTR, "??? مرحبا" is RTL) and first-strong-wins ("Ahmad قال hello"
is LTR, "قال Ahmad hello" is RTL).

**Proven live, which is the point:** with the interface switched to English
(`documentElement.dir = ltr`), an Arabic message still renders `dir="rtl"`.
Direction follows the message's own content rather than the interface language —
the exact defect the Marasil spec criticises respond.io for.

Bidi isolation: `dir` already implies `unicode-bidi: isolate` in modern browsers,
so the 31 existing `dir="ltr"` sites were already isolating. A `.bidi-isolate`
utility and an `isolate()` FSI/PDI helper are available for strings built by
interpolation, where there is no element to carry `dir`.

Logical properties: the search icon's `right-3` + `pr-9` became `start-3` +
`ps-9`, which keeps it on the right in RTL and moves it to the conventional left
in LTR; `ml-*` before icon labels became `me-*`. What remains physical is shadcn
primitives shipping their own defaults.

Tabular figures via a `.numeric` utility on phone numbers so digit columns align
— confirmed live on the contact panel (`numeric font-mono`).


## M3 — Filter vocabulary · ~3 days · the campaign feature that sells

Marasil §14.4. Ours: 3 categories × 6 operators. Theirs: ~20 dimensions.

- [ ] **1. Type-aware operators**: date (`within_last N`, `more_than_N_ago`,
  `between`), number (`>`, `<`, `between`), multi-select (`has_any_of`,
  `has_all_of`, `has_none_of`), text (`ends_with`, `matches_regex`)
- [ ] **2. New dimensions**: `lifecycleStage`, `assignedUser`, `assignedTeam`,
  `createdAt`, `lastInboundAt`, `lastOutboundAt`, `hasEverReplied`,
  `conversationCount`, `marketingConsent`
- [ ] **3. Broadcast-history dimensions** — *"received the July promo but never
  replied"*, which the spec calls the single most common marketing request and
  which our current six filters cannot express. Data already exists on
  `CampaignRecipient`.
- [ ] **4. Nested groups to depth 3** with AND/OR toggles (ours is flat `$and`)
- [ ] **5. Estimated counts** above a threshold, labelled `~4,200 (estimated)`

## M4 — Dark theme · ~1 day · fixes a regression we introduced

Marasil §30.1: both themes at v1, same token names, separate palette. *"Dark is
not an afterthought"* — respond.io runs dark and 8-hour agents prefer it. We
dropped dark when flipping to the light palette.

- [ ] **1. Dark palette** under the same token names + `prefers-color-scheme`
- [ ] **2. Theme toggle** (light / dark / system) persisted per user
- [ ] **3. Contrast audit in dark** — same zero-failure bar as light
- [ ] **4. Nav rail** re-tuned: on a dark canvas it needs a different treatment
  from navy-on-white

## M5 — Design system hardening · ~1 day

- [ ] **1. Type scale tokens** (display/h1/h2/h3/body/body-strong/small/micro/mono)
  replacing ad-hoc `text-[11px]` literals
- [ ] **2. Motion tokens** — 120ms micro / 200ms panel / 300ms modal,
  `cubic-bezier(0.2,0,0,1)`, honouring `prefers-reduced-motion`
- [ ] **3. Two densities** — operator surfaces (inbox/contacts) dense; config
  surfaces (settings/reports) spacious
- [ ] **4. Named empty states** per situation, "all caught up" deliberately quiet

## M6 — Inbox structure · ~1 week

Marasil §29.1: 56 / 240 / 320 / flex / 340.

- [ ] **1. Inbox-selector column**: system inboxes (All / Mine / Unassigned /
  Mentions / Snoozed) with live counts
- [ ] **2. Lifecycle stages** as a configurable pipeline, surfaced as inbox
  filters with counts
- [ ] **3. Custom inboxes** — saved views, the filter grammar's fourth consumer
- [ ] **4. Contact panel tabs** — Details / Conversations / Files / Activity
  (horizontal at the bottom; short labels beat icons for infrequent actions)
- [ ] **5. Session-health bar** on each conversation row — our analogue of their
  service-window bar
- [ ] **6. @mentions** + a Mentions inbox

## M7 — Reports consolidation · ~1 week

Marasil §20: five surfaces, each answering one question. We have one page.

- [ ] **1. Overview** — headline tiles with sparklines and period deltas
- [ ] **2. Conversations** — response and resolution distributions
- [ ] **3. Team** — workload and leaderboard
- [ ] **4. Campaigns** — per-broadcast performance
- [ ] **5. Gateway health** — our replacement for their "account health & cost":
  session state, failed-send rate, webhook delivery
- [ ] **6. Drill-down from every number** to the underlying conversations —
  *"a manager who cannot click a number to see what it is made of will not
  believe it"*
- [ ] **7. Volume by hour-of-day heatmap** (their staffing-decision chart)

## M8 — Roles, restrictions, admin · ~3 days

- [ ] **1. Granular restrictions** over roles: restrict data export, contact
  deletion, workspace settings, integration settings
- [ ] **2. Role-aware navigation** — agents see three destinations, not five
- [ ] **3. CSV import — build it** (it does not exist: no route, no parser
  dependency, no UI; the only way contacts enter RabiTech today is by messaging
  in). Fuzzy column mapping, validation preview, duplicate strategy,
  `imported_{ts}` tag, live progress — and a **mandatory opt-in declaration**
  writing `consentSource: 'import'`, which is the M1.5 carry-forward and is not
  optional: bulk-loading a purchased list into a broadcast tool is precisely the
  liability M1 exists to prevent.
- [ ] **4. Quiet hours** enforced in the recipient's local time from phone prefix
- [ ] **5. Broadcast clone**
