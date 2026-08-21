# Settings — flow and dead-flow audit

**Audited 2026-08-22** against the live code, not the rendered page. Every claim
below was checked by tracing the control to the field it writes, and the field to
whatever reads it. Where nothing reads it, that is stated.

The question this answers: *for each settings category, is the flow real, is it
dead, or is it not needed?*

---

## Verdict at a glance

| Section | Flow | Verdict |
|---|---|---|
| Branding | write → `OrganizationBranding` → read by layout + logo | **Real**, with one narrow control |
| Subscription | read-only summary + upgrade CTA | **Real, deliberately stubbed** at checkout |
| Monthly usage | read → `UsageEvent` metering | **Real** |
| Working hours | write → `WorkingHours` → out-of-hours replies + workflows | **Real** |
| Team members | write → `User` / `UserTeam` | **Real** |
| Snippets | write → `MessageTemplate` → composer `:shortCode` | **Real** |
| Auto-replies | write → `MessageTemplate.autoReplyKind` → inbound pipeline | **Real — all 12 kinds wired** |
| WhatsApp channels | QR link / pause / disconnect → gateway | **Real** |
| Keywords | write → `Keyword` → inbound detection | **Real** |
| Teams | write → `Team` → routing + inbox rooms | **Real** |
| Lifecycle stages | write → `LifecycleStage` → contact panel + header | **Real** (shipped 2026-08-22) |

**No dead sections.** Every anchor in the section nav resolves to a real block
on the page — checked one by one. The problems are narrower than that, and
listed below.

---

## 1. Branding

### The flow

```
Settings → Branding
  ├─ productName ──────→ OrganizationBranding.productName
  │                        → <title>, rail workspace menu, login page
  ├─ logoUrl (upload) ──→ /api/branding/assets/… → BrandLogo, login
  ├─ faviconUrl (upload)→ layout.tsx `icons.icon`
  ├─ primaryHsl ────────→ body style `--primary`, `--ring`, `--glow-primary`
  ├─ accentHsl ─────────→ `--brand-accent`, `--brand-gradient-to`
  ├─ defaultLocale ─────→ <html lang>
  ├─ direction ─────────→ <html dir>
  ├─ customDomain ──────→ branding resolved by Host header
  └─ customFooter ──────→ footerText (BUSINESS/ENTERPRISE only) → DashboardFooter
```

### Findings

**"Secondary color" earns almost nothing.** `accentHsl` is injected as
`--brand-accent` and `--brand-gradient-to`, and exactly one component outside the
settings preview reads it: `BrandLogo`, for the corner of its gradient. Change
it and the only thing that moves in the whole product is the logo tile.

It is **not dead** — I initially thought it was, and it is not — but it is sold
by the label as a peer of "Primary color" when it is a single-component
accent. Either give it real reach (secondary buttons, chart series, badges) or
rename it to what it is.

**Custom footer is correctly gated, and silently empty below BUSINESS.**
`footerText` returns the customised value only for BUSINESS/ENTERPRISE; every
other tier gets the fixed `Powered by RabiTech`. That is right. But
`DashboardFooter` renders nothing when `footerText` is empty, so a BUSINESS
subscriber who clears the field gets **no footer at all** rather than falling
back to attribution. Worth deciding: is an empty custom footer "no footer", or
"back to the default"?

**Custom domain is half a feature, and the missing half is not code.** The field
saves, a TXT verification record is generated, and `/api/branding/public?host=`
resolves branding by Host — so the application side works. What does not exist is
DNS, a reverse proxy and a certificate for that hostname, which is owner task
**O4**. Until then the field verifies a domain that nothing serves.

---

## 2. Subscription

Reads `/api/billing/summary`: plan, price, period end, MAC used/limit, invoice
list. The upgrade CTA goes to `/contact-us-to-activate` rather than a checkout.

**Deliberately stubbed, not broken.** Activation is already automatic; only
checkout is missing, and it is blocked on the payments-provider decision
(**O5**). See `docs/BILLING-PROVIDER-GUIDE.md`.

---

## 3. Monthly usage

Reads real `UsageEvent` metering — inbound, outbound, active contacts, campaign
sends, AI tokens — against the effective plan's limits, including overrides.
Real, and the numbers are the same ones that gate sending.

---

## 4. Working hours

Writes `WorkingHours`; read by `maybeSendOutOfHoursReply` on the inbound path,
by the `OUT_OF_HOURS` workflow trigger, and by the `WITHIN_BUSINESS_HOURS`
workflow condition. Three consumers. Real.

---

## 5. Team members · 6. Teams

Members write `User` and `UserTeam`; teams write `Team`, which drives
auto-assignment, Socket.io room names, the reports team filter and session
routing.

**One overlap worth noting:** "Team members" and "Teams" are two sections for
one mental model. Respond.io keeps Users and Teams adjacent under one Workspace
heading. Not a dead flow — a navigation choice worth revisiting when settings
gets its Respond.io-style left sub-nav.

---

## 7. Snippets

Writes `MessageTemplate` rows with a `shortCode`; the composer expands them.
Real and used daily.

**Naming gap:** the section is labelled القوالب ("templates"), which is also
what a WhatsApp *message template* is called in the Marasil spec. Two different
things wearing one word. Respond.io calls these **Snippets**.

---

## 8. Auto-replies

Writes `MessageTemplate.autoReplyKind`. **All twelve kinds are wired to real
runtime paths** — verified individually:

| Kind | Consumer |
|---|---|
| `WELCOME` | first inbound on a new conversation |
| `OUT_OF_HOURS` | `maybeSendOutOfHoursReply` |
| `CSAT_PROMPT` / `CSAT_THANKS` | CSAT flow on resolve |
| `CONVERSATION_CLOSED` | manual resolve **and** the new `CLOSE_CONVERSATION` workflow node |
| `AWAITING_CLIENT` | pending-status transition |
| `KEYWORD_CRITICAL/HIGH/MEDIUM/LOW` | keyword detection by priority |
| `OPT_OUT_CONFIRM` / `OPT_IN_CONFIRM` | consent capture on the inbound path |

This is the section that most directly enforces the project's own rule — *no
hardcoded customer-facing text*. It holds.

---

## 9. WhatsApp channels

Link a device (QR), pause, and disconnect. Pause keeps credentials so the same
number reconnects; disconnect discards them so a different number can be linked
— and the two are labelled with exactly that difference, which is the part that
matters. See `docs/WHATSAPP-GATEWAY-RUNBOOK.md`.

---

## 10. Keywords

Writes `Keyword` rows, cached per tenant and read by inbound detection alongside
the built-in list. Real.

---

## 11. Lifecycle stages

`/settings/lifecycle` — per-organization ordered pipeline, seeded with five
defaults, feeding the contact-panel selector and the thread-header chip.

**Known gap:** stage **filters with counts in the inbox** are not built. That is
the half of Marasil §19.1 still open, and it is the half that makes a pipeline
feel like a pipeline.

---

## What is actually missing, ranked

1. **Settings has no sub-navigation.** It is one 1,155-line scrolling page with
   anchor links. Respond.io gives Settings its own left column with grouped
   sections. This is the biggest structural difference in this area.
2. **Lifecycle stage counts as inbox filters** — the open half of the pipeline.
3. **Granular restrictions** (M8): restrict data export, restrict contact
   deletion, restrict settings access, restrict integration access. The spec
   lists four; none exist.
4. **Audit-log surface.** `AuditLog` rows are written but there is no screen that
   reads them.
5. **Secondary colour** reaching more than the logo, or being renamed.
6. **Notifications settings.** Marasil §22.3 specifies per-user notification
   preferences; there is no such section.

## What is *not* missing, despite looking like it

- **Custom footer** — gated by plan on purpose.
- **Checkout** — blocked on a business decision, not on code.
- **Custom domain** — the code half is done; the infrastructure half is O4.
