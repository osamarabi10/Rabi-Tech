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
- [ ] **5. Verify** live: counts match the list, every scope filters, RTL mirrors,
  tablet and mobile behaviour.

## U2 — Contact context tabs · brief step 3

- [ ] **1. `Details` / `Files` / `Activity` tabs** in the contact panel.
- [ ] **2. Files** from existing message attachments (`mediaUrl`).
- [ ] **3. Activity** — **needs a new endpoint.** `AuditLog` rows are written but
  nothing reads them. `GET /api/conversations/:id/activity`, tenant-scoped.
- [ ] **4. Details** keeps consent provenance: source, timestamp, who recorded it.

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

- [ ] **1. Skeletons** matching the real final layout, not spinners.
- [ ] **2. Distinguishable empties**: no channel · no messages · no filter match.
- [ ] **3. Delivery failure** with reason and a retry path.
- [ ] **4. Gateway offline / degraded / needs-QR**, each explaining its impact.
- [ ] **5. Consent exclusion** shown wherever an audience is built.
- [ ] **6. Permission-denied** states rather than absent controls.

## U6 — Platform finance · brief step 5

**Product decision taken 2026-08-22: invoice + payment receipt, not tax-valid.**
An invoice records what is owed; a receipt confirms payment was taken. Neither is
labelled `חשבונית מס` / `قبالة ضريبية`, neither claims sequential tax numbering,
and nothing may imply tax validity unless a real accounting provider backs it.

- [ ] **1. `FinanceDocumentTable`** — invoices and receipts, per subscriber.
- [ ] **2. Issue a receipt** when a payment is recorded.
- [ ] **3. Download / export**, actually producing a document — no button that
  claims an export it does not perform.
- [ ] **4. Owner-only guard plus an audit trail**, separate from tenant auth.

## U7 — Responsive, RTL and theme pass · brief step 8

- [ ] **1. Desktop / tablet / mobile** — mobile uses sequential panels, never a
  squeezed four-column layout.
- [ ] **2. English / Arabic / Hebrew**, translated rather than mirrored English.
- [ ] **3. Light and dark**, every new surface in both.
- [ ] **4. Logical properties only.** No `left`/`right` in new code.
- [ ] **5. Contrast audit** on every new surface, both themes.

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
