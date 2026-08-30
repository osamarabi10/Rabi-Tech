# RabiTech Product Vision — Editions and Pricing

> Status: **canonical.** This is the source of truth for the commercial model:
> which editions exist, what each one sells, and who controls the numbers.
> Recorded 2026-08-28 from the product owner's stated model.
> Precedence: on editions, channels, and pricing structure, this document wins
> over every other document in `docs/` and over the current code.

## 0. Why this document exists

Until now the edition and pricing model existed only in conversation. Nothing in
the repository described it, so every phase that touched billing, channels, or
entitlements had to infer the commercial intent from the code that already
happened to be there — which is backwards, because the code is an incomplete
draft of this model rather than a statement of it.

The concrete reason this is being written down: work was recently planned
against `docs/FULL-PARITY-PLAN.md`, a document that had never existed in this
repository — not in the working tree, not in any commit on any ref. Reasoning
proceeded for some time against a file that was not there. A model held only in
conversation is the same failure waiting to happen, and this document is the
correction.

**What this document governs:** what the editions are, what each includes, which
channels each may use, and the principle that the owner controls the values.

**What it does not govern:** how overrides resolve at runtime (see
`docs/P9-PRICING-CONTROL-PLAN.md`), when this gets built (see
`docs/PHASES-TO-LAUNCH.md`), or how the provider abstraction is shaped (see
`docs/RESPOND-IO-PARITY.md`).

## 1. Precedence and relationship to existing documents

| Document | Owns | Relationship to this one |
|---|---|---|
| **This document** | *What* the editions are — the ladder, channel policy, owner-control principle | Source of truth for the commercial model |
| `docs/P9-PRICING-CONTROL-PLAN.md` | *How* per-subscriber commercial overrides resolve | Complementary, and **shipped** — note its status line still reads `plan only, nothing implemented` (line 5), which is stale; see §5.1 for the evidence it landed. Do not read that line as current |
| `docs/PHASES-TO-LAUNCH.md` | *When* — commercial launch sequencing | F0.1 (payment provider) blocks F2 entirely. **F5.5 Meta Cloud API as a second channel (P12)** is already scheduled there (line 190) |
| `docs/PROJECT-SPEC.md` | Shipped-state record | Confirms P9 done (line 206) |
| `apps/backend/src/modules/billing/plans.ts` | The live tier catalog | The current 4-tier implementation. This document supersedes it as intent; the code has not caught up |
| `docs/RESPOND-IO-PARITY.md` | Provider architecture | Establishes WhatsApp Personal (QR) and Cloud API as **two providers behind one interface** (line 262). The Meta work in §6 is that adapter |
| `docs/ROADMAP-REMAINING.md` | Older roadmap | Last updated 2026-08-20 and self-describes as authoritative. On editions and pricing, defer to this document |

## 2. The edition ladder

Five editions. **Every figure below is an editable example default, not a
commitment** — see §3.4.

| Edition | Price | Active contacts | Channels | Features |
|---|---|---|---|---|
| **مجاني / Free** | Free | 100 *(with 100 outbound)* | Both, during trial — see OQ-3 | 3-day trial; higher features shown but locked |
| **Standard** | Owner-set | Owner-set | **Choice**: OpenWA QR **or** Meta API (BYOT) | Inbound + outbound messaging **only** |
| **Growth** | ~$49 *(example)* | ~2,500 *(example)* | Meta API only | Owner-chosen |
| **Business** | ~$199 *(example)* | ~10,000 *(example)* | Meta API only | Owner-chosen |
| **Enterprise** | Owner-set | Unlimited | Meta API only | Owner-chosen, full manual control |

**مجاني / Free** is a **3-day trial**, not a permanent free tier: inbound and
outbound messaging, higher-tier features visible but locked, and a hard block on
all system access at expiry until the workspace upgrades. It is bounded on two
axes — 100 active contacts and 100 outbound messages alongside the 72-hour clock
— because a limit of null would mean unlimited and leave Free indistinguishable
from Enterprise on those meters if the clock were ever disabled. Its intended
channel policy is **both**, which knowingly cuts against §3.2; see OQ-3.

**Standard** is deliberately narrow: inbound and outbound messaging, nothing
else. It is also the **only** edition that offers a channel choice, letting a
customer start on OpenWA QR without Meta credentials, or bring their own Meta
token if they have one.

**Growth** and **Business** are the volume tiers, separated by active-contact
allowance. The ~$49/~2,500 and ~$199/~10,000 pairings are illustrative starting
points for the owner to set, not fixed prices.

**Enterprise** removes the active-contact ceiling and hands the owner full
manual control over every value for that subscriber — the tier where a
negotiated deal is expressed directly rather than approximated by a preset.

## 3. Governing rules

### 3.1 Owner control — partly built, and the distinction matters

**The rule:** every value — price, active-contact limit, allowed channels,
feature set — is controlled by the owner from the control panel. Nothing is
hardcoded.

**What is true today** is narrower than the rule, and stating it precisely is
the whole point of this document:

> **SUPERSEDED 2026-08-30.** The two bullets below are the 2026-08-28 snapshot,
> before migrations `20260917090000_plan_editions` and
> `20260918090000_plan_editions_seed` shipped. Verified before this correction:
> `apps/backend/prisma/schema.prisma` now has a `Plan` model,
> `apps/backend/src/modules/billing/plans.ts` has `PlanCode = 'FREE' |
> 'STANDARD' | 'GROWTH' | 'BUSINESS' | 'ENTERPRISE'`, the live database has
> five `Plan` rows, and `docker compose exec -T backend npx prisma migrate
> status` reports 67 applied migrations and no pending migration. Read the
> "Both halves are now shipped" paragraph below as the current state.

- **Per-subscriber overrides are shipped.** An owner can override a specific
  organization's plan, MAC quota, discount, and credit, with an expiry and an
  audit trail, from the platform console. This is database-backed
  (`Organization.planOverride`, `macQuotaOverride`, `discountPercent`,
  `creditCents`, `overrideReason`, `overrideExpiresAt`, `overrideSetBy` —
  `apps/backend/prisma/schema.prisma:33-44`), resolved at read time
  (`apps/backend/src/modules/billing/entitlements.resolver.ts`), and surfaced in
  the console (`apps/frontend/app/platform/subscribers/page.tsx`).
- **The ladder itself is not.** Which editions exist, what each grants, and each
  list price live in a TypeScript constant — `PLAN_ENTITLEMENTS` in
  `apps/backend/src/modules/billing/plans.ts` (110 lines). Changing an edition,
  adding one, or repricing a tier is a **code change and a deploy**, not a
  console action.

**Both halves are now shipped** (2026-08-29, migrations 65 and 66). The ladder
lives in the `Plan` table, is edited from `/platform/editions`, takes effect
without a deploy, and survives a restart — the last of those being the property
`ensurePlans` had to stop breaking.

> **Correction.** "Takes effect without a deploy" was not true when first
> written. The in-process cache never loaded — the refresh ran unscoped on a
> timer and threw every tick — so every read fell through to the constant while
> the database held the edited value. Fixed in `bc66c468`; see the correction
> at the top of §6b of the checkpoint for why it stayed invisible. The constant is now only a seed source and a
boot fallback, and a harness check asserts the database matches it field by
field.

Two fields are carried but **not enforced**, stated in the console with their
reason: `autoProvisionGateway` has no enforcement site, and `allowedChannels`
waits on OQ-2/OQ-4. Creating a new edition is not available either: a code must
exist in `PlanCode` before anything resolves it. See §6.1 for what remains.

### 3.2 Channel policy — OPEN QUESTION

**As stated:** Standard is the only edition offering a channel choice
(OpenWA QR or Meta API). Growth, Business, and Enterprise are **Meta API only**.

> **⚠ OPEN QUESTION (OQ-2) — unconfirmed.** This rule is recorded as the owner
> stated it but has not been confirmed. It is load-bearing: it decides whether
> the paid tiers are reachable at all before the Meta channel exists (§5.3).
> Confirm before any edition work begins.

No per-edition channel policy exists in code in any form today — there is no
mechanism that permits or forbids a channel based on tier.

### 3.3 The Meta path is bring-your-own-token

Where an edition uses the Meta API, the **customer supplies their own Meta
credentials**. RabiTech does not resell or pool Meta access.

This has a direct consequence for onboarding: a customer on a Meta-only tier
cannot send anything until they have completed Meta's own onboarding and
provided a token. Any edition that is Meta-only inherits Meta's approval
timeline as part of its activation path.

### 3.4 Example figures are defaults, not commitments

Every dollar amount and contact limit in §2 is an **editable example default**.
They exist to make the ladder concrete, not to fix it. No number in this
document should be treated as a price the business has committed to, and no
implementation should hardcode one as though it were.

## 3.9 Known gap — a Meta channel can reply, but cannot initiate

**Decided 2026-08-30, during the Meta send path (Phase 4.5).**

Meta permits free-form messages only within **24 hours of the customer's last
message**. Outside that window it accepts nothing but pre-approved templates —
and RabiTech has no Meta template management. Our `MessageTemplate` rows are
quick replies stored in our own database; they are unrelated to, and not
registered with, Meta.

The consequence, stated plainly so it is not discovered by a customer:

> **A workspace sending through Meta can answer a customer within 24 hours of
> their message, and can never start a conversation.** Broadcasts to a Meta
> channel are refused. A first message to a new lead is refused. A follow-up the
> day after a conversation goes quiet is refused.

**This is material to the paid tiers.** Growth, Business and Enterprise are the
Meta-capable editions in §3.2, so this limitation lands on the editions
customers pay most for. A business buying Business expecting to run broadcasts
over its own Meta number cannot, until template support ships. That is a launch
conversation, not a support ticket to have later.

**What it is not.** It is not a defect in the send path, and it is not a
limitation of OpenWA — OpenWA has no window and can message anyone, which is
precisely why the two channels needed a capability descriptor rather than a
shared assumption. The restriction is Meta's, and it applies to every product
built on the Cloud API.

**How the product behaves about it today.** The send path refuses out-of-window
sends *locally*, before calling Meta, with an Arabic message that says the
window closed and that the customer must write first. Refusing locally rather
than letting Meta reject matters for a reason beyond legibility: rejected sends
depress a number's quality rating, which governs its messaging tier, so relaying
requests we already know will fail would degrade the customer's own number to
tell them something we could have said ourselves. The channels card carries the
same statement whenever the active channel reports
`canInitiateConversations: false`, so an admin reads it on connection rather
than on first refusal.

**What closes it.** Meta template management — creating templates, submitting
them for approval, tracking approval state, and sending them. The messaging-tier
ceiling (250 recipients per rolling 24 hours for an unverified business) becomes
enforceable in that same step and not before, because until templates exist no
business-initiated conversation can start, so the ceiling guards a state that
cannot be reached. Building the counter earlier would be machinery defending an
impossibility.

## 4. Open questions

Unresolved. **Do not guess these into code.**

### OQ-1 — "رقم واتساب تلقائي / automatic WhatsApp number" — RESOLVED 2026-08-29

**It means the connection completes automatically once credentials are supplied.
It does not mean RabiTech provides the number.** The apparent contradiction with
bring-your-own-token was a contradiction in reading, not in the product.

The customer creates their own Meta Business account, obtains their own WhatsApp
Business number, generates a System User token, and pastes their **Phone Number
ID**, **WABA ID** and **access token** into RabiTech. RabiTech never touches Meta
billing; the customer pays Meta directly. What is automatic is everything after
the paste: validating the number, validating WABA access, subscribing the app to
the WABA so inbound messages actually route, and reading back the messaging tier
and quality rating. No QR scan, no support ticket, no waiting.

That contrast is with the OpenWA path, where a person scans a QR code and the
session can drop. On Meta there is nothing to scan and nothing to re-pair — the
number is connected the moment the credentials validate, which is what
"automatic" was describing.

Consequences now settled:

- **The credential vault is a vault of other businesses' secrets.** A System User
  token can send as that business. Losing one is impersonating a company to its
  own customers, which is a different risk class from losing RabiTech's own
  OpenWA key.
- **Tokens die on their own** — a password change, a permission revoke, or the
  System User being deleted. The channel needs a degraded state and revalidation;
  it cannot assume a credential that worked yesterday works today.
- **RabiTech carries no Meta cost and no Meta billing relationship**, so nothing
  in the ladder needs to model per-message Meta pricing.

The original three candidate readings are superseded. The one that was correct is
the second: automated setup on top of credentials the customer supplies.

### OQ-2 — Confirm the channel policy

Is Standard genuinely the only edition with a channel choice, and are Growth,
Business, and Enterprise genuinely Meta-only? See §3.2. This determines whether
three of five editions are unsellable until the Meta adapter ships.

### OQ-3 — Free edition: limits and channel — DECIDED 2026-08-29

**Free is a 3-day trial**, inbound and outbound messaging, with higher-tier
features shown but locked. At expiry all system access is hard-blocked until
upgrade.

- **Limits: 100 active contacts, 100 outbound messages.** Bounded on two axes,
  not only the clock. Null would mean unlimited, which would make Free
  indistinguishable from Enterprise on those meters if the clock were ever
  disabled.
- **Duration: 72 hours**, set as `billing.trialHours` in the platform console
  (`platform/settings`). The shipped default is `3` — three *hours*, not days —
  so 72 must be set deliberately. A change affects **new signups only**:
  `trialEndsAt` is stamped once at signup, so shortening the setting cannot
  retroactively expire someone mid-trial.
- **The expiry machinery already exists.** `trial.service.ts` resolves state at
  read time and `access-gate.middleware.ts` returns `TRIAL_EXPIRED`. There is no
  job and no trigger to build.

**Channels: both, during the trial — and this contradicts §3.2.** That rule makes
Standard the only edition offering a choice. Free offering both is a deliberate
trial design: a prospect should be able to try the transport they intend to buy.
Recorded here as a decision rather than left to emerge as a side effect.

It is **not yet implemented**. The seed ships `["OPENWA"]`, the settled default,
because `allowedChannels` carries no enforcement and Meta does not exist (§5.2).
Revisit when OQ-2 and OQ-4 are answered: if Standard-only-choice is confirmed,
Free needs an explicit exemption; if the rule softens, this stops being a
conflict.

### OQ-4 — Is Standard's Meta option also BYOT?

Standard offers a choice of channel. If a Standard customer picks Meta, do they
bring their own token on the same terms as the higher tiers, or is Standard's
Meta path different? Interacts with OQ-1.

## 5. Ground truth — what exists versus what must be built

Verified against the tree at commit `1468bfce`, 2026-08-28.

### 5.1 What exists

- **A four-tier catalog as a code constant.** `PlanCode = 'FREE' | 'GROWTH' |
  'BUSINESS' | 'ENTERPRISE'` with per-tier limits (active contacts, outbound
  messages, campaign sends, custom fields, users, workflows, campaign rate) and
  four booleans (`autoProvisionGateway`, `customDomain`, `whiteLabel`,
  `maskContactDetails`) — `apps/backend/src/modules/billing/plans.ts`.
- **P9 per-subscriber overrides — shipped.** Schema columns at
  `apps/backend/prisma/schema.prisma:33-44` with an index at line 105;
  read-time resolution in `entitlements.resolver.ts`; recorded as done in
  `docs/PROJECT-SPEC.md:206`. (P9's own status line is stale — see §1.)
- **An owner console.** `apps/frontend/app/platform/` — `page.tsx`,
  `settings/page.tsx`, `staff/page.tsx`, `subscribers/page.tsx`.
- **Quota enforcement.** `assertMetricAvailable` / `assertSeatAvailable` in
  `apps/backend/src/modules/usage/entitlements.ts`, with numeric limits stored on
  `OrganizationConfig` (`schema.prisma:376-381`).
- **The OpenWA channel, working.** `OrganizationChannel`
  (`schema.prisma:589`), whose `kind` is a `String` defaulting to `"OPENWA"`,
  with per-organization encrypted credentials and a provisioning lifecycle.
- **`Organization.tier` is a `String`** (`schema.prisma:16`), not an enum — so
  the database is not what blocks a fifth edition.

### 5.2 What does not exist

> **SUPERSEDED 2026-08-30.** This section is the ground truth from commit
> `1468bfce` on 2026-08-28. It is retained for provenance and is no longer
> current for the ladder, Standard, or Meta. Verified before this correction:
> migrations `20260917090000_plan_editions`,
> `20260918090000_plan_editions_seed`, and
> `20260919090000_meta_credential_vault` are applied in the live database;
> `Plan`, `MetaChannelCredential`, `ConversationCategory`, and
> `ConversationClosure` all exist; the `Plan` table contains `FREE`,
> `STANDARD`, `GROWTH`, `BUSINESS`, and `ENTERPRISE`; and Meta backend code now
> includes a client, adapter, credential service/model, webhook handler, pure
> inbound normaliser, downloaded-at-ingest media storage, and monotonic status
> acks. What remains true from the list below: per-edition channel policy is
> still carried but not enforced, and there is still no separate transport-mode
> field.

- **No Meta / Cloud API implementation of any kind.** A search across
  `apps/backend/src`, `apps/frontend/lib`, and `apps/frontend/app` for
  `graph.facebook.com`, `cloud api`, `WABA`, `phone_number_id`, and
  `whatsapp_business` returns exactly one hit: a translation string at
  `apps/frontend/lib/i18n.tsx:748` rendering "Meta's official WhatsApp Cloud
  API" — landing-page roadmap copy, matching `PHASES-TO-LAUNCH.md:190`. There is
  no client, no adapter, no credential model, no webhook handler.
- **No Standard edition.** The string appears nowhere in the billing code or in
  `docs/` as an edition name.
- **No database-backed, owner-editable ladder.** Editions are a code constant.
- **No per-edition channel policy.** Nothing permits or forbids a channel by
  tier.
- **No transport-mode concept.** No enum or field distinguishes an OpenWA-only
  from a Meta-only from a mixed organization.

### 5.3 Functional consequence

> **SUPERSEDED 2026-08-30.** The consequence list below depended on "Meta does
> not exist" and "the ladder is a code constant." Both have been superseded by
> releases 65, 66, and 67. The current state is narrower: the owner-editable
> five-edition ladder exists, Standard exists, and the Meta adapter/vault/webhook
> path exists in code, but Meta is not usable for a real customer until the
> vault hard gate is opened (`OPENWA_API_KEY` rotated,
> `ALLOW_INSECURE_SECRETS=0`) and `META_APP_SECRET` /
> `META_WEBHOOK_VERIFY_TOKEN` are set. Meta channels can reply inside the
> 24-hour service window and cannot initiate until template management ships.

Stated precisely, because the rounded version is wrong:

- **Three editions are fully blocked** — Growth, Business, and Enterprise are
  Meta-only, and the Meta channel does not exist. They cannot be sold or
  delivered today.
- **Standard is partially available.** Its OpenWA QR path works with what is
  built. Its Meta path does not. A Standard customer could be onboarded today on
  OpenWA alone.
- **مجاني / Free is pending OQ-3.** Its channel is undecided, so its status
  cannot be determined. If Free is Meta-only, four of five editions are blocked;
  if Free runs on OpenWA, three are.

Additionally, **no edition can be configured by the owner without a deploy**,
because the ladder is a code constant (§3.1) — this is true even of the editions
that are otherwise deliverable.

## 6. What building this vision requires

Four workstreams, in dependency order.

> **SUPERSEDED 2026-08-30.** The workstream list below is preserved as the
> original build sequence. Workstreams 6.1, 6.2, and the schema/adapter/webhook
> portions of 6.3 have since shipped. The remaining current work is template
> management and messaging-tier enforcement, completing `/settings/channels`,
> real Meta end-to-end testing after the vault/secrets gates open, and the
> still-unresolved/enforced per-edition channel policy in 6.4.

### 6.1 Move the ladder from code constant to owner-editable records

`PLAN_ENTITLEMENTS` becomes database-backed and console-driven, so the owner can
change a price, a limit, a feature set, or add an edition without a deploy. Must
preserve the P9 override semantics already shipped: overrides resolve at read
time and are never written into `OrganizationConfig`, for the three reasons given
in `entitlements.resolver.ts`.

### 6.2 Add the fifth edition (Standard)

Blocked on 6.1 if it is to be owner-editable; otherwise a code change to the
`PlanCode` union and the `PLAN_ENTITLEMENTS` record. `Organization.tier` is
already a `String`, so no migration is needed for the column itself.

### 6.3 Build the Meta channel adapter

This is `F5.5 / P12` in `docs/PHASES-TO-LAUNCH.md:190`, and
`docs/RESPOND-IO-PARITY.md:262` already specifies the shape: a new adapter behind
the same provider interface as OpenWA, not a parallel system. **OQ-1 is resolved** (bring-your-own-token; see §4), so the credential and
provisioning model can now be designed. Unblocks three editions.

### 6.4 Add per-edition channel policy

The mechanism that enforces §3.2 — which channels an edition may use. Does not
exist in any form. Blocked on OQ-2.

## 7. Change log

| Date | Change |
|---|---|
| 2026-08-28 | Created. Records the five-edition ladder, the owner-control principle, the channel policy, and OQ-1 through OQ-4, with ground truth verified at `1468bfce`. |
| 2026-08-29 | OQ-1 resolved as bring-your-own-token; OQ-3 decided (Free = 3-day trial, 100/100). §3.1 corrected: "takes effect without a deploy" was untrue until `bc66c468`, because the edition cache never loaded. |
| 2026-08-30 | §3.9 added. A Meta channel can reply within 24 hours and can never initiate, because Meta requires approved templates outside the window and this product has no template management. Material to Growth, Business and Enterprise — the Meta-capable editions. Closes with template support, which is also when the messaging-tier ceiling first becomes enforceable. |
