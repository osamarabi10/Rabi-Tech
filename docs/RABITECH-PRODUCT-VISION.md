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
| **مجاني / Free** | Free | TBD | TBD — see OQ-3 | Baseline |
| **Standard** | Owner-set | Owner-set | **Choice**: OpenWA QR **or** Meta API (BYOT) | Inbound + outbound messaging **only** |
| **Growth** | ~$49 *(example)* | ~2,500 *(example)* | Meta API only | Owner-chosen |
| **Business** | ~$199 *(example)* | ~10,000 *(example)* | Meta API only | Owner-chosen |
| **Enterprise** | Owner-set | Unlimited | Meta API only | Owner-chosen, full manual control |

**مجاني / Free** is the baseline entry point. Its limits and its channel are not
yet decided (OQ-3), and that gap matters more than it looks — it determines
whether Free is usable before the Meta channel exists.

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

So the owner can today make an exception for one customer, but cannot change the
menu. Closing that gap is §6.1.

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

## 4. Open questions

Unresolved. **Do not guess these into code.**

### OQ-1 — What does "رقم واتساب تلقائي / automatic WhatsApp number" mean on a BYOT tier? ⚠ BLOCKING

This is the most important open question in this document, and it appears
self-contradictory as stated.

The Meta-only tiers are **bring-your-own-token** (§3.3): the customer supplies
their own Meta credentials. But those tiers have also been described as offering
an *automatic WhatsApp number*, which implies RabiTech provisions a number on the
customer's behalf. Those two cannot both be true without a third thing existing —
a provisioning arrangement, a reseller relationship, or a Meta Tech Provider
setup — none of which is described anywhere.

Possible readings, none confirmed:

1. RabiTech provisions the number under a Meta Tech Provider arrangement, and
   "BYOT" applies only to customers who already have their own.
2. "Automatic" describes automated *setup assistance* on top of credentials the
   customer still supplies.
3. It is a carry-over from the OpenWA flow, where a number is paired by QR, and
   does not apply to Meta tiers at all.

**Resolve before the Meta channel is built.** The answer changes the onboarding
flow, the credential storage model, and what the tier can honestly promise.

### OQ-2 — Confirm the channel policy

Is Standard genuinely the only edition with a channel choice, and are Growth,
Business, and Enterprise genuinely Meta-only? See §3.2. This determines whether
three of five editions are unsellable until the Meta adapter ships.

### OQ-3 — Free edition: limits and channel

Neither the active-contact limit nor the channel for **مجاني / Free** has been
decided. The channel half is the more urgent: if Free is Meta-only it is blocked
alongside the paid tiers; if it runs on OpenWA it is available today. This
directly changes the count in §5.3.

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
the same provider interface as OpenWA, not a parallel system. **Blocked on OQ-1**
— the credential and provisioning model cannot be designed until "automatic
number" versus bring-your-own-token is resolved. Unblocks three editions.

### 6.4 Add per-edition channel policy

The mechanism that enforces §3.2 — which channels an edition may use. Does not
exist in any form. Blocked on OQ-2.

## 7. Change log

| Date | Change |
|---|---|
| 2026-08-28 | Created. Records the five-edition ladder, the owner-control principle, the channel policy, and OQ-1 through OQ-4, with ground truth verified at `1468bfce`. |
