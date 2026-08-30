# Settings — build specification

> Status: **canonical for Settings scope.** Phase 6-A groundwork. This document
> plans; it builds nothing.
> Written 2026-08-29, verified against the tree at commit `e765b40c`.
> Read `docs/UI-SURFACE-MAP.md` before editing any UI named here.

## 0. Purpose, and what this is not

Settings is **already built**. Eleven routes exist, all render, and none is a
stub. So this is not a build-from-zero specification — a from-scratch plan for
screens that already work is wasted motion, and worse, it invites someone to
rewrite working code. This document leads with the **delta**: the small distance
between what exists and complete parity, and an explicit list of what to leave
alone.

Where an external product is used as reference, it is **structural reference
only** — information architecture, nothing else. RabiTech does not clone another
product's visual design or its flows, and any defect catalogued in a competitor
is an anti-requirement here, never a pattern to match.

RabiTech is **RTL-first**. Arabic and Hebrew are primary, not a translation layer
applied afterwards. Every rule in §5 follows from that, and every one of them
records a bug that already shipped once.

### Source gap: the external Settings audit was not available

This specification was requested with reference to an external Respond.io
Settings discovery audit, including a note that its Batch 1 skipped from Module 6
to Module 8 and that Module 7 was never captured.

**That audit is not in this repository.** It is not in `docs/`, and no file in
any commit on any ref contains it. `docs/SETTINGS-AUDIT.md` is a different
document — a RabiTech **self**-audit dated 2026-08-22 that traces this product's
own settings controls to the fields they write.

Consequences, stated plainly rather than papered over:

- **§3 (external-reference mapping) cannot be written.** It is marked blocked.
- **The Module 7 gap is recorded, not reconstructed.** No inference is made
  about what Module 7 would have contained. A route with no external reference
  is specified from its own current state, which is the honest basis available.
- **§4 is sourced from RabiTech's own contract instead**, which is stronger
  provenance: those items are already release gates in
  `docs/RESPONDIO-UI-EXECUTION.md`, not observations about someone else's product.

This is the third time work in this project has been planned against a document
that turned out not to exist, after `docs/FULL-PARITY-PLAN.md` and a
`plan_entitlements` migration. The pattern is the reason `docs/RABITECH-PRODUCT-VISION.md`
exists. Recording the gap is cheaper than discovering it mid-build.

## 1. Precedence

| Document | Owns | Relationship |
|---|---|---|
| **This document** | Settings scope: what to complete, what to leave alone | Canonical for Settings work |
| `docs/RESPONDIO-UI-EXECUTION.md` | The binding UI contract and acceptance criteria | §4 and §5 derive from it; it wins on any conflict |
| `docs/SETTINGS-AUDIT.md` | Flow truth per settings section as of 2026-08-22 | Verified "no dead sections"; still accurate |
| `docs/UI-SURFACE-MAP.md` | Route/component map, and where the obvious edit is wrong | **Read before editing any UI** |
| `docs/RABITECH-PRODUCT-VISION.md` | The edition ladder | Gates what Settings must expose per tier; see §8 |
| `docs/RESPOND-IO-PARITY.md` | Researched product differences | Structural reference only |
| `CLAUDE.md` | Load-bearing UI rules | Each records a shipped bug; §5 restates the ones that bite Settings |

## 2. Ground truth — what exists today

Verified by reading the code and probing the running app, not from any
document's claims.

**All eleven routes return HTTP 200.** The 404s observed on 2026-08-28 were a
stale Docker image serving a build that predated these screens, resolved by
rebuilding. They were never missing code.

**The route files are not the implementation.** Eight of the ten subroutes are
five-line wrappers delegating to `apps/frontend/components/settings/`. Judging
build state by `page.tsx` size would conclude the product is a shell; it is not.

| Route | Implementation | Lines | State |
|---|---|---|---|
| `/settings` | `settings/page.tsx` | 331 | Built — hub, includes personal profile |
| `/settings/general` | `settings/general/page.tsx` | 1197 | Built — self-contained, largest surface |
| `/settings/lifecycle` | `workspace-lifecycle.tsx` | 411 | Built |
| `/settings/teams` | `workspace-teams.tsx` | 374 | Built |
| `/settings/conversations` | `workspace-conversations.tsx` | 335 | ⚠️ Built, **not functional** — see below |
| `/settings/channels` | `workspace-channels.tsx` | 244 | Built |
| `/settings/users` | `workspace-users.tsx` | 193 | Built |
| `/settings/snippets` | `workspace-snippets.tsx` | 187 | Built |
| `/settings/contact-fields` | `workspace-contact-fields.tsx` | 163 | Built |
| `/settings/tags` | `workspace-tags.tsx` | 116 | Built |
| `/settings/notifications` | `settings/notifications/page.tsx` | 114 | Built |

> **SUPERSEDED 2026-08-30.** The `/settings/conversations` row's "not
> functional" flag and the paragraphs below were true while migration
> `20260916090000_conversation_operations` was still unapplied. Verified before
> this correction: the live database has 67 finished migrations, migration 64
> finished at `2026-08-29 13:06:00.056345+00`, `ConversationCategory` and
> `ConversationClosure` both exist, `http://127.0.0.1:18080/settings/conversations`
> returns `200`, `http://127.0.0.1:4000/api/conversation-settings` returns
> anonymous `401` rather than `500`, and `/health` reports database, Redis,
> OpenWA, and queue depth `ok`. This correction does not certify every
> authenticated Settings workflow; it only removes the stale migration blocker.

Supporting components: `snippets-card` (345), `team-members` (247),
`subscription-card` (228), `auto-replies-card` (206), `settings-sub-navigation`
(165), `team-routing` (115), `settings-rail` (106).

**Sixteen components, 3,765 lines. No stubs.**

### Two corrections to the assumed scope

**There is no `/settings/profile` and no `/settings/billing`.** The ten
subroutes are the ones tabled above. Personal profile lives inside the
`/settings` root page and `/settings/notifications`. Billing is a **separate
dashboard route** at `apps/frontend/app/(dashboard)/billing/`, outside Settings
entirely — see §8, because the editions work makes its placement a real
decision.

**`/settings/conversations` renders but does not function.** The surface is
built and its API exists — `conversation-settings.routes.ts` serves six
endpoints including category CRUD, and returns `401` anonymously, so the auth
boundary is correct. But `ConversationCategory` and `ConversationClosure` **do
not exist in the database**: migration `20260916090000_conversation_operations`
is on disk and unapplied. Any authenticated request reaches the database and
fails. *Renders 200* and *works* are different claims, and only the first is
currently true.

> **Correction 2026-08-30.** Superseded by the Conversation Operations release.
> `ConversationCategory` and `ConversationClosure` exist in Prisma and in the
> live database, and migration `20260916090000_conversation_operations` is
> applied. Keep the paragraph above as the old failure mode: *renders 200* and
> *works* are different claims, but the specific database blocker it named is
> gone.

### Not verified

Whether each screen functions end-to-end under an authenticated session. Only
that routes render and that APIs auth-gate before touching data. Confirming the
rest needs a real login and belongs in the browser matrix, not here.

## 3. External-reference mapping — BLOCKED

Intended to hold, per screen: what the external reference has, what RabiTech
has, and the gap. **Cannot be written — the audit is unavailable (§0).**

When the audit is supplied, this section is written and nothing else in this
document needs to change; §2 already carries the RabiTech half of every row.

Recorded for continuity: Batch 1 of that audit skipped Module 6 to Module 8, and
**Module 7 was never captured**. Whichever route Module 7 corresponds to has no
external reference and is specified from its own current state. No reconstruction
of Module 7's intended contents appears anywhere in this document.

## 4. Anti-requirements — verified, not generic

Each rule below is an existing acceptance criterion in
`docs/RESPONDIO-UI-EXECUTION.md:30-41`. What follows is not a restatement of
best practice: each is **checked against the Settings code** and marked with
where the remaining work actually is.

| Rule | Status | Evidence |
|---|---|---|
| No PII in `document.title` | ✅ already handled | `app/layout.tsx:18` — `` `${branding.productName} - Dashboard` ``; no contact or user data |
| Logical properties only, never `left`/`right` | ✅ already handled | **Zero** physical-property usages across all 16 settings components |
| `dir="ltr"` on numbers only, never containers | ✅ already handled | 28 occurrences, all on `<span>`/`<li>` carrying `font-mono` codes, prices, metrics |
| Accessible names on icon-only controls | ✅ completed 2026-08-30 | All 10 current `size="icon"` buttons have translated accessible names; the final three were fixed in `auto-replies-card.tsx` and `workspace-lifecycle.tsx` |
| Loading affordance | ✅ effectively handled | 13 of 16 components; the 3 without are `settings-rail`, `settings-sub-navigation`, `team-routing` — navigation chrome that fetches nothing |
| Error state | ✅ already handled | 13 of 16 components |
| Shared operational-state primitive | ✅ available and used | `components/ui/operational-state.tsx`, used by 11 current Settings components |
| True empty / no-results state | ✅ pass completed 2026-08-30 | Genuine remaining collections use `operational-state.tsx`; fixed, singular, navigation, and contract-guaranteed content correctly has no empty state |

**The three unlabelled icon-only controls** — the only concrete accessibility
defect in Settings:

- `components/settings/auto-replies-card.tsx:162`
- `components/settings/workspace-lifecycle.tsx:392`
- `components/settings/workspace-lifecycle.tsx:393`

Each needs an `aria-label` or an `sr-only` span. This is the entire
accessibility delta for Settings — small, located, and verifiable.

> **Completed 2026-08-30.** All three controls now have `aria-label` values
> produced through `t()`. The original locations above are retained as the
> pre-fix audit record; current line numbers have moved.

**Rules carried from the reference as anti-requirements**, to be honoured
whether or not the audit ever arrives: a tooltip is not a label; a control that
looks disabled must say why; a date picker must open on the first click, not
swallow it (`RESPONDIO-UI-EXECUTION.md:81`, `P22 DateRangePicker`); loading
states must be consistent between screens rather than per-screen inventions.

## 5. RTL-first rules

Arabic and Hebrew are primary. Each rule below records a bug that shipped:

- **Logical properties only** — `ms/me`, `ps/pe`, `start-*`/`end-*`,
  `text-start`. Two of three languages are RTL. `inset-inline-0` reads like a
  logical property and is **not** a Tailwind class; use `start-0 end-0`.
- **First-strong content direction** where message or cell content differs from
  the UI language.
- **Bidi-isolate** IDs, phone numbers, dates, money, and timestamps.
- **`dir="ltr"` on numbers only** — never on a container.
- **`cn()` is an extended twMerge.** The role type scale is registered as font
  sizes in `lib/utils.ts`; without that, tailwind-merge drops the size when a
  colour is in the same call and the component silently renders at 16px.
- **Never concatenate alpha onto a colour string.** `hsl(var(--x))20` is invalid
  CSS and fails silently — use `color-mix()`, see `lib/tint.ts`.
- **Arabic copy is Palestinian/Arab48 colloquial** — `أهلين` not `مرحباً`,
  `شو` not `ماذا`.
- Every string passes `npm run check:i18n` and `npm run check:mojibake`.

## 6. Per-screen delta

Three verdicts only: **leave alone**, **needs work**, **build new**.

### Leave alone — built, functional, no known defect

`/settings` · `/settings/general` · `/settings/teams` · `/settings/channels` ·
`/settings/users` · `/settings/snippets` · `/settings/contact-fields` ·
`/settings/tags` · `/settings/notifications`

Nine of eleven. `docs/SETTINGS-AUDIT.md` verified every flow on these reaches a
real field and a real reader — **"no dead sections"** — and nothing since has
changed that. Do not restructure them. Touch them only for the §4 fixes below,
or when editions work requires a new control.

### Needs work — small, located

**`/settings/lifecycle`** — built (411 lines), functional. Two unlabelled
icon-only buttons at lines 392-393. Add accessible names. Nothing else.

> **Completed 2026-08-30.** Both reorder buttons now have translated accessible
> names. The stage-column empty rendering also uses the shared `EmptyState`.

**`/settings` (auto-replies card)** — one unlabelled icon-only button at
`auto-replies-card.tsx:162`. Add an accessible name. Nothing else.

> **Completed 2026-08-30.** The delete control now has a translated accessible
> name. Auto-reply slots are a fixed server-defined catalogue, so an empty state
> would misrepresent a broken response as a valid empty collection.

**Empty states** — a pass across the nine components lacking one, keeping only
where a list can genuinely be empty. Use `components/ui/operational-state.tsx`;
do not invent per-screen variants.

> **Completed 2026-08-30.** The three genuine remaining collection gaps —
> lifecycle columns, subscription invoices, and the legacy snippets collection
> — now use `EmptyState` or `NoResultsState`. The other audited components hold
> fixed catalogues, singular settings, navigation, routing controls, or the
> authenticated workspace roster; none has a valid empty collection to depict.

### Blocked — built, waiting on a dependency

> **SUPERSEDED 2026-08-30.** `/settings/conversations` is no longer blocked on
> migration 64. The component and API may still need normal authenticated
> workflow verification, but the migration dependency named here is released.

**`/settings/conversations`** — the component and its six API endpoints exist
and are correct. It is blocked entirely on migration
`20260916090000_conversation_operations` being certified and applied. **No UI
work is needed or wanted here.** Building against it now would produce changes
that cannot be tested. See §8.

### Build new

**Nothing.** No missing Settings screen was found. If the audit later shows the
reference has a screen RabiTech lacks, it lands here — and is judged against
RabiTech's product boundary first, not adopted because a competitor has it.

## 7. Unknowns — design fresh during build

Not available from any reference, and **not to be guessed**:

- **Action-button flows** — confirmation, destructive-action patterns, and undo
  affordances beyond what `components/ui/confirm-dialog.tsx` already provides.
- **Error states** — beyond the generic retryable error; per-screen failure
  copy, especially where a tenant boundary or a permission denial is the cause.
- **Mobile and responsive behaviour** — never captured externally. RabiTech's
  own contract requires 375 / 768 / 1440 px without horizontal overflow, so
  that gate stands regardless; the *design* at each width is fresh work.
- **Whatever Module 7 covered** (§0/§3).

Design these from RabiTech's design system (`docs/AMARSAIL-DESIGN-SYSTEM.md`)
and its acceptance criteria, not from inference about the reference.

## 8. Dependencies and sequencing

> **SUPERSEDED 2026-08-30.** Items 1 and 2 below predate releases 64, 65, and
> 66. Conversation Operations and the owner-editable edition ladder have since
> been applied to the live database. Item 3 remains a product-placement
> decision; item 4 remains independent.

1. **Conversation Operations before `/settings/conversations`.** Migration 64
   must be certified and applied first. Until then that screen cannot be tested,
   and any work on it is unverifiable.
2. **Editions before tier-gated Settings.** `docs/RABITECH-PRODUCT-VISION.md`
   §3.1 records that the edition ladder is still a code constant in `plans.ts`;
   per-subscriber overrides are shipped, but the ladder needs a deploy to change.
   Settings cannot correctly show or hide a control by tier until that lands.
3. **Billing's placement is an open decision.** `/billing` sits outside Settings
   today. The editions work will add owner-facing plan controls, and whether
   those belong in Settings, in `/billing`, or in the platform console at
   `app/platform/` is a product decision — not one to resolve by whichever file
   is convenient. Flagged, not decided.
4. **The §4 accessibility fixes have no dependencies.** Three `aria-label`
   additions can land at any time.

## 9. Change log

| Date | Change |
|---|---|
| 2026-08-29 | Created. Ground truth verified at `e765b40c`: 11 routes, 16 components, 3,765 lines, no stubs. Delta is three unlabelled icon buttons, an empty-state pass, and one screen blocked on migration 64. External audit unavailable — §3 blocked, Module 7 gap recorded without reconstruction. |
| 2026-08-30 | Corrected stale migration-64 blocker. Verified live database has 67 finished migrations, `ConversationCategory` and `ConversationClosure` exist, `/settings/conversations` returns `200`, the anonymous API gate returns `401`, and `/health` is green. The old text is retained as the pre-release state, not current instruction. |
