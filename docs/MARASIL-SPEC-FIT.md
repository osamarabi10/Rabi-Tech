# Marasil spec → RabiTech: what applies, what cannot, what to steal

Analysis of *Marasil — Product Design Specification v1.0* (123 pages, 13 Aug 2026,
prepared for Mohanad) against RabiTech's verified state.

**Marasil is the same product as RabiTech.** Same category, same benchmark
(respond.io, inspected 13 Aug 2026), same target market (Israel and the
Arabic-speaking Middle East, Arabic/Hebrew/English, RTL-first), same shape:
multi-tenant workspaces, shared team inbox, contacts with custom fields,
filtered broadcasts, roles, workflows, operator console.

It is a **design document, not a codebase** — 123 pages of specification with no
implementation behind it. RabiTech is running code. So this is not a competitor
to catch: it is a very well-researched requirements list, most of which we can
mine directly.

---

## 1. The one decision that reframes everything

**Marasil is built entirely on Meta's WhatsApp Business Platform (Cloud API).
RabiTech runs OpenWA.** You have said the channel stays OpenWA, so a large part
of this spec does not port — and, importantly, some of it *inverts*.

Marasil's §10 lays out three onboarding models: **A** bring-your-own Cloud API
credentials (1–2 weeks), **B** Meta Tech Provider + Embedded Signup (4–8 weeks,
App Review), **C** full BSP reseller (3–6 months, commercial negotiation).
Its own recommendation is ship on A, start B in parallel.

RabiTech is effectively on a fourth model the spec does not consider — **an
unofficial WhatsApp Web gateway** — which trades Meta's approval process and
per-message fees for ban risk and zero telemetry.

### What becomes irrelevant on OpenWA

| Marasil requirement | Why it does not apply |
|---|---|
| **24-hour customer service window** — "prominent, always-on" indicator, their single biggest claimed advantage over respond.io | A Meta API rule. WhatsApp Web has no such restriction, so there is no window to display. |
| **Template approval lifecycle** (PENDING/APPROVED/REJECTED/PAUSED), Meta template CRUD, webhook-driven status sync, 6-hourly reconciliation | No Meta template registry exists. Our `MessageTemplate` rows are purely local — this entire governed-resource module collapses into the snippets we already ship. |
| **Quality rating, messaging limits, throughput tiers** | Meta telemetry. Not exposed by WhatsApp Web. |
| **Per-message cost estimation before broadcast** | No Meta conversation pricing to estimate. |
| **Embedded Signup, WABA/phone_number_id onboarding, App Review** | Our onboarding is a QR scan. Strictly simpler. |
| **"Only APPROVED templates may be broadcast" (BR-16.1)** | No approval state exists. |

That is roughly a third of the specification, and it is a third we get to skip.

### What becomes *more* important, not less

This is the part worth dwelling on. Meta's constraints are annoying, but they
are also **guard rails**. Removing them does not remove the underlying risk — it
removes the warning.

| Meta gives you | On OpenWA you have | What we owe the user instead |
|---|---|---|
| 24-h window blocks risky sends | Nothing blocks anything | Blasting cold contacts is exactly what gets a number banned. The window UI is unnecessary; **ban-risk awareness is not.** |
| Quality rating tells you the account is degrading | No signal at all | We are flying blind. This is why **H1 (gateway health monitor)** is in the TODO — today an outage is discovered by the customer. |
| Cost shown before a 20,000-message broadcast | No per-message cost | Replace "this will cost ₪X" with **"this will send 20,000 messages from your number"** — the risk, not the invoice, is the thing to surface before confirmation. |
| Meta enforces opt-out on marketing templates | Nothing enforces it | **Consent handling becomes our responsibility entirely.** See §3.1 — this is the most serious gap the spec exposes. |

Marasil's design principle #1 is *"make the constraint visible."* On OpenWA the
constraint is not a rule, it is a **risk**. Same principle, different content.

---

## 2. Where RabiTech already matches or leads

Verified against our running system, not aspiration:

| Marasil requirement | RabiTech |
|---|---|
| Workspace = tenant, all data partitioned by `workspace_id` | ✅ stronger — fail-closed `AsyncLocalStorage` scope + composite FKs `[id, organizationId]`; cross-tenant writes die at the database, not in app logic. 45/45 isolation gate. |
| Contact ≠ Conversation (permanent record vs bounded episode, reopens on reply) | ✅ exactly our `getOrCreateActiveConversation` — reopens RESOLVED preserving history |
| Shared real-time inbox, claim/assign/tag/close | ✅ 3-pane inbox, socket-live |
| Round-robin / least-busy routing | ✅ + workload caps and away-awareness |
| Snippets insertable in composer | ✅ `:shortcode` expansion + full CRUD |
| Custom fields (schema + per-contact values) | ✅ schema done, UI thin |
| Filter grammar reused across contacts and broadcasts | ✅ `contact-filter-dsl.ts` — same primitive, thinner vocabulary (see §3.2) |
| Broadcast pacing, dedup, per-recipient reporting | ✅ throttled worker, delivered/read acks, per-campaign report |
| Roles (Owner/Manager/Agent) | ✅ five roles, `requirePermission` matrix |
| Operator console: directory, usage, suspend | ✅ + subscriber creation and gateway lifecycle |
| **Impersonation, read-only, banner-flagged, audited** (FR-25.3) | ✅ **already shipped** — `X-Organization-Id`, amber banner, `PLATFORM_VIEW` audit rows, writes rejected, forged headers ignored |
| RTL/bilingual first-class (their #1 criticism of respond.io) | ✅ just completed — 412 literals, ar/he/en, no mixing |
| Multi-tenant billing, metering, plan entitlements | ✅ **ahead** — Marasil defers billing to a later phase |

**Marasil's five "meaningful improvements over respond.io" — where we stand:**

1. Channel-scoped template management — ⚠️ ours are workspace-scoped, not per-number
2. Composable filter → named Segments — ⏳ **P10-a, next up**
3. Lifecycle stages as configurable pipeline with inbox counts — ⚠️ field exists, no pipeline
4. Gradual broadcast pacing — ✅ shipped
5. Granular restrictions on top of roles — ❌ not built

---

## 3. What to steal — ranked by value to RabiTech

### 3.1 Consent / opt-out management — **the serious gap** 🔴

Marasil FR-16.6: three independent mechanisms feeding one consent state —
template opt-out button, **keyword matching (`STOP`, `UNSUBSCRIBE`, `توقف`,
`הפסק`, case-insensitive)**, and manual/API. Opt-out is instant and
workspace-wide. BR-16.2: *marketing broadcasts always exclude opted-out
contacts, and this cannot be overridden.*

**RabiTech has none of this.** No consent field, no keyword handling, no
broadcast exclusion. On Meta, the platform enforces some of it for you. On
OpenWA **nothing does** — so a tenant can broadcast to someone who has said STOP
three times, and we will happily send it.

That is a legal exposure in every market you named, and a fast route to a banned
number. It is also small: a `Contact.marketingConsent` enum, keyword detection in
the existing inbound worker (where CSAT interception already lives), and one
`WHERE` clause in `audienceWhere()`.

**Recommendation: insert as P10-a.0, before saved segments.** It is a day of
work and it removes a real liability.

### 3.2 Filter vocabulary — the campaign feature that matters

Ours: 3 categories (`contactField`, `tag`, `customField`) × 6 operators.
Marasil: ~20 dimensions across 9 groups, with type-aware operators (`within_last
N days`, `has any of`, `matches regex`, `between`, `on this day-of-year` for
birthdays).

The group that actually sells the product is **broadcast history**:

> *"received the July promo but never replied"* — the spec calls this "the single
> most common marketing request and impossible with the six observed filter
> types." We have exactly those six.

We already store what this needs (`CampaignRecipient` with per-recipient status,
plus delivered/read acks). It is a query away, not a schema change.

Also worth taking: **nesting to depth 3** with AND/OR groups (ours is flat
`$and`), and **live debounced count at 400ms** (ours is 350ms — close enough).

### 3.3 Segments — two details to get right in P10-a

Our P10-a is already specified. Two refinements from the spec:

- **FR-14.4: a segment is a stored query, not a stored list** — contacts enter
  and leave automatically. ✅ matches our plan.
- **BR-16.3: the audience is materialised and snapshotted at send time**, so the
  broadcast report reflects exactly who was targeted even if the segment later
  changes. ⚠️ **we had not specified this** — without it, a campaign report
  silently rewrites history. Adding to P10-a.
- FR-14.5: allow converting a dynamic segment to a static list.
- Private vs workspace-shared segments.

### 3.4 Reports — consolidate to five surfaces

Their strongest structural critique of respond.io: eleven report pages fragment
simple questions. Marasil consolidates to five, each answering one question —
Overview / Conversations / Team / Campaigns / Account health.

We have **one** page. Their five map cleanly onto what we already compute, and
their non-negotiable is right: **drill-down from every number to the underlying
conversations.** *"A manager who cannot click a number to see what it is made of
will not believe it."*

Note "Account health & cost" becomes **"Gateway health"** for us — session state,
failed-send rate, webhook delivery — which is exactly TODO item **H1**.

### 3.5 Granular restrictions on top of roles

Four toggles layered over the coarse role: restrict data export, restrict contact
deletion, restrict workspace settings, restrict integration settings. Cheap to
add to our existing `ROLE_PERMISSIONS` matrix, and the kind of thing that closes
enterprise deals.

### 3.6 CSV import hardening

Ours imports. Theirs: column mapping with fuzzy header matching, validation
preview (first 20 rows + valid/invalid summary), duplicate strategy
(skip/update/create), automatic `imported_{timestamp}` tag, **mandatory opt-in
declaration checkbox**, background job with live progress.

That opt-in checkbox pairs with §3.1 and costs nothing.

### 3.7 Smaller items worth queueing

- **Lifecycle as a configurable pipeline** with stage counts surfaced as inbox filters
- **Custom inboxes** — saved views in the inbox sidebar (the filter grammar's fourth consumer)
- **@mentions** + a Mentions system inbox
- **Quiet hours** enforced in the recipient's local time, derived from phone prefix
- **Broadcast clone** — respond.io users clone constantly
- **Files tab** on the contact panel — every media item exchanged, filterable
- **Activity timeline** — field changes with old → new and who made them
- **Voice note transcription** (they list it as a differentiator; we already handle voice notes end-to-end)

---

## 4. What to deliberately ignore

- **Google-only sign-in.** Their §8 mandates Google OIDC as the sole identity
  provider. Ours is email/password with a global `Identity` and per-org
  membership — the same model underneath, and not worth rewriting. Google can be
  added as an additional provider later if a customer asks.
- **Everything Meta-specific** in §1 above.
- **AI/RAG (§18)** — same position as our own roadmap: last, and worthless before
  the workflow engine exists.
- **The 123-page format.** Our `PROJECT-SPEC.md` holds itself to verified-live
  claims; this document is unimplemented design. Mine it for requirements, do not
  adopt its status claims.

---

## 5. Net effect on the roadmap

No phase is invalidated. Three additions:

| Where | Addition | Size |
|---|---|---|
| **New — before P10-a** | **Consent & opt-out** (`marketingConsent`, STOP-keyword detection, broadcast exclusion, opt-in checkbox on import) | ~1 day · 🔴 liability |
| **Into P10-a** | Snapshot audience at send time; private/shared segments; dynamic→static conversion | +0.5 day |
| **New — after P10-a** | **Filter vocabulary expansion**, especially broadcast-history dimensions | ~3 days · high demo value |
| Into P9 | Granular restrictions alongside commercial overrides | +1 day |
| Into H-backlog | Reports → five surfaces with drill-down; CSV import hardening; custom inboxes; lifecycle pipeline | — |

**P11 (workflow builder) remains the flagship gap.** Marasil specs it too (§17,
"draft-of-published"), which is one more independent confirmation that it is the
feature that defines this product category.

The headline: this spec validates RabiTech's architecture almost point for point,
and the largest single thing it exposes that we genuinely lack — with real legal
and account-safety consequences — is **consent management**.

---

## 6. The UI design (Part 4) — and how close we already are

The spec's Part 4 is a complete UX/UI design: strategy, information architecture,
six screen layouts, a design token set, a ~60-component inventory, RTL rules and
WCAG 2.2 AA targets. This is the most directly reusable part of the document.

### 6.1 Design tokens — near-identical to what we just shipped

Both derive from the same benchmark, and it shows:

| Purpose | Marasil | RabiTech (shipped) | |
|---|---|---|---|
| Panel / card | `bg-canvas` `#FFFFFF` | `--card` `#FFFFFF` | ✅ exact |
| Page canvas | `bg-subtle` `#F7F9FB` | `--background` `#F8FAFC` | ✅ ~same |
| Dividers | `border-default` `#DFE4EA` | `--border` `#E2E8F0` | ✅ close |
| Body text | `text-primary` `#111418` | `--foreground` `#0F172A` | ✅ close |
| Metadata | `text-tertiary` `#8B95A1` | `--muted-foreground` `#55637A` | ⚠️ **ours darker on purpose** — theirs is ~2.9:1 on white and fails AA |
| Primary action | `accent` `#1F6FEB` | `--primary` `#0066FF` | ✅ close |
| Success | `#1A7F5A` | `--success` `#047857` | ✅ close |
| Warning | `#B4690E` | `--warning` `#B45309` | ✅ **effectively identical** |
| Danger | `#C0392B` | `--danger` `#DC2626` | ✅ close |
| WhatsApp brand | `#25D366` | `--ch-whatsapp` `#25D366` | ✅ **exact** |
| AI | `ai` `#7C3AED` | — | ❌ no AI surfaces yet |

We independently converged on the same palette. Their one weak spot is
`text-tertiary` at roughly 2.9:1 — we already fixed that class of problem when we
audited contrast to zero failures.

**Their nav is `#0F172A` navy; so is ours.** Same structural decision: dark rail,
light canvas.

### 6.2 Where their design is ahead of ours

| Gap | Detail |
|---|---|
| **Dark theme at v1** | Both themes ship together, same token names, separate palette — *"dark is not an afterthought; agents working long shifts frequently prefer it."* respond.io was observed running in dark mode. **We dropped dark entirely when we flipped to the light palette.** For a product whose primary persona sits in one screen for eight hours, that is a real regression. |
| **Two densities, one visual system** | Operator surface (Inbox/Contacts — dense, quiet, keyboard, 8-hour sessions) vs configuration surface (Settings/Broadcasts/Reports — spacious, explanatory, 10-minute sessions). *"The most common mistake in this category is applying one design language to both."* Ours is currently uniform. |
| **Role-aware navigation** | Agents see **three** destinations, not seven. *"A rail with seven icons of which four are inert is a daily reminder to an agent of what they are not allowed to do."* Our rail shows all five to everyone. |
| **Font stack** | Inter (Latin) + Noto Sans Arabic + Noto Sans Hebrew, with **tabular figures** for phone numbers and IDs so columns align. We use Cairo for everything and no tabular figures. |
| **Type scale** | Nine named tokens (display / h1 / h2 / h3 / body / body-strong / small / micro / mono). Ours is ad-hoc `text-[11px]` / `text-[13px]` literals scattered through components. |
| **Motion tokens** | 120ms micro / 200ms panel / 300ms modal, `cubic-bezier(0.2,0,0,1)`, honouring `prefers-reduced-motion`. Ours is ad-hoc. |
| **Workspace switcher** | Top of rail, searchable, plus Create workspace. We have none — relevant once a user belongs to more than one org. |
| **Component library discipline** | Every component ships light+dark, LTR+RTL, loading and error states, with a Storybook entry and interaction tests. |

### 6.3 RTL — they are stricter than us, and they are right

This is their headline differentiator (*"treat RTL as a layout mode, not a
translation"*), and their observation that respond.io renders Arabic punctuation
and mixed-direction runs badly matches what you flagged about our own UI.

Their rules, checked against our code:

| Rule | Us |
|---|---|
| Logical properties throughout; no `left`/`right` except where physically correct | ⚠️ **35 physical vs 23 logical utilities.** Real bugs: `pr-9` on the contacts and inbox search inputs (icon padding lands on the wrong side in RTL), `ml-1` in inbox and reports. The rest are shadcn primitives (`dropdown-menu`, `select`, `table`) shipping physical defaults. |
| **Per-message direction detection** — a Hebrew customer writing one English sentence gets that bubble LTR while the interface stays RTL, via first-strong-character + `<bdi>` isolation | ❌ **not implemented.** Message bubbles inherit interface direction. This is the exact defect they call out in respond.io, and we have it too. |
| Numbers / phones / timestamps always LTR, isolated with U+2068 FSI / U+2069 PDI — *"the single most common bidi bug"* | ⚠️ partial — `dir="ltr"` on some phone fields, not systematic, no FSI/PDI isolation |
| Directional icons mirror, representational icons do not | ⚠️ unaudited |
| RTL tested as a first-class mode in the component library | ❌ no component library |

**Per-message direction detection is the most valuable single item here.** Your
users write Arabic, Hebrew and English — often mixed in one thread — and today a
mixed-direction message renders wrong. It is contained: a helper that reads the
first strong directional character and sets `dir` on the bubble.

### 6.4 Screen layouts worth adopting

Their inbox at 1440px is **56 / 240 / 320 / flex / 340** — a 56px icon rail, a
240px inbox-selector column, a 320px conversation list, the thread, and a 340px
contact panel.

Ours is **220 / 280 / flex / 280** — no icon rail, and critically **no
inbox-selector column**. That column is where their system inboxes (All, Mine,
Unassigned, Mentions, Snoozed), lifecycle stages with live counts, teams and
custom saved views live. We express a subset as filter tabs across the top.

Details worth stealing regardless of layout:

- The **service-window bar on each conversation row** becomes, for us, a
  **channel/session health bar** — the first thing the eye lands on.
- **Composer toolbar of five items, not seven** — "fewer, larger targets."
- **Contact panel tabs horizontal at the bottom**, not a vertical icon rail,
  because short labels beat icons for infrequent actions. We have no tabs at all
  — no Files or Activity view.
- **Named empty states per situation** (no channel / no messages yet / filter
  matches nothing / all caught up), each with an illustration, an explanation and
  one primary action. Their note that "all caught up" should be **quiet and
  non-celebratory** is a good detail for a screen someone stares at all day.

### 6.5 Accessibility target

WCAG 2.2 AA, both themes: 4.5:1 body, 3:1 large text and UI boundaries, visible
focus ring at 3:1, 24×24px minimum targets (44×44 touch), usable at 200% zoom,
ARIA live region on the conversation thread, and **colour never the sole carrier
of meaning**.

We have already audited contrast to **zero failures on inbox and reports**, so
the hardest part is done. Untested: focus-ring contrast, target sizes, 200% zoom,
the live region.

### 6.6 What I would take, in order

1. **Per-message direction detection + FSI/PDI isolation** — ~half a day, fixes a defect your users hit daily
2. **Fix the physical-property RTL bugs** (`pr-9` search inputs, `ml-1`) — ~1 hour
3. **Restore the dark theme** as a proper second palette with a system option — ~1 day
4. **Type scale + motion tokens** replacing ad-hoc pixel literals — ~half a day
5. **Role-aware navigation** — agents see three destinations, not five
6. **Contact panel tabs** (Details / Conversations / Files / Activity)
7. **Named empty states**
8. **Tabular figures** for phone numbers and IDs
9. Inbox-selector column — only alongside custom inboxes and the lifecycle pipeline

Items 1, 2 and 8 are small and directly serve the Arabic/Hebrew market. Item 3 is
the one real regression we introduced.

> **Note on the companion file.** §29 says *"pixel-accurate, interactive
> wireframes for every screen are in the companion HTML UI specification"* — a
> separate deliverable not in this PDF. If Mohanad has it, it is worth getting:
> it would contain the actual screens rather than the ASCII schematics.
