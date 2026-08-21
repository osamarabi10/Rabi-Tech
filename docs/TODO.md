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
