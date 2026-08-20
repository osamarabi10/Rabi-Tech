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
- [ ] **3. Gated-features-shown-not-hidden**: central `useEntitlements()` hook
  reading plan from `/api/billing/summary`
  — verify: hook returns campaign/API-key gates for FREE vs ENTERPRISE
- [ ] **4. Apply to Broadcasts**: FREE tenant sees the campaigns page with an
  upsell panel "البث — متوفر في باقة Growth" + upgrade button, NOT a missing
  nav item; server still enforces via `assertMetricAvailable` (never trust UI)
  — verify: browser as FREE org shows upsell; ENTERPRISE unchanged
- [ ] **5. Docs**: tick this block in TODO, update spec ledger

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
