# RabiTech — Project Specification & Orchestration Plan

**The master document.** Verified current state, full surface map, Respond.io
parity scorecard, dead-flow register, and every phase — done with evidence,
remaining with definitions of done. Maintained by the project orchestrator;
updated 2026-08-20 after the deep-analysis sweep.

Rule for this file: nothing is listed as *done* unless it was **verified live**
— an HTTP call, a database row, or a browser measurement. "The code exists" is
not done.

---

## 1. What RabiTech is

A **white-label, multi-tenant WhatsApp customer-conversation platform** —
Respond.io's model, self-hosted economics. Subscribers (organizations) get a
branded workspace: shared team inbox on their own WhatsApp number, contacts/CRM,
broadcasts, auto-replies, reports. The platform owner runs subscribers,
plans, and billing from a separate console.

**Two hard product laws** (violations are release blockers):

1. **Nothing customer-facing is hardcoded.** Every message a subscriber's
   customer can receive resolves from an organization-owned row; unconfigured →
   send nothing. Defaults are provisioning *seed data*, never runtime fallbacks.
2. **No platform branding in tenant output.** A subscriber's customers must
   never see "RabiTech"; names come from `OrganizationBranding`.

---

## 2. Architecture (as running today)

```
WhatsApp ⇄ OpenWA gateway (ghcr.io/rmyndharis/openwa, WA-Web engine)
              │  webhooks: http://backend.local:4000/webhooks/openwa/<token>
              │  (dotted compose alias + SSRF_ALLOWED_HOSTS — see runbook)
              ▼
Backend — Express + Prisma + Socket.io (port 4000)
  • fail-closed tenancy: AsyncLocalStorage scope, every query org-bound,
    composite FKs [id, organizationId] — cross-org writes die at the DB
  • 16 modules · 8 BullMQ workers (job ids use `--`, never `:`)
  • RBAC: ADMIN > SUPERVISOR > AGENT > VIEWER/FINANCE via requirePermission()
              ▼
PostgreSQL 15 (36 models, 38 migrations) · Redis (queues)
              ▲
Frontend — Next.js 14 App Router (port 8080), RTL Arabic (Palestinian/Arab48),
  Respond.io palette: canvas #F8FAFC, navy rail #0F172A, primary #0066FF —
  all as HSL tokens; tenant branding injects --primary at runtime
```

**Tenancy gate: 45/45 checks green** (`npm run test:tenancy`). This suite is
the release gate for any schema or scope change.

**Key invariants discovered the hard way** (do not relearn these):
- BullMQ job ids cannot contain `:` — it broke all inbound *and* all campaigns.
- The gateway rejects single-label webhook hosts AND SSRF-blocks private IPs;
  only a dotted alias + allowlist satisfies both. `host.docker.internal` is
  Docker-Desktop-only — it would break inbound on the VPS.
- Persist-first on sends: the Message row is created before the gateway call,
  so a gateway failure marks FAILED instead of losing the message.
- Delivery acks are monotonic (sent→delivered→read); WhatsApp redelivers out
  of order and a late duplicate must never walk status backwards.
- `docker-compose.yml` passes env vars **explicitly** — a new env var that
  isn't added there silently falls back to its default in the container.

---

## 3. Surface map

### 3.1 Public (no auth)
| Route | State |
|---|---|
| `/` landing → `/pricing` | works |
| `/pricing` → `/signup?plan=X` | plan code carries through; signup shows it read-only |
| `/signup` → email verify → workspace | works; FREE self-serve end-to-end |
| `/contact-us-to-activate` | Arabic, honest: payment not live yet, human will contact |
| `/verify-email`, `/checkout-success`, `/checkout-cancel` | work |

### 3.2 Tenant dashboard (5 destinations — Respond.io IA)
| Surface | State |
|---|---|
| **المحادثات** Inbox | 3-pane (list · thread · contact panel); filter tabs w/ counts; segmented رد/ملاحظة داخلية composer; `:shortcode` expansion; media (image/video/voice via magic-byte proxy); labels; assignment; CSAT intercept; socket live + ack ticks. Responsive: rail→drawer, one-pane flow + back button on phones |
| **جهات الاتصال** Contacts | paginated list, tags, custom fields (schema + basic UI), filter-DSL builder, CSV import |
| **البث** Campaigns | 3-step composer (Compose→Target→Review), live audience count from filter DSL, WhatsApp-style preview w/ variables, send-now / schedule, per-campaign report (pending/sent/delivered/read/failed + failures), throttled worker |
| **التقارير** Reports | stat cards, sessions, team, agent performance (msgs/convs/resolved/CSAT). ⚠ aggregates live tables, not rollups — scale concern only |
| **الإعدادات** Settings | branding (logo/colors/domain/locale), usage meters, working hours, **team members + seat meter**, **snippets CRUD**, auto-replies (10 kinds, resolve-or-silent), WhatsApp channels (QR link, disconnect vs unlink), keywords, teams + routing strategy. `?tab=` deep links honored |

Legacy `/overview /users /billing /templates` → redirect stubs into the above.

### 3.3 Platform owner console (`/platform/subscribers`)
- Subscriber list: provisioning state, usage vs quota, gateway port
- Create subscriber (admin identity + org + channel), destroy (queued teardown)
- Gateway actions: retry / suspend / resume / restart
- Billing actions: activate plan, mark payment failed, cancel
- **Read-only tenant view**: "View" ⇒ `X-Organization-Id` header ⇒ full tenant
  UI read-only, amber banner naming the subscriber, every request audited
  (`PLATFORM_VIEW` rows); writes rejected; forged header from a tenant is
  ignored (verified). Owner with no selection sees only the console.

### 3.4 Messaging pipeline (verified end-to-end this week)
```
inbound:  customer → gateway → tokenized webhook → BullMQ → contact upsert
          → getOrCreateActiveConversation (reopen-preserving) → CSAT intercept
          → keyword detect → configurable auto-reply (or silence) → auto-assign
          (round-robin / least-open, caps, away-aware) → socket to team room
outbound: composer → Message row (persist-first) → gateway → SENT/FAILED
          → ack webhook → DELIVERED/READ (+ CampaignRecipient advance)
```

---

## 4. Respond.io parity scorecard

| Capability | Respond.io | RabiTech |
|---|---|---|
| Team inbox, threading, assignment | ✔ | ✔ (round-robin + least-open + caps) |
| Internal notes / collaboration | ✔ | ✔ notes; ✘ @mentions, typing-collision |
| Snippets + shortcodes | ✔ | ✔ full CRUD + composer expansion |
| Contacts, tags, custom fields | ✔ | ✔ (custom-field UI thin) |
| Saved segments | ✔ | ✘ — filter DSL exists, not saveable (P10-a) |
| Broadcasts + delivery reports | ✔ | ✔ incl. real delivered/read acks |
| Auto-replies / away / welcome | ✔ | ✔ 10 configurable kinds |
| **Visual workflow builder** | ✔ flagship | ✘ — Phase 11 |
| AI assist / RAG | ✔ | ✘ — deliberately last |
| Omnichannel (TG/FB/IG…) | ✔ | ✘ WhatsApp only, by design for now |
| Official WhatsApp Cloud API | ✔ | ✘ unofficial gateway (risk: see runbook) |
| Reports/analytics | ✔ | ✔ core; ✘ SLA, channel-volume charts |
| Multi-tenant + white-label + metering + billing | n/a (they're the SaaS) | ✔ — our differentiator |

---

## 5. Dead-flow register

All found via analysis passes; each was verified dead, then fixed or removed.

| # | Dead flow | Resolution |
|---|---|---|
| 1 | `/api/network` called on login pre-auth → guaranteed 401, leaked LAN IPs | removed |
| 2 | Login page showed devs' `scripts\allow-lan.cmd` instruction to customers | customer-facing copy |
| 3 | Platform owner saw 5 tenant links that could never load | console-only nav + read-only view feature |
| 4 | `?tab=` params from folded routes ignored — `/templates` (3 live links) landed nowhere | tab→section map + scroll |
| 5 | Snippet management UI didn't exist (usable, not creatable) | snippets card, full CRUD |
| 6 | `createSystemUser` in data layer, called from nowhere — no way to add an agent | team-members card |
| 7 | Campaign `tag` targeting ignored server-side — every campaign hit all contacts | filter-DSL audiences |
| 8 | Campaign sends: `:` job ids — every send silently failed | `--` ids |
| 9 | Delivery acks received and discarded for campaigns | waMessageId capture + monotonic advance |
| 10 | Webhook registration only in provisioning path — live session had none, all inbound dropped | self-healing reconcile on session-connected |
| 11 | `WhatsappSession.phoneNumber` written once, never refreshed — UI showed the wrong number | refresh on connect |
| 12 | Empty branding → `#000000` swatch → one save = black-on-black tenant | default-hex fallback + data repair |
| 13 | Billing webhook branched on literal `manual.*` names — real provider would activate nobody | canonical `PaymentEventKind` |
| 14 | Mobile: sidebar 220px fixed, thread pane **0px** — unusable on phones | drawer + one-pane flow |
| 15 | `stats.it` read after API removed the key — Reports crashed while typecheck passed | type + page fixed |
| 16 | ISP remnants in campaign dialog (`باقة 200 ميجا`, prices) | purged |

**Known-remaining (accepted, not dead):** Reports on live tables (works, scale
concern); demo-org sessions `it-support`/`marketing` disconnected with stale
numbers (display-only; the shared number now lives on `ostudio-primary`).

---

## 6. Phase ledger

### Completed — with the evidence that closed them

| Phase | Evidence |
|---|---|
| **P0–P1 Hardening + Tenancy** | **57/57** gate; composite FKs; fail-closed scope; rate limits; secrets guard |
| **P1.5 Branding/white-label** | per-org tokens injected at runtime; "Powered by" tier-gated |
| **P3 Metering** | UsageEvent ledger, exact MAC, rollups; quota errors block outbound |
| **P4 Navigation & Settings IA** | 5-item nav; stubs redirect; `?tab=` honored; snippets restored; verified in browser |
| **P5 Campaign Manager (core)** | audience preview 8→2 filtered; report endpoint; scheduler worker w/ conditional claim; throttling; ack chain proven sent→delivered→read with replay guard |
| **P6-billing foundation** | provider-agnostic activation **proven**: signed webhook → 200 → tier FREE→GROWTH → gateway provision queued, zero human steps |
| **P7 Auto-assignment** | wired in inbound worker; strategies + caps per team in Settings |
| **P8 (client-facing part)** | seats enforced (402, no orphan identity, ENTERPRISE unlimited); seat meter; team mgmt; plan carries pricing→signup |
| **Re-theme (user-decided)** | Respond.io palette live (`#0066FF`/`#0F172A`/`#F8FAFC` measured in-browser); WCAG sweep to 0 failures on inbox+reports; branding-inject pitfall documented |
| **Gateway stabilization** | inbound self-healing + SSRF allowlist (50/0 deliveries); outbound fixed via image update (pins WA Web version); runbook written |
| **M1 Consent & opt-out** | STOP/إلغاء/הפסק matched on the whole trimmed message, never a substring; broadcasts exclude `OPTED_OUT` unconditionally with the exclusion counted back to the admin; settable per contact by any agent; org-scoped in the gate |
| **M2 RTL correctness** | per-message first-strong direction — an Arabic message renders `dir="rtl"` even with the interface in English; logical CSS; tabular figures |
| **P9 Platform pricing control** | plan/MAC/discount/credit overrides resolved at **read time** — never written into `OrganizationConfig`, so expiry needs no sweeper and drift detection stays meaningful; drift now distinguishes intentional override from genuine divergence; audit row written in the same transaction as the override; gate 50/50 |
| **P11 Workflow engine** | triggers → conditions → 9 actions on BullMQ, WAIT_DELAY as a delayed re-enqueue; a workflow cannot outrun consent, the plan, or itself (depth cap + re-entry window); HTTP_WEBHOOK guarded against SSRF at both shape and resolved address, blocked at save **and** at run |
| **M4 Dark theme** | one `.dark` token block re-themes everything, because components read tokens not literals; the regression had left `className="dark"` hardcoded with no palette behind it; audit surfaced hardcoded hexes, a raw palette class failing AA in light, and a `--warning` token whose value disagreed with its own comment; 0 dark failures across four views |
| **M8 CSV import** | mandatory consent affirmation enforced server-side; an import never resurrects an opted-out contact; phones validated as E.164 but stored digits-only so an imported contact matches their own inbound message; chunked at 250/transaction |
| **H1 Gateway health monitor** | two probes — a free status poll every 15 min and an unmetered internal self-send every 6 h that catches outbound failing while the session reports healthy; caught that `getStatus` returns 200 for a *disconnected* session, which the first cut would have reported as healthy; `internal` bypass pinned by a gate check that a normal send is still metered; gate 54/54 |
| **P10-a Saved segments** | named stored M3 filters; name uniqueness is a partial case-insensitive index so a soft delete frees the name; validator reuses the private `compileRule` per leaf so it cannot drift from the vocabulary; **found and fixed a tenancy hole — `findFirst`/`findFirstOrThrow` were unscoped in the extension, affecting ~20 call sites incl. the inbound path**; gate 52/52 |
| **M3 Filter vocabulary** | typed date/number/multi-value operators; activity + broadcast-history dimensions; nested groups to depth 3; vocabulary **served** by `/api/contacts/filter-schema` rather than hardcoded; 28 filters verified live incl. a cross-tenant campaign-id probe blocked when buried in a nested group |

### Remaining — in build order, with definitions of done

**P8-b · Tenant subscription panel** — ✅ **DELIVERED 2026-08-21**
Settings tab: plan name, live MAC meter, invoice list (`listInvoices`), upgrade
CTA (→ checkout when payments land; → contact page until then). Gated features
**shown, not hidden**: Free admin sees "البث — متوفر في باقة Growth" + upgrade
button, never a missing menu item. Entitlements read from `plans.ts` only.
*Done when:* a Free admin can see exactly what upgrading buys, from inside the app.
**Met.** `GET /api/billing/summary` (one call: plan, entitlements, seats, meters,
invoices) · subscription card · `useEntitlements()` + `UpgradeGate`, broadcasts
shown-not-hidden. Server enforcement verified independently of the UI gate.
Also added `quotaDrift`: `Organization.tier` and `OrganizationConfig` are two
stores that can silently diverge with enforcement following the config, letting
a tenant keep quotas they no longer pay for.

**P9 · Platform pricing control** — ✅ done, see docs/TODO.md

**P9 (original brief)** — ~1 week
`Organization`: `planOverride, macQuotaOverride, discountPercent, creditCents,
overrideReason, overrideExpiresAt`. Console UI to set them; entitlement
resolution honors overrides; every override audited.
*Done when:* owner can give a bespoke deal without touching the database.

**P10-a · Saved segments** — ~4 days (pulled forward: cheap, high demo value)
`Segment` model (name + filter JSON, org-scoped). Save from contacts filter
builder; pick in campaign Target step; live count.
*Done when:* "VIP آخر ٣٠ يوم" is defined once and reused in three broadcasts.

**P10-b · Payments live** — ~1 week, **blocked on business entity/VAT decision**
One `PaymentProvider` class + one registry line. Full map incl. Stripe event
table in `BILLING-PROVIDER-GUIDE.md`. Merchant-of-record (Paddle/LemonSqueezy)
removes the tax work if selling internationally.
*Done when:* card checkout → auto-activation with zero human steps (activation
half is already proven).

**P11 · Visual workflow builder** — 6–8 weeks · **the flagship**
Order matters: (1) schema `Workflow/WorkflowNode/WorkflowRun` — DAG as JSON,
runs as rows so waits survive restarts; (2) BullMQ executor, `Ask a Question` /
`Wait` as suspended runs; (3) nodes by value: Send Message → If/Else → Assign →
Date&Time branch → Update Contact → Close → Ask Question → HTTP Request;
(4) React-Flow canvas **last** — engine is testable headless, canvas is
worthless without it. Reuses: triggers→socket events, assignment service,
working-hours util. Skip (documented): Random Split, Zapier/Make nodes (generic
HTTP subsumes), GraphQL API, skills routing.
*Done when:* "on new conversation, outside hours → send template X, assign
team Y, tag Z" is built by an admin on the canvas and survives a backend restart
mid-wait.

**P12 · Channel strategy** — decision then ~4–5 weeks
WhatsApp **Cloud API** as first-class channel beside OpenWA (official = no ban
risk = enterprise-sellable; `OrganizationChannel.kind` is ready). Identity
resolution / contact-merge lands *with* the second channel, not before.
Omnichannel (TG/FB/IG) only after Cloud API.

**P13 · AI / RAG** — last, deliberately
`pgvector` (same DB, same isolation — **no** Mongo/Pinecone), doc ingestion,
AI-assist drafting, then an AI node in P11's engine. Most-demoed,
least-load-bearing; worthless before workflows exist.

**Marasil-parity track (docs/TODO.md).** M1–M3 done. **M4** dark theme ·
**M5** design-system hardening · **M6** inbox structure · **M7** reports
consolidation · **M8** roles/restrictions **and building CSV import, which does
not exist at all** — today the only way a contact enters RabiTech is by messaging
in. Two things are deliberately deferred rather than forgotten: an **async rule
compiler** (needed for "never replied *since campaign X was sent*", the Marasil
headline filter we ship only half of) and **estimated audience counts** (not
needed below ~50k contacts per tenant).

**Continuous hardening backlog:** health monitor + scheduled self-send (gateway
breakage is currently discovered by users); per-org plan-aware campaign rate
limits (queue-per-org or Redis token bucket — BullMQ group limits are Pro);
Reports onto `PlatformDailyMetric` rollups; custom-field editing in contact
panel; @mentions.

---

## 7. Blockers only the owner can clear

| # | Item | Why it blocks |
|---|---|---|
| 1 | **Rotate DB password** (`ALTER USER admin …` — command in SECURITY-ROTATION), then `ALLOW_INSECURE_SECRETS=0` | backend screams `RUNNING WITH INSECURE SECRETS` every boot; shipped default credentials |
| 2 | **Rotate `OPENWA_API_KEY`** off `dev-admin-key` | anyone on the network controls the WhatsApp gateway |
| 3 | **Domain + TLS** (VPS, reverse proxy) | all logins & customer conversations currently cross the network in cleartext; also prerequisite for payment webhooks |
| 4 | **Business entity + VAT** decision | gates P10-b provider choice (MoR vs direct) |
| 5 | ToS + privacy policy | selling without them is exposure |

**#1–#3 are the entire gap between "everything works" and "safe for a paying
client."** The code side is ready.

---

## 8. Orchestrator's operating rules

1. Verify live, then claim. Every "done" above carries its proof.
2. One migration = hand-written SQL + `prisma generate` + gate re-run.
3. Any inbound/outbound change → re-run the webhook + send self-tests in the
   runbook before calling it fixed.
4. Never `perl -0pi` with Arabic/emoji patterns; `inbox/page.tsx` gets
   exact-match edits only.
5. New env var → add to `docker-compose.yml` explicitly or it doesn't exist.
6. Test data is cleaned after every live verification (campaigns, contacts,
   recipients — zero residue policy).
7. Docs updated in the same session as the change: this file, ROADMAP-REMAINING,
   runbook. A fix that isn't written down will be re-broken.
