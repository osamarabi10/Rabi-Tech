# UI completion — phase plan

Working checklist for the Relay Ledger UI brief (`RabiTech — Complete Claude Code
UI Implementation Prompt`). Phases follow the brief's own implementation order.

Branch: **`relay-ledger`**. `main` does not move until a phase is reviewed.

**Gates run before every commit** — the brief asks for "type check, linting, unit
tests, production build". Two of those do not exist in this repository and are
not going to be invented in a commit message:

| Gate | Exists | Command |
|---|---|---|
| Backend typecheck | ✅ | `npx tsc --noEmit -p .` |
| Frontend typecheck | ✅ | `npx tsc --noEmit -p .` |
| Prisma-client lint | ✅ | `npm run lint` (backend) |
| **Tenancy isolation** | ✅ | `npm run test:tenancy` — **must stay 63/63** |
| Production build | ✅ | `npm run build` (frontend) |
| ESLint | ❌ | no config in either app |
| Unit / integration tests | ❌ | no test runner |

The tenancy harness is the load-bearing gate. It is the only one that proves a
change did not break tenant isolation, which is the single failure that would
actually hurt a subscriber.

---

## U1 — Inbox selector column · brief step 2

- [x] **1. `InboxSelector` component**, 232px, as pane 1 of four
  — **done 2026-08-22.** All / Mine / Unassigned, lifecycle stages, team
  inboxes, each with a real count, plus live gateway state pinned to the bottom.
- [x] **2. Scope is orthogonal to status.** The column owns *whose queue*; the
  existing pills keep owning *which status*. They combine, so "my open
  conversations" and "Sales at Qualified" are both expressible.
  `Mine` was removed from the pills — the same filter in two places disagrees
  the moment a scope is active.
- [x] **3. Counts are real**, computed from loaded conversations rather than a
  second endpoint that could disagree with the list beside it.
  **Ceiling, recorded deliberately:** the list endpoint has no pagination, so
  today the totals are exact. When it is paginated they silently become "of what
  is loaded" and must move to a server-side aggregate.
- [x] **4. Gateway state is polled**, not read once. An agent whose session
  dropped must see it here rather than discover it from a failed send — this
  column is the only always-visible surface in the inbox.
- [x] **5. Verify** live: counts match the list, every scope filters, RTL mirrors,
  tablet and mobile behaviour.

## U2 — Contact context tabs · brief step 3

- [x] **1. `Details` / `Files` / `Activity` tabs** — **done 2026-08-22.** Panel
  widened 280 → 320px per the brief. Scrolling moved off the pane onto each tab
  body, so the strip stays fixed while a long timeline scrolls under it.
  Switching conversation resets to Details — staying on Activity briefly showed
  the previous contact's history as though it were the new one's.
- [x] **2. Files** from attachments already in the thread, newest first, each
  showing direction: whether we sent it or they did is the first question anyone
  asks of a file in a support thread. The count badge appears only when non-zero.
- [x] **3. Activity** — new endpoint `GET /api/conversations/:id/activity`,
  tenant-scoped, 404 on an unknown id so a caller cannot tell a quiet
  conversation from one in another tenant. It merges `AuditLog` rows — their
  first ever consumer, written since the module was built and never read — with
  automated messages, because what happened here includes the auto-replies no
  human triggered. Automated events render as hollow dots, so the distinction is
  not carried by colour alone. Verified live: real audit events with actor
  names, 404 on an unknown id.
- [ ] **4. Details** — consent provenance (source, timestamp, who recorded it) is
  **not surfaced**. The consent value is editable but no per-change history is
  stored, so there is nothing truthful to show yet. Needs a `ConsentEvent` row
  written on every change before this box can be ticked.

  **Calls** — respond.io tabs a fourth `Calls` here. Deliberately absent: a
  WhatsApp Web gateway has none, and a tab opening onto a permanent empty state
  is worse than one never offered.

## U3 — Settings sub-navigation · brief step 4

- [ ] **1. Two-column settings**: persistent numbered sub-navigation, content beside it.
- [ ] **2. Keep every working section.** Omit only genuinely unsupported ones.
- [ ] **3. Carry over the audit findings** in `docs/SETTINGS-AUDIT.md` —
  the "Secondary color" label overselling a logo-only accent, and an emptied
  custom footer rendering no footer at all.

## U4 — Composer readiness strip · brief step 7

- [ ] **1. `ComposerReadinessStrip`** above the composer, from real gateway state.
- [ ] **2. Gateway loss makes affected sends visibly unavailable**, with a
  recovery path — not a send that fails after the fact.
- [ ] **3. Explicit affordances**: snippet, attach, emoji — shown only where the
  capability exists. Attachments stay disabled on internal notes.
- [ ] **4. Sending-number selection** visible where the tenant has more than one.

## U5 — Operational states · brief step 8

- [x] **1. Skeletons** matching the real final layout, not spinners.
- [x] **2. Distinguishable empties**: no channel · no messages · no filter match.
- [x] **3. Delivery failure** with reason and a retry path.
- [x] **4. Gateway offline / degraded / needs-QR**, each explaining its impact.
- [x] **5. Consent exclusion** shown wherever an audience is built.
- [x] **6. Permission-denied** states rather than absent controls.

## U6 — Platform finance · brief step 5

**Product decision taken 2026-08-22: invoice + payment receipt, not tax-valid.**
An invoice records what is owed; a receipt confirms payment was taken. Neither is
labelled `חשבונית מס` / `قبالة ضريبية`, neither claims sequential tax numbering,
and nothing may imply tax validity unless a real accounting provider backs it.

- [x] **1. `FinanceDocumentTable`** — invoices and receipts, per subscriber.
- [x] **2. Issue a receipt** when a payment is recorded.
- [x] **3. Download / export**, actually producing a document — no button that
  claims an export it does not perform.
- [x] **4. Owner-only guard plus an audit trail**, separate from tenant auth.
**Verified.** `npm run test:finance` (16/16) exercises the service the routes
call: sequential references, receipt issued in the same transaction as the
invoice update, part payment leaving a balance, overpayment refused with the
balance named, settled invoice refusing further payment, HTML escaping of
subscriber-controlled text, and the CSV quoting and BOM. The owner guard was
checked live: anonymous 401, tenant admin 403 on read, issue and export.

**Not verified in the browser:** the console dialog itself needs a
platform-owner session, which this session does not hold. Backend, guard and
document rendering are proven; the dialog is typechecked and built but unseen.

**Document format is HTML, not PDF, deliberately.** pdfkit does not shape
Arabic or Hebrew without a text-shaping layer, so a generated PDF receipt would
come out as disconnected reversed glyphs. The browser shapes correctly and
prints to PDF everywhere. The file downloads either way.

## U7 — Responsive, RTL and theme pass · brief step 8

- [x] **1. Desktop / tablet / mobile** — mobile uses sequential panels, never a
  squeezed four-column layout.
- [x] **2. English / Arabic / Hebrew**, translated rather than mirrored English.
- [x] **3. Light and dark**, every new surface in both.
- [x] **4. Logical properties only.** No `left`/`right` in new code.
- [x] **5. Contrast audit** on every new surface, both themes.

**Two permanent checks added**, both wired into package.json:
`npm run check:i18n` (every literal `t()` key translated in Hebrew and English,
no duplicates, no blanks) and `npm run check:mojibake` (Arabic or Hebrew text
that was decoded as Latin-1 somewhere and written back as UTF-8).

**What the i18n sweep actually found.** The first version of the checker read
the dictionary line by line, which missed every entry a formatter had wrapped,
and it compared raw literal text, which treats `"a \"b\""` and `'a "b"'` as
different keys. It reported 303 missing strings; 296 of them were already
translated. The real defects were five: three strings corrupted into mojibake
(the Contacts page heading and both settings-save toasts, garbage on screen for
every user), and two genuinely untranslated. The checker was corrected before
the count was believed — a checker that cries wolf is how a team learns to
ignore one.

**Also found and fixed, none of it visible from the source:**

- `cn()` was deleting the role type scale. `text-caption` and friends are plain
  CSS classes, not Tailwind theme sizes, so tailwind-merge treated
  `cn('text-caption', 'text-primary')` as a conflict and dropped the size. The
  settings sub-navigation shipped at 16px instead of 11px with both classes
  present in the source. Registered as font sizes in `lib/utils.ts`.
- `inset-inline-0` is not a class Tailwind generates. The mobile scope menu had
  no horizontal anchoring and sized itself to its longest label.
- Pane 1 is hidden below `lg`, and the comment claimed its scopes stayed
  reachable elsewhere. They did not: Mine, Unassigned, every lifecycle stage and
  every team queue existed only on a desktop, and gateway trouble — the one
  fault this product cannot detect for you — was invisible on a phone. Both are
  back as `lg:hidden` controls sharing the pane's own counting code.
- Contrast, measured rather than eyeballed, in both themes: `text-destructive/80`
  at 2.62:1, the sub-nav numbers at 3.1:1, tenant team colours at 3.84:1, and
  `--danger`, `--warning` and `--status-pending` all tuned against pure white
  when every real use puts them on a tinted panel. Fixed at the token where the
  cause was a token, and at the call site where the cause was a fade.
- A Hebrew workspace showed `غير معروف` for an unnamed contact: the placeholder
  is produced in the data layer, where there is no `t()`.

**Verified live** at 375, 768 and 1440 — no horizontal overflow at any width,
the scope menu appearing and filtering correctly below `lg` and hidden above it,
the gateway notice never duplicated. Arabic and Hebrew both render RTL with the
rail on the correct edge. Contrast swept over inbox, settings, contacts and
reports in both themes: zero failures, worst ratio 4.6:1.

**Not verified:** the campaign composer, because this workspace is on the Free
plan and the page renders its upgrade gate instead.

## U8 — Documentation · brief step 9

- [ ] **1. Final route and component map.**
- [ ] **2. New API contracts** introduced by U2 and U6.
- [ ] **3. Update `CLAUDE.md`** with anything a future agent must not undo.

---

## Not built, deliberately

Carried from the brief's "do not introduce" list, so a later reader does not
mistake absence for oversight: no Meta 24-hour window, no template approval
state, no quality rating, no cost estimator, no AI agents, no incoming calls, no
public REST API UI, no global search, no scheduled reports. None of these are
supported by an OpenWA gateway or by this product's data model.
