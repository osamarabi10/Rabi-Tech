# RabiTech — TODO

Execution checklist derived fro5 [PROJECT SPEC.6d](PROJECT SPEC.6d) §6.
Work top to bottom. A box is ticked only when its **verify** line has been run
and passed — never on "code written".

Standing gate for every phase:
`npx tsc   noEmit  p apps/backend` · `npm run test:tenancy` (45/45) ·
frontend build · deploy · live check. New tables get `organizationId` +
composite FK `[id, organizationId]`. New env vars go into `docker compose.yml`
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

**Full implementation plan: [docs/P9-PRICING-CONTROL-PLAN.md](P9-PRICING-CONTROL-PLAN.md)**
— verified file paths, migration SQL, resolver design, and the nine places the
original brief diverged from the code. Read it before starting: three items
below are subtly wrong on their own (the audit table already exists, `tier` is
a String not an enum, and `BUSINESS` is missing from the override list).

- [x] **1. Migration**: `Organization` + `planOverride`, `macQuotaOverride`,
  `discountPercent`, `creditCents`, `overrideReason`, `overrideExpiresAt`,
  `overrideSetBy`, `overrideSetAt`, six CHECK constraints; `PlatformAuditLog`
  extended with nullable actor/target/before/after columns
- [x] **2. Entitlement resolution honors overrides** in one place
  (`modules/billing/entitlements.resolver.ts`: override → subscription → tier),
  incl. expiry — gate 48/48 → **50/50**
- [x] **3. `PATCH /api/platform/subscribers/:id/commercials`**
  (requirePlatformOwner) writes overrides + `PlatformAuditLog` row in the same
  transaction; plus `GET .../commercials` and `.../commercials/history`
- [x] **4. Console UI**: "Commercial terms" dialog per subscriber, showing
  plan-of-record → effective for every value. English-only, as the console is.
  — verified: browser save → `/api/usage/seats` and the meters both reflect it
- [x] **5. Billing summary (tenant side) shows effective values**, marked
  "عرض خاص" when overridden, with struck-through list price and credit line
  — verified in browser; `overrideReason` is never sent to the tenant


**P9 evidence (2026-08-21).** Migration `20260822090000_platform_pricing_control`.

The load-bearing decision: **overrides resolve at read time and are never
written into `OrganizationConfig`.** Write-through was rejected because expiry
would then need a sweeper job that can silently fail, `detectQuotaDrift` would
fire on every overridden org forever, and the enforced state would drift from
the approved state. The cost is that seven call sites now go through
`modules/billing/entitlements.resolver.ts` instead of reading tier or config.

Layering matters more than it looks: effective limits are
`macQuotaOverride → live planOverride → OrganizationConfig`, **not** plan
allowances for everything. Returning plan numbers wholesale would have dropped
manually-configured AI and inbound limits and silently re-tightened quotas for
any org whose config legitimately differed. Verified: with no override the
resolver returns byte-identical numbers to the pre-P9 baseline.

`detectQuotaDrift` compares config against the plan **of record**, not the
effective plan — otherwise every overridden org reads as drifted and a real
signal becomes noise. Three-way classification proven live: config bumped
out of band → `drift`; config forced to equal the enforced override →
`override-written-through` (the regression this design exists to prevent);
override live with config untouched → clean.

A first pass got this wrong and reported all three metrics as written-through
on a perfectly normal override. Caught by verifying rather than by reading.

**Entitlements follow the effective plan everywhere, not just quotas.** Seats,
`/api/usage/seats`, custom-field allowance and branding/white-label all moved
to the resolver. Honouring an override for quotas but not features is half an
upgrade — the customer pays for a tier they cannot fully use — and the branding
tab was live-caught still announcing "Plan: FREE" for an org overridden to
Growth.

`PlatformAuditLog` was **extended, not created** — it already existed as
`{id, reason, timestamp}` and `auditPlatformScope()` writes to it on every
platform-scope entry, so every new column is nullable. `targetOrgId` and
`actorIdentityId` carry no FK on purpose: an audit trail must outlive the
subscriber and the actor it describes. The audit row is written **inside the
same transaction** as the override, so a commercial exception cannot exist
without the record of who granted it and why.

Six SQL CHECK constraints back the route validation, each verified to bite:
unknown plan, discount > 100, negative credit, negative MAC, override with no
reason, and a whitespace-only reason.

Verified live: seven validation rejections each with a specific message; plan
override → ENTERPRISE gives unlimited quotas *and* unlimited seats; MAC
override applies on top; 30% discount on Growth renders ₪49 struck through →
₪34; credit shows as ₪125 and survives a partial PATCH that omits it; the usage
bar reads 25,000 matching what enforcement uses. Expiry forced into the past →
falls back to the plan of record with **no sweeper**, `expired: true`, and the
deal left on record rather than erased. Console dialog saves end-to-end from
the browser and disables Save with an empty reason.

Gate **48/48 → 50/50**: one runtime check (org-scoped, expires, and
`OrganizationConfig` byte-identical before and after) and one static check
(`PlatformAuditLog` is a platform model, so under org scope the extension
injects nothing and a tenant-scoped read would return every subscriber’s
negotiated terms — nothing reads it outside platform code, and now nothing can
start without failing the gate).

All test data removed; residue check clean and the tenant summary is identical
to its pre-P9 baseline.

**Not done:** money still does not move. `discountPercent` and `creditCents`
are display and billing-input only until P10-b wires a real provider.

## P10-a — Saved segments · ~4 days

**Plan: [docs/P10A-SAVED-SEGMENTS-PLAN.md](P10A-SAVED-SEGMENTS-PLAN.md)**

- [x] **1. Migration**: `Segment` with the composite FK pair, plus a composite
  FK to User so a segment cannot cite another tenant's author. Name uniqueness
  is a **partial, case-insensitive** SQL index (`LOWER(name) WHERE "deletedAt"
  IS NULL`) — Prisma can express neither, so there is no `@@unique`
- [x] **2. Permissions**: `segment:view/create/rename/delete`
- [x] **3. Filter validator** in `lib/contact-filter-dsl.ts` — calls the private
  `compileRule` per leaf, collects every error with its path, rejects empty
- [x] **4. Routes** `/api/segments` list/create/rename/delete/count
- [x] **5. Extracted `assertCampaignsInOrg`** into `modules/campaigns/campaign-refs.ts`
- [x] **6. Contacts page**: "حفظ كشريحة" + segment chips with lazy counts
- [x] **7. Campaign Target step**: picker above the builder, "Custom" on edit
- [x] **8. Tenancy**: gate **50/50 → 52/52**

**P10-a evidence (2026-08-21).** Migration `20260823090000_saved_segments`.

**The find that mattered was not the feature.** Verifying cross-org access on the
new count endpoint returned **200 with another tenant's data**. Root cause:
`findFirst` and `findFirstOrThrow` were missing from *both* injection lists in
the tenancy extension, so they ran completely unscoped. Not specific to segments
— roughly twenty `findFirst` call sites exist across the backend, including
auto-reply resolution, conversation-session lookup and WhatsApp-session
resolution in the inbound path. Fixed centrally in `prisma/extensions.ts`;
pinned by a static audit that the operation list still contains them, and by a
runtime assertion that org B resolving org A's segment id returns null.

Writes were already safe — the composite FK and where-injection on `update`
meant the cross-tenant rename failed — but it failed as a **500 rather than a
404**, which is its own small leak: a 500 on one id and a 404 on another
distinguishes "exists elsewhere" from "does not exist". Both are 404 now.

The partial index was verified **at SQL level before any route existed**: "vip"
collides with "VIP"; the same name is free in another org; the name becomes
reusable after a soft delete (the case a plain `@@unique` breaks permanently);
and an author from another tenant is rejected by the composite FK.

Validator: `{"$and":[]}` → 400 "الفلتر فارغ — الشريحة ستشمل كل جهات الاتصال". A
filter with **two** bad rules returns **two** errors, each with its path
(`$.$and[0]: حقل غير مدعوم: passwordHash`). Depth 4 rejected.

Round trip verified live: create 201 → count 200 → duplicate 400 → case-dupe 400
→ rename-to-own-name 200 (self-exclusion works) → rename 200 → delete **204** →
list empty → PATCH/DELETE/count after delete all **404** → name reusable 201.

**The two counts are different by design and both were confirmed.** With one
contact opted out: the segment endpoint reports **8** (CRM semantics) and the
campaign audience reports **7** with `excludedOptedOut: 1`. The composer keeps
using the campaign endpoint, so consent cannot be bypassed by routing a
broadcast through a segment.

A stored filter referencing a deleted campaign returns
`{ error, field: "campaignId" }`, not 0 — a zero makes a broken segment look
merely empty. Campaign preview re-verified unchanged after the
`campaign-refs.ts` extraction, and the cross-tenant campaign probe still blocks.

Browser: the save button is disabled until the filter is non-empty; saving adds
a chip; clicking loads the filter back; clicking again clears it; the composer
picker sits above the builder and flips to "Custom" once a loaded segment is
edited. RTL checked — chips right, button left, no overflow. One fix from
looking rather than reasoning: a chip named "Phone has 9" showing a count of 0
read as **"Phone has 90"**, so the count now has its own background rather than
just a margin.

All test data removed; residue check clean.

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

> **Status 2026-08-22.** The *engine* is complete but for one node. Schema,
> BullMQ executor with a depth cap, trigger wiring, run log, tenancy cases,
> per-plan gating, real If/Else branching, a full HTTP Request node, and a
> form-based builder at `/automations`.
>
> **What is left: the React Flow canvas (item 6) and the Ask a Question node.**
> Ask a Question is the harder of the two — it has to pause a run, capture the
> customer’s *next* message, validate it and write it to a field, which is a
> new kind of wait: the existing `WAIT_DELAY` resumes on a timer, not on an
> inbound message.

Engine before canvas. Reuse: socket events as triggers, assignment service,
working-hours util. Skip (documented): Random Split, Zapier/Make nodes, GraphQL.

- [x] **1. Schema migration**: `Workflow` (name, status, trigger, graph Json),
  `WorkflowRun` (workflowId, conversationId/contactId, currentNodeId, state
  Json, status RUNNING|WAITING|DONE|FAILED, wakeAt), composite FKs
- [x] **2. Executor worker** (BullMQ): walk graph from trigger payload;
  `Ask a Question`/`Wait` = persist run WAITING + return (no held process);
  scheduler-style scan resumes runs whose `wakeAt` passed or whose
  conversation got a reply
  — verify: run survives `docker compose restart backend` mid-wait
- [x] **3. Trigger wiring**: inbound-message + conversation-opened/closed +
  tag-added hooks enqueue matching workflows (org-scoped lookup, cached)
- [ ] **4. Nodes, in value order** — most shipped; three gaps remain.
  There are no executor tests: this repo has no unit-test harness, so every
  node was verified live instead.
  - [x] Send Message (`SEND_MESSAGE` / `SEND_TEMPLATE`)
  - [x] Assign (`ASSIGN_TEAM` / `ASSIGN_USER`)
  - [x] Date & Time branch (`WITHIN_BUSINESS_HOURS`)
  - [x] Update Contact (`ADD_TAG` / `REMOVE_TAG` / `UPDATE_CONTACT_FIELD`,
    plus `CONTACT_LIFECYCLE_IS` as a condition)
  - [x] If/Else multi-branch — **done 2026-08-22.** `IF_ELSE` carries its own
    conditions plus `then` and `else` branches, so a false test takes the second
    path instead of ending the run. Nests three deep (the filter DSL ceiling),
    with the action budget counted **across** branches so nesting cannot slip
    past it. A `WAIT_DELAY` inside a branch is refused at save: a pause resumes
    from a top-level step index, which cannot address a position inside a branch,
    so resuming would skip the rest of it. Verified live on both paths —
    `then: 1 action(s)` and `else: 2 action(s)` in the run log. Still no regex
    operator.
  - [x] HTTP Request — **done 2026-08-22.** Method (GET/POST/PUT/PATCH/DELETE),
    bearer/basic auth, an interpolated body, `captureAs` mapping the response
    into a variable later steps read as `{{name.field}}`, and two retries at
    500ms/1500ms for transport errors and 5xx/429 only — a 4xx means the request
    is wrong and repeating a non-idempotent POST would do the same thing twice.
    Credentials go in the header and never into the delivery log.
  - [x] Close Conversation — **done 2026-08-22.** Resolves, stamps `resolvedAt`,
    emits to the inbox, and sends the subscriber’s own CONVERSATION_CLOSED
    auto-reply (nothing if they switched it off). **No CSAT prompt**, unlike a
    manual resolve: that survey asks how an agent handled you, and a thread
    closed by a rule had no handling to rate.
  - [ ] Ask a Question (wait + validate email/phone/number + write field)
- [x] **5. Run log**: per-run timeline (node, input, output, ts) for debugging
  — verify: failed HTTP node shows attempt trail
- [ ] **6. Canvas UI (React Flow)**: drag nodes, connect edges, config side
  panel, validation (no orphan nodes, one trigger), enable/disable workflow
  — **not built.** `/automations` is a form-based builder (ordered condition
  and action lists driven by `GET /api/workflows/schema`), not a canvas.
  Enable/disable does work. React Flow is not installed.

  Extended 2026-08-22 so the form covers what the engine gained: a branch
  editor for `IF_ELSE` (conditions, then, otherwise) and method / auth /
  capture fields for HTTP Request. **One level deep only** — the engine allows
  three, but a nested editor inside a dialog stops being readable at the second,
  so deeper graphs stay API-only until this canvas exists.
  — verify DoD: admin builds "new conversation outside hours → template X,
  assign team Y, tag Z" on canvas; it executes; survives restart mid-wait
- [x] **7. Tenancy harness cases** for Workflow/WorkflowRun — gate green
- [x] **8. Entitlement**: workflows count gated per plan (`plans.ts`)
  — **done 2026-08-22.** `workflowsLimit`: Free 1, Growth 10, Business 50,
  Enterprise unlimited. Free gets one rather than none so automation is
  demonstrable rather than merely advertised. Active *and* inactive both count:
  counting only active ones would make the ceiling trivially avoidable, and
  would mean hitting it by enabling something already built — a worse moment to
  be told. Reads the **effective** plan, so an override grants it too. Refuses
  with 429, matching the custom-field ceiling. Verified live.

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

- [x] **H1. Gateway health monitor** —
  plan: [docs/H1-GATEWAY-HEALTH-PLAN.md](H1-GATEWAY-HEALTH-PLAN.md)

**H1 evidence (2026-08-21).** Migration `20260824090000_gateway_health_checks`.

**Two probes, deliberately different cadences.** `status` is a free HTTP poll
every 15 min and does the day-to-day work. `selfSend` is an **internal probe**
every 6 hours: a real WhatsApp message to the channel's *own* number, never to a
customer, never charged to the tenant. It exists only to catch outbound failing
while the session still claims to be healthy — the fault a status poll is blind
to, and the one that actually happened.

**The find that justified the whole design.** The first live `selfSend` failed
with a gateway 400 — and the `status` probe on the *same session* had just
returned **ok**. `getStatus` answers HTTP 200 with a body saying
`status: disconnected`, and the probe was only checking that the call did not
throw. It now inspects the reported state via the existing
`isConnectedStatus()` helper, so both modules agree on what "connected" means.
A monitor that reports a dead session as healthy is worse than no monitor.

**The metering bypass is real and pinned.** `OpenWAService.sendText` runs through
`meteredSend`, so an unguarded probe would consume tenant quota — at 15-minute
intervals ~2,880 messages/month against a Free plan's 100 — and
`assertMetricAvailable` *throws* at the ceiling, so the monitor would go blind
exactly when the system was most stressed. `OutboundUsageOptions.internal` is
honoured at all three layers (`prepareOutboundSend`, `recordSuccessfulOutboundSend`,
`meteredSend`), verified live: a self-send left `messages_outbound` **and**
`active_contacts` unchanged at 0.

**Audit-volume correction.** Every `runAsPlatform()` writes a `PlatformAuditLog`
row. The first cut opened a scope per organization per probe — hundreds of rows a
day of routine noise in the same table that records platform-owner commercial
changes. Now one scope per cycle; verified as exactly one audit row per manual
call.

Verified live: 2-of-3 threshold (first failure → **no** alert, second → exactly
one CRITICAL, third → still one, no duplicate); recovery resolves it with the
row kept and sane timestamp ordering; `SUSPENDED` and `AWAITING_QR` channels
return `skipped` with no row and no alert; a full cycle through the worker's own
entry point reported `{checked:3, failed:3}`; all three repeatable jobs
registered with the right cron patterns; retention sweep runs clean.

Console: a Health column with two dots (status / self-send) whose tooltips carry
the real error and age, a "check now" action, and an alerts panel showing open
and resolved gateway alerts. English-only, matching the rest of the console.

Gate **52/52 → 54/54**. The second new check is the one that matters: an
internal send must record no `UsageEvent`, **and** a normal send must still
record one — a bypass that swallowed everything would pass the first assertion
while breaking all metering.

**⚠️ This found a real outage on the first run:** all three WhatsApp sessions
(`it-support`, `marketing`, `ostudio-primary`) are `disconnected`. The open
CRITICAL alert for RabiTech Demo is genuine, not test residue, and was left in
place deliberately. See the gateway runbook.

- [ ] **H2. Per-org campaign rate limits** (plan-aware): queue-per-org or Redis
  token bucket — BullMQ group limiting is Pro-only, so not a one-liner
- [ ] **H3. Reports onto `PlatformDailyMetric` rollups** (scale, not
  correctness)
- [x] **H4. Custom-field editing** in the inbox contact panel
  — **done 2026-08-23.** A subscriber could define custom fields in settings
  and then fill them from exactly one place: a CSV import. The panel an agent
  is looking at while the customer tells them the thing worth recording could
  not write to them.

  Saved per field on blur, not behind a distant Save button — there is no form
  to submit here, and a section of inputs with one far-away button is how edits
  get lost when the agent clicks away to answer the message. List fields render
  as a select of their allowed values; numbers and dates get the matching input
  type and .

  Closed a hole while wiring it: the write route accepted any string for any
  field. A number field took "soon" and a list field took anything, and the
  contact filter DSL then queried a column whose contents did not match its
  declared type. Validated now, with the error naming the field and what it
  expected. Clearing a value always passes — refusing that would leave a
  mistyped value permanently stuck.
- [x] **H5. @mentions in internal notes** (+ notification fan-out)
  — **done 2026-08-22.** Same work as M6.6 above; this entry predated it.
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

Marasil §14.4. Ours was 3 categories × 6 operators. Theirs: ~20 dimensions.

- [x] **1. Type-aware operators**: date (`withinLastDays`, `moreThanDaysAgo`,
  `before`, `after`, `between`), number (`gt/gte/lt/lte/between`),
  multi-value (`isOneOf`, `isNoneOf`), text (`endsWith`, `notContains`)
  — `matchesRegex` deliberately **not** shipped, see evidence
- [x] **2. New dimensions**: `lifecycleStage`, `assigneeId`, team,
  `createdAt`, `updatedAt`, `lastInboundAt`, `hasEverReplied`,
  `hasOpenConversation`, `conversationStatus`, `marketingConsent`,
  `consentSource`, `consentUpdatedAt`, `notes`
  — `conversationCount` deferred: Prisma cannot express a relation count in
  `where`, so it needs the two-step `groupBy` idiom for the least valuable
  dimension on the list
- [x] **3. Broadcast-history dimensions** — received campaign X · read campaign X
  · received any within N days · never received a broadcast
- [x] **4. Nested groups to depth 3** with AND/OR toggles
- [ ] **5. Estimated counts** above a threshold, labelled `~4,200 (estimated)`
  — not needed at current data volumes; revisit when a tenant crosses ~50k
  contacts and the exact count on every keystroke starts to bite

**Not delivered this pass, and worth stating plainly:** the Marasil headline
example *"received the July promo **but never replied since**"* is only half
shipped. "Received campaign X" works; "never replied *since that campaign was
sent*" needs a `Campaign.sentAt` lookup **inside** rule compilation, which makes
`compileRule` async and changes every caller. What ships is the blunter
composition — "received campaign X" AND "has never replied at all", ignoring
timing — which covers many real cases but is **not** the same filter and is not
labelled as if it were.

**M3 evidence (2026-08-21).**

*Consolidation first.* The "is this rule complete?" test existed as a literal
`['isEmpty','isNotEmpty']` check in **three** places. Each site silently *drops*
rules it judges incomplete, so any new valueless or two-value operator would
have quietly stopped working wherever nobody remembered to update — and a
dropped rule makes the audience *bigger* with no error. Now one helper, and it
is recursive, because the flat version treated a nested group as a rule with no
operator and deleted the whole branch.

`contacts.routes.ts` spread the DSL last, so a filter carrying `$or`
**overwrote** the search's own `OR` and search was silently ignored. Now merged
under `AND`. Verified: `search=zzzznomatch` with an `$or` filter returns 0,
where before it returned all 8.

*Two inherited semantic bugs fixed rather than carried forward.* `isEmpty`
compiled to `IS NULL` alone, missing every `''` row — and on a non-nullable
column it produced an *invalid query* rather than a wrong answer (reproduced:
`isNotEmpty` on `phone` returned "Argument `not` is missing"). `isNotEqualTo`
dropped NULL rows, so "stage is not lead" silently excluded every contact with
no stage set — the opposite of what people mean.

*`lastInboundAt` reads `Message.timestamp`, not `Conversation.lastMessageAt`.*
The latter also moves when **we** send, so "quiet for 90 days" would be reset by
our own outbound message. The two-level `some` is the slower query and the
correct answer. `moreThanDaysAgo` compiles to a `none`, not a `some` with
`lt`: the latter matches anyone who was *ever* quiet that long, including
someone who replied yesterday.

*`matchesRegex` was cut.* Prisma exposes no regex predicate for PostgreSQL and
the only route is `$queryRaw`, which bypasses the tenancy extension entirely.
A regex operator is not worth being the one hole every other filter avoids.

*The vocabulary is served, not hardcoded.* `GET /api/contacts/filter-schema`
returns fields, per-type operators, and the org's own custom fields, tags, teams
and sent campaigns. Only the backend can reject an unknown field, so a client
copy drifts into offering filters that 400; and half the list is per-tenant and
unknowable at build time. The operator dropdown was previously
**category-independent** and would offer "within last N days" on a name.

*Errors.* A bad filter was a bare 500, so the audience count just stopped
updating with no reason given. Now 400 naming the offending field or operator,
with internal messages filtered out rather than echoed into a toast.

*Tenancy.* The compiler now **requires** an `organizationId` and writes it into
every nested relation filter. The extension injects org scope at the top level
of a `where` only and does **not** descend, so nested filters previously relied
on composite FKs alone; stating it twice removes the reliance. Campaign ids in a
filter are validated against the caller's org — unvalidated they fail safe, but
"0 recipients" is itself an answer to a probe.

*Verified live.* 28 filters through the real preview endpoint: old-shape
compatibility (original six operators still compile and count identically),
every new operator, depth-4 correctly rejected, and six error cases each
returning a specific Arabic reason. Activity filters proven by inserting one
INBOUND message and watching `hasEverReplied` move 0→1 and its complement 8→7.
Broadcast filters proven against a real campaign with two recipients, one read:
received=2, read=1, never=6. **Cross-tenant probe using org B's real campaign
id** blocked at top level *and* when buried in a nested group.

In the browser: selecting a date field snapped the operator from "Contains" to
"Within last (days)" and the value input became a number field; the operator
list then contained only the seven date operators. `between` widened the row to
six columns with two date pickers — the old fixed five-column grid could not fit
a second value. A nested group serialized as
`{$and:[{createdAt between …},{$or:[{name contains …}]}]}` and returned 200.
RTL checked: the row flows right-to-left with no overflow.

Gate **46/46 → 48/48**, adding one relation-derived and one broadcast-history
isolation case, plus a check that `campaignIdsInFilter` sees through nesting —
otherwise the org validation is bypassed by putting the id one group deeper.
All probe data removed; residue check clean.

**Not visually verified:** the campaign composer's new error banner and filter
count badge. Broadcasts are plan-gated and the demo org is on FREE; flipping the
tier to reach the composer was blocked by a permission check, and working around
it was not worth it — a raw tier flip is exactly what caused silent quota drift
once already. The component beneath it (the builder) is the same one verified on
the contacts page, and the 400 responses it renders were verified directly.

## M4 — Dark theme · ~1 day · fixes a regression we introduced

- [x] **1. Dark palette** under the same token names
- [x] **2. Theme toggle** (light / dark / system) persisted per user
- [x] **3. Contrast audit in dark** — zero failures across inbox, contacts,
  automations and settings
- [x] **4. Nav rail** re-tuned for a dark canvas

**M4 evidence (2026-08-21).**

**The regression left a fingerprint:** `<html className="dark">` was still
hardcoded in the layout. The class survived the flip to the light palette; the
`.dark` token block did not — so it did nothing, and that is exactly why the
regression stayed invisible. The class is now set before paint by an inline
script and owned by ThemeProvider thereafter.

Because every component reads tokens (`bg-card`, `text-muted-foreground`) rather than
literal colours, one `.dark` block re-themes the product without a single
`dark:` utility anywhere. Three things are inverted rather than merely
darkened: elevation runs the other way (raised surfaces get *lighter*), the
status colours go *lighter* where light mode darkened them, and the nav rail
becomes the darkest layer plus a border — navy-on-dark would simply vanish.

**Not redefined in dark: the tenant's brand colour.** `--primary` is injected
as an inline style on `<body>`, so a subscriber's blue stays theirs in both
themes. But a brand colour chosen to read on white is usually illegible as
*text* on dark (the default lands at 3.4:1), so `.dark .text-primary` mixes
it toward white — which works for any brand colour rather than hardcoding one.

**What the audit found, which palette work alone could not have fixed:**

- `STATUS_CONFIG` hardcoded hex values picked for AA on a pale tint. A
  literal cannot follow a theme, so these became `--status-*` tokens. Same
  for six more hardcoded hexes across campaigns, reports and settings.
- A raw `text-indigo-400` class on the inbox that failed AA in **light**
  too (2.98:1) and could never theme.
- `--warning` was documented as `#B45309 — 4.8:1` but the HSL triple
  written (`32 94% 37%`) renders a different colour measuring **4.34:1**.
  The comment and the value had disagreed since the re-theme, so it quietly
  failed AA.
- Avatar initials and team pills use tenant-chosen colours as *text over a tint
  of themselves* — fine on white, ~2.4:1 on dark. No palette change fixes that;
  only changing the colour's role does. Both were the same duplicated inline
  style, so they were extracted into `ContactAvatar` and `ColorPill`,
  which invert to a solid fill with white text in dark.

Two of my own mistakes, caught by re-measuring rather than by reading: I
substituted `*-vivid` tokens (which are fills) where the original was the
AA-safe text colour, and I gave `--status-pending` the warning token's HSL
instead of converting `#B45309`.

**Result: 0 failures in dark across all four core views** (91 / 82 / 20 / 258
elements checked). Light regressed to 8 on settings and is now at 2 — both
pre-existing colour-swatch preview labels in the branding panel, which need a
design change rather than a palette one. Left for M5.

Gate stays 57/57.

## M5 — Design system hardening · ~1 day

> **Note (2026-08-21).** Commit `c2c438c` ("M5") and commit `e41a205` ("M6")
> did *not* implement the boxes below. They delivered a different, smaller
> slice: a single `lib/tint.ts` primitive behind `StatusBadge`/`ColorPill`/
> `ContactAvatar` (fixing nine badges whose tint had silently vanished — an
> alpha suffix on a token colour is invalid CSS), a `.select-field` class
> across 16 raw selects that had no focus ring at all, an `EmptyState`
> component, and inbox scroll retention. Every box below is still open.

- [x] **1. Type scale tokens** (display/h1/h2/h3/body/small/caption/micro)
  replacing ad-hoc `text-[11px]` literals
  — **done 2026-08-22.** Eight steps as CSS variables, in rem so a reader who
  raises their browser font size actually gets larger text. Swept **189**
  literals across 34 files (96×11px, 71×10px, 9×9px, 9×13px, 4×12px). 12px and
  13px collapse onto one step — keeping two a pixel apart is how a scale rots
  back into literals.
- [x] **2. Motion tokens** — 120ms micro / 200ms panel / 300ms modal,
  `cubic-bezier(0.2,0,0,1)`, honouring `prefers-reduced-motion`
  — **done 2026-08-22.** Reduced motion collapses the durations to ~0 rather
  than removing the animations, so `transitionend`/`animationend` listeners
  still fire. Deleting them is how a menu that closes on `animationend` gets
  stuck open for exactly the users who asked for less motion.
- [x] **3. Densities** — Compact / Comfortable / Spacious on the conversation
  list, persisted per browser
  — **done 2026-08-22.** Verified live at 59 / 71 / 79px per row, surviving a
  reload. Compact drops the preview line rather than shrinking everything,
  because that line is where the row height goes. The row also moved off
  `text-right` / `before:right-0`, which had put the active-row marker on the
  far edge of the row in English.

  Found here: `components/inbox/conversation-list.tsx` was **dead code** — the
  list that renders is inline in `app/(dashboard)/inbox/page.tsx`. The density
  work went into the dead file first and had to be redone.
  — **deleted 2026-08-23.** It survived the original note and caught a second
  victim on the way out: the U7 language pass edited it too. Nothing imported
  it, so both edits rendered nowhere.
- [x] **4. Named empty states** per situation, "all caught up" deliberately quiet
  — **done 2026-08-22 (U5.2).** `components/inbox/conversation-list-states.tsx`
  separates three causes that shared one sentence: no channel connected, a
  connected workspace with nothing in it yet, and a filter matching nothing.
  Each carries its own next action. The filter is tested first, because
  server-side search replaces the loaded list and any other order tells an
  agent staring at their own search term that their workspace is empty.

## M6 — Inbox structure · ~1 week

Marasil §29.1: 56 / 240 / 320 / flex / 340.

- [x] **1. Inbox-selector column**: system inboxes (All / Mine / Unassigned /
  Mentions / Snoozed) with live counts
  — **All / Mine / Unassigned done 2026-08-22 (U1)**, plus lifecycle stages and
  team queues, all with counts derived from the conversations actually loaded.
  `components/inbox/inbox-selector.tsx` on wide screens,
  `components/inbox/inbox-scope-menu.tsx` below `lg` where the column is
  hidden — same scopes, same counting code, so the two cannot disagree.

  **Mentions added 2026-08-23** — see item 6.

  **Snoozed added 2026-08-23.** `Conversation.snoozedUntil` — a timestamp,
  not a flag plus a job. A thread is snoozed while it is in the future and
  simply is not once it passes, so nothing has to run for a conversation to
  come back: no worker to fall over, and no window where the row says one
  thing and the truth is another.

  **Product decision taken: a customer reply cancels the snooze.** Snoozing
  says "nothing is expected here until Tuesday", and a message from the
  customer is exactly what makes that untrue. Honouring the snooze regardless
  is defensible for an internal task tracker and wrong for a product whose
  entire purpose is that customer messages get answered.

  Durations rather than a date picker — "in 3 hours", "tomorrow", "in 3
  days", "next week". Asking an agent for a minute is asking a question they
  do not have an answer to. Snoozing clears the open thread, because the view
  it was selected from no longer contains it.
- [x] **2. Lifecycle stages** as a configurable pipeline, surfaced as inbox
  filters with counts
  — **pipeline done 2026-08-22; the inbox filters are NOT built.**
  `LifecycleStage` is a per-organization, ordered, colour-coded model with
  `/settings/lifecycle` CRUD, seeded (Lead / Contacted / Qualified / Customer /
  Unqualified) in the migration for existing tenants and at signup for new
  ones. Selector in the contact panel, chip in the thread header.

  `Contact.lifecycleStage` stays *text*, not a foreign key: values already exist
  from hand entry and CSV import that match no stage, and the filter DSL treats
  the column as text, so stored campaign audience filters reference it that way.
  Consequence, handled rather than hidden — deleting a stage leaves contacts
  carrying its name; the API reports how many, and the selector keeps an unknown
  value as an explicit "deleted stage" option. A plain `<select>` shows the first
  option instead and silently reassigns the contact the moment anyone touches it.
  — **inbox filters done 2026-08-22 (U1).** Stages appear as their own group in
  the selector with live counts, and the group is omitted entirely when a
  tenant has configured no stages: an empty "Lifecycle" heading over nothing
  is a dead section, and this product's whole vocabulary is subscriber-defined.
- [x] **3. Custom inboxes** — saved views, the filter grammar's fourth consumer
  — **done 2026-08-23 (M6.3).** `InboxView`, `/api/inbox-views`, and a fourth
  group in both the pane and the mobile menu. Spec:
  [M6-CUSTOM-INBOXES-SPEC.md](M6-CUSTOM-INBOXES-SPEC.md).

  Ownership *is* the sharing model — `ownerId` null means shared — so there is
  no `shared` boolean to fall out of step with it, and deleting a user takes
  their private views while leaving the shared ones standing. The owner FK is
  composite on `[ownerId, organizationId]`, proven to refuse a cross-org owner.
  Gate is 69/69 with two new checks; the second covers what the first cannot,
  since a shared view has no owner and `organizationId` is the only thing
  scoping that row.

  Filters are evaluated **in the browser**, deliberately: every count in the
  pane is computed from loaded conversations because the list endpoint has no
  pagination, so a server-evaluated view would show a count that disagrees with
  the list it opens. That is the constraint the grammar was designed around,
  and why `sla_status` and `channel_id` are not in it — see the spec’s §0.
  When the list is paginated, views move server-side **with** the other scopes.

  Concurrent edits are a 409 against an `updatedAt` precondition rather than
  last-write-wins over a JSON blob. Unknown filter keys are rejected and named
  rather than ignored: silently dropping a key leaves an author with a view
  that does not filter the way they believe it does. `npm run test:inbox-views`
  covers the grammar, 16/16, with no server or token needed.

  Verified live end to end — create from a live filter, select, rename, share,
  reorder, delete — with the pane count matching the list it opened.

  **Not done, and deliberately:** delivery of a shared view to a *second*
  logged-in user was not exercised. Creating a test user hits the workspace
  seat limit and borrowing an existing login would mean touching a credential.
  The routing is covered instead by the tenancy gate, which statically audits
  every emit site for an organization-prefixed room, and by an HTTP check that
  another user's private view is absent from the list and 404s on edit.
- [x] **4. Contact panel tabs** — Details / Conversations / Files / Activity
  (horizontal at the bottom; short labels beat icons for infrequent actions)
  — **Details / Files / Activity done 2026-08-22 (U2).**
  `components/inbox/contact-context-tabs.tsx`. Activity merges `AuditLog` rows
  — their first ever consumer — with automated messages, and renders automated
  events as hollow dots so the distinction is not carried by colour alone.
  Details gained consent provenance in U2.4.

  — **Conversations tab done 2026-08-23.** Every thread this contact has had,
  newest first, with status, date, message count, team and assignee. Selecting
  one switches the thread pane to it; the thread already open is marked rather
  than hidden, because a list that silently omits where you are standing is
  harder to read than one that says so.

  Resolved threads are included deliberately — they hold the answers, and the
  inbox default filter hides them, which is exactly why they were unreachable
  from anywhere else.
- [x] **5. Session-health bar** on each conversation row — our analogue of their
  service-window bar
  — **done 2026-08-23**, as a mark on affected rows rather than a bar on every
  one. Shown only when the workspace has more than one number and some but not
  all of them are down: if every channel is offline the rail already says so
  across the whole list, and repeating it per row is noise. What it catches is
  the case the rail cannot express — two numbers, one dead, and no way to tell
  which conversations just went quiet.
- [x] **6. @mentions** + a Mentions inbox
  — **mentions done 2026-08-22; the Mentions inbox is NOT built.**
  `@mention` popover in the composer mirroring the `:shortCode` pattern (same
  keyboard navigation), firing `NotificationType.MENTION` — an enum value that
  had sat unused since the notification service was written.

  Mentions resolve from **ids the composer sends**, never by parsing note text
  for names: two agents can share a display name, names contain spaces, and
  "@ahmad" in prose addresses nobody. Only teammates still named in the final
  text are notified, and only on internal notes — a customer-facing reply
  carrying ids would let a WhatsApp message ping agents the customer never saw
  named.

  — **Mentions inbox done 2026-08-23.** A scope in the selector beside Mine
  and Unassigned, on both the wide pane and the compact menu below `lg`,
  counted by the same code so the two cannot disagree.

  Built entirely on data that already existed: `MENTION` notifications have
  carried a conversation id since mentions were written, and nothing ever
  read them back — being named produced a bell notification and no way to
  find the thread again once it scrolled past.

  Read state is reported by the endpoint but not filtered on. An agent who
  has *read* a mention has not necessarily dealt with it, and a queue that
  empties itself the moment you glance at it is not a queue. The row appears
  only when there is at least one: an agent nobody has ever named does not
  need a permanent zero telling them so.

## M7 — Reports consolidation · ~1 week

Marasil §20: five surfaces, each answering one question. We have one page.

**Schema this rested on.** Response and resolution time were only inferrable
from `Conversation.updatedAt`, which every edit touches — relabelling a resolved
thread moved its "resolution time". Migration `20260826090000_analytics_reporting`
adds `firstResponseAt` (first *human* outbound; auto-replies excluded or every
thread reports a response time of seconds) and `resolvedAt` (stamped at the
transition, cleared on reopen), plus the `AnalyticsHourly` rollup. Historic
`resolvedAt` is backfilled from `updatedAt` and is therefore approximate; every
resolution from 2026-08-21 on is stamped at the transition itself.

- [x] **Fixed 2026-08-23: the `firstResponseAt` backfill was wrong in two ways.**
  Corrected by migration `20260905090000_first_response_correction`.

  **The original note below understated it.** It said 2 of 4 rows were wrong
  and that the skew was downward. Both were wrong. Three of the four were
  wrong, and the skew ran in both directions: one thread reported a
  0.2-minute response and another 850.8, neither having answered anybody.

  The third row was the one worth finding. Conversation 1002 had inbound
  messages, so it passed the "no inbound" test — but the backfill had
  stamped an agent message sent **8.6 hours before the customer first
  wrote**. It reported a 14.9-minute first response where the truth was
  2305.5 minutes: wrong by a factor of 155, and wrong in the flattering
  direction.

  So the migration does two things rather than one: clears the stamp where
  no inbound exists, and re-stamps where the response predates the question
  — to the first human, customer-facing outbound that came after it, which
  is the row the live stamper would have caught. Clearing only the obvious
  ones would have left the metric quietly wrong and looking fixed.

  Verified after applying: 0 rows stamped without an inbound, 0 stamped
  before the first inbound, and 0 that qualify for a stamp and lack one.

  <details><summary>The original note, kept for the record</summary>

  **Open defect: the `firstResponseAt` backfill over-counts.** Found
  2026-08-23 while verifying the column for M6.3. The live stamper
  (`analytics/response-time.ts`) requires the thread to already hold an inbound
  message — an agent-initiated conversation has nothing to respond *to*, and
  counting it reports a near-zero response on a thread no customer ever waited
  in. **The backfill in `20260826090000_analytics_reporting` omits that
  condition**, so every outbound-only thread that predates the migration is
  stamped as answered.

  Confirmed against the live database: of 4 stamped conversations, 2 have no
  inbound message at all. Nothing produced since the migration is affected —
  zero conversations qualify for a stamp without having one — so this is
  historic rows only, and it skews first-response-time reporting downward by
  including threads that were never a response.

  Fix is a corrective additive migration clearing the stamp where no inbound
  message exists. Left for a decision rather than applied in passing: it
  changes published historic numbers, which is the owner’s call, not a
  side effect of unrelated work.

  </details>

- [x] **1. Overview** — headline tiles with sparklines and period deltas
  — **done 2026-08-21.** `GET /api/analytics/overview`. Verified live: seeded 10
  inbound across two known days, headline read exactly 10 and the daily series
  split 8 / 2 to the right dates.
- [x] **2. Conversations** — response and resolution distributions
  — **done 2026-08-21.** Median, mean and p90 reported together so one thread
  left open over a weekend is visible as the gap between median and mean rather
  than hidden inside it, over six fixed buckets.
- [x] **3. Team** — workload and leaderboard
  — **done 2026-08-21.** Search by name + team filter. Rewritten as five
  `groupBy` aggregates: the previous endpoint loaded every sent message and
  assigned conversation for every agent into memory and counted them in JS.
- [x] **4. Campaigns** — per-broadcast performance
  — **done 2026-08-21.** Delivered / read / failed / replied. "Replied" is one
  pushed-down `contact.count` per campaign that walks the relation in Postgres
  rather than pulling recipient ids into Node and sending them back as an `in`.
- [x] **5. Gateway health** — our replacement for their "account health & cost":
  session state, failed-send rate, webhook delivery
  — **done 2026-08-22.** Session state, failed-send rate and automated share
  shipped 2026-08-21; **webhook delivery** followed with `WebhookDeliveryLog`
  and a sixth Webhooks tab. Logged in **both** directions, because they are
  separate faults: OUTBOUND is a workflow calling a subscriber endpoint,
  INBOUND is the gateway delivering to us, and only the second goes silent
  when the platform stops receiving WhatsApp traffic. Verified live: an
  inbound receipt recorded 200/ok/3ms, an outbound failure recorded its host,
  null status and error, and a success rate of `—` rather than a green 100%
  when nothing was delivered at all.
  Live connectivity is deliberately read from the gateway rather than cached,
  because a stored copy of "connected" is the more convincing of the two and
  the wrong one.
- [x] **6. Drill-down from every number** to the underlying conversations —
  *"a manager who cannot click a number to see what it is made of will not
  believe it"*
  — **done 2026-08-21.** Allow-listed metrics only, never a filter assembled
  from the query string. Verified: drill-down totals matched their tiles exactly
  (7 and 1), and `?conversation=<id>` opens that exact thread in the inbox
  (checked #1001), including resolved threads the default filter hides.
- [x] **7. Volume by hour-of-day heatmap** (their staffing-decision chart)
  — **done 2026-08-21.** Read from the hourly rollup, so it costs one row per
  hour instead of one per message. Verified at two offsets: 06:00/07:00 UTC
  landed on Mon 06/07 at offset 0 and Mon 09/10 at +180, totals conserved.
  Rollup recomputation is idempotent — three backfills, still exactly 10.

**Not covered by this phase.** Reports read `Message.timestamp` for percentiles
and cap the sample at 20,000 conversations, flagging `truncated` rather than
quietly describing a slice as the whole period. Above that the percentiles need
a rollup of their own.

## M8 — Roles, restrictions, admin · ~3 days

- [ ] **1. Granular restrictions** over roles: restrict data export, contact
  deletion, workspace settings, integration settings
- [x] **2. Role-aware navigation** — agents see three destinations, not five
  — **done 2026-08-23.** Four, not three, once measured against the real
  matrix rather than estimated: inbox, contacts, automations and settings.
  `campaign:read` and `analytics:read` are ADMIN / SUPERVISOR / FINANCE, so
  Broadcasts and Reports were destinations an agent could see and not open.

  `permissionsForRole()` derives the caller's set from the same
  `ROLE_PERMISSIONS` the middleware enforces and `/auth/me` returns it; the
  sidebar filters on that. A mirrored matrix on the frontend would drift the
  first time a role gains an operation here and the other file is forgotten,
  and it would drift toward offering pages the server refuses.

  Hiding, not explaining — the opposite of the rule for controls inside a
  page. A blank space where a button was is ambiguous; an absent menu entry
  is not, and a menu is a list of places you can go.
- [x] **3. CSV import** — built (M8). Header auto-mapping, validation preview,
  duplicate-in-file detection, optional tag, and the **mandatory opt-in
  declaration** writing `consentSource: 'import'`.

**M8 evidence (2026-08-21).** No migration needed — `consentSource` already
existed from M1.

**Two rules the server enforces, not the checkbox.** The affirmation is a hard
gate in `importContacts()`: no `consentAffirmed: true`, no import, verified
three ways (absent, false, and empty rows). And **an import can never resurrect
an opted-out contact** — someone who sent STOP stays `OPTED_OUT` however the
spreadsheet describes them. Without that, re-importing a list is how a tenant
silently undoes every opt-out they have received, and they would never know.
Verified: re-importing an opted-out row returns `skippedOptedOut: 1` and the
row is still `OPTED_OUT`.

**Phones are stored digits-only, deliberately — not `+E.164`.** Inbound
WhatsApp addresses arrive as `972542030590@c.us` and the inbound path strips
the suffix and any `+` before matching. A stored `+` would mean an imported
contact never matches their own incoming message: the system would not
recognise them, and a *second* contact would be created for the same person.
That is the worst outcome for a contacts import, because it looks like it
worked. Numbers are therefore *validated* as E.164 and *stored* in the existing
form, with `displayE164()` used for the preview only.

Verified live: `+972 50-000-0501`, `00972500000502` and `0500000503` (with a
default country code) all normalize to the stored digits-only form; junk, empty,
too-short and duplicate-in-file rows are each reported with their row number.

Chunked at 250 rows per transaction with a 20,000-row ceiling: one transaction
per row is slow, one for the whole file times out and rolls back work that was
fine, and both fail worst on exactly the large file this feature exists for. A
failing chunk reports against its own rows and the import continues.

Browser: header auto-mapping guessed all four columns of a realistic file;
entering a default country code moved a row from invalid to valid live; submit
stayed disabled until the affirmation was ticked; the result read 3 total,
2 new, 1 failed with the row and reason.

**One bug caught by looking:** the preview rendered its validation reasons in
Arabic inside an English interface — `previewPhone` returned display text, so
the component had nothing to translate. It now returns stable reason codes that
the page passes through `t()`.

Gate **56/56 → 57/57**. All test data removed.


- [ ] **4. Quiet hours** enforced in the recipient's local time from phone prefix
- [ ] **5. Broadcast clone**
