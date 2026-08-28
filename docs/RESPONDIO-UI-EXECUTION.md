# Respond.io UI execution scope

> Active implementation and exact resume checkpoint: `docs/RESPONDIO-PARITY-CHECKPOINT.md`.

Status: accepted target and acceptance checklist  
Source: 2026-08-25 Respond.io discovery and UI replica build specification  
Updated: 2026-08-26

This document makes the Respond.io UI replica specification durable inside the
RabiTech repository. It supplements the architecture and launch plans; it does
not override tenant isolation, provider boundaries, entitlements, or the rule
that unsupported capabilities are not represented as working features.

## Product boundary

- Copy information architecture and interaction concepts, not Respond.io trade dress.
- Arabic-first RTL, Hebrew RTL, and English LTR are equal release targets.
- Light is the default; light and dark use the same semantic tokens.
- OpenWA-only work must not invent Meta template, quality, balance, or 24-hour-window behavior.
- Meta channel screens ship with the BYOT Cloud API provider phase.
- Third-party integrations ship only with real adapters or a clear unavailable state.
- AI Agents and Calls remain gated on their backend/infrastructure phases.

## Cross-cutting release gates

Every completed primitive and screen must prove:

- semantic light/dark tokens, with no screen-owned palette;
- logical CSS properties and correct RTL/LTR placement;
- first-strong content direction where message/cell content differs from the UI;
- bidi-isolated IDs, phone numbers, dates, money, and timestamps;
- tabular figures for numeric columns;
- headings and accessible names for icon controls;
- keyboard operation, focus visibility, focus return, and Escape-close overlays;
- loading skeleton, true empty, no-results, and retryable error states;
- no color-only status meaning;
- no unexplained disabled control;
- no PII in `document.title`;
- no horizontal page overflow at 375, 768, and 1440 px;
- production build, i18n check, mojibake check, and tenancy gate remain green.

## Shared primitives

Build or certify these before duplicating behavior in screens.

### Navigation

- [x] P1 `GlobalRail`: destinations, settings, identity/presence, notifications, help.
- [x] P2 `SettingsRail`: grouped Personal and Workspace navigation with `aria-current`.
- [ ] P3 `ChannelRail`: replaces Settings rail for channel-scoped configuration.
- [ ] P4 `RailGroup`: collapsible, counted, optional add action, omitted when empty.

### Lists

- [x] P5 `ListToolbar`: add, search/clear, and optional filters.
- [x] P6 `DataTable`: button sort headers, `aria-sort`, columns, contained overflow.
- [x] P7 `Pager`: entity page size, range, labelled previous/next.
- [x] P8 `RowOverflowMenu`: standard edit/delete and entity actions.
- [x] P9 `BulkActionBar`: replaces toolbar while rows are selected.
- [x] P10 `CardGrid`: one/two/four responsive tracks.

### Overlays

- [x] P11 `Drawer`: URL-bearing, inline-end anchored, focus trapped, Escape closable.
- [x] P12 `Modal`: explanatory copy, validation, focus trap/return, disabled invalid submit.
- [x] P13 `ConfirmDialog`: names the object and irreversible consequence.

### Feedback

- [x] P14 shared skeleton, empty, no-results, and error/retry primitives.
- [x] P15 `StatusChip`: color plus text or shape.
- [x] P16 `UpgradeBadge`: plan gate on the control instead of hiding it.
- [x] P17 `GateBanner`: reason and remediation route.
- [x] P18 `DangerZone`: explanatory warning before destructive controls.
- [ ] P19 toast system with undo where the action is reversible.

### Composite

- [x] P20 `ToggleCard`: title, explanation, switch, and disabled reason.
- [x] P21 `FilterBuilder`: nested groups and context-specific save target.
- [ ] P22 `DateRangePicker`: seven shared presets and first-click opening.
- [ ] P23 `ChartCard`: group-by, SVG/PNG/CSV export, empty data inside intact axes.
- [x] P24 `KpiTile`: value, labelled metric, delta arrow plus color.

An existing similarly named component is not automatically checked. Certification
requires all behavior above and viewport/theme/direction evidence.

## Screen inventory

### Shell and personal settings

- [x] App shell.
- [x] Notification Center panel: New, Archived, All, archive-all, empty state.
- [x] Help menu with ten descriptive entries and honest unavailable states.
- [x] Onboarding checklist with four accordion groups and resources.
- [x] Personal profile: avatar, presence, name, language, password, 2FA, theme.
- [x] Notification preferences: five enums and one boolean, with disabled reasons.

### Workspace settings

- [x] General information, server-enforced inactivity timeout/unit, timezone, weekly recap recipients and Monday delivery worker.
- [x] User roster, secure invitations, access levels, presence, seat meter, and four advanced restrictions.
- [x] Team settings: roster, members, default team, routing strategy, capacity, and dependency-aware deletion.
- [x] Channel grid, live connection state, QR pairing, reversible disconnect, and unlink danger zone for provisioned OpenWA sessions.
- [ ] Integrations: connected/browse, six categories, twelve adapter cards.
- [ ] Growth widgets with type picker and live preview.
- [x] Contact field definitions, typed validation, workspace order/visibility, and Inbox controls.
- [ ] Contacts-table column customization.
- [x] Lifecycle and lost-stage editor with reorder.
- [ ] Conversation settings and categories.
- [x] Snippets: workspace topics, searchable canned replies, dynamic variables, up to five files, and `/shortcut` composer insertion.
- [x] Tags with provenance, role-aware inline assignment, and count-confirmed deletion.
- [ ] AI Assist and knowledge sources (infrastructure-gated).
- [ ] AI Prompts (infrastructure-gated).
- [ ] Calls settings (provider/infrastructure-gated).
- [ ] Shared files/media library.
- [ ] Three-step contact import and history.
- [ ] Data export.

### Channel sub-rails

- [ ] WhatsApp Cloud API: seven capability-driven items.
- [ ] Facebook Messenger: five capability-driven items.
- [ ] Instagram: four capability-driven items.

The provider capability map determines these lists. OpenWA never displays Meta-only
sub-rails or fake disabled Meta data.

### Operational modules

- [ ] Dashboard: lifecycle, contacts, team, conversations, merge suggestions, broadcasts.
- [ ] Reports: shared chrome and eleven report destinations.
- [ ] Inbox: rail, list, thread, and five-tab context panel.
- [x] Contacts: toolbar, table, bulk actions, URL drawer, filters.
- [ ] Workflows: list and canvas with 11 triggers, 19 steps, 100-step cap, named branches.
- [ ] Broadcasts: status rail, table/calendar, URL detail, two-stage composer.
- [ ] AI Agents list/editor/test pane (infrastructure-gated).
- [x] Access denied screen with one return action.

### Certification evidence

- Contacts is covered by `tests/e2e/contacts-responsive.spec.ts`: all 18
  combinations of 375/768/1440 px, Arabic/Hebrew/English, and light/dark, plus
  reloadable drawer routing, Escape close, and bulk-toolbar replacement.
- The same browser suite covers Notification Center scope switching,
  archive/restore/archive-all, empty state, portal layering, Escape close, and
  focus return. The backend bleed harness proves archive operations cannot
  cross a user or organization boundary.
- Personal, notification, and Workspace General settings are covered by
  `tests/e2e/settings-responsive.spec.ts`: all 18 combinations of
  375/768/1440 px, Arabic/Hebrew/English, and light/dark. It also proves grouped rail
  `aria-current`, mobile access to bottom actions, keyboard operation of the
  sound switch, and the complete six-field save payload. The backend gate
  proves profile and notification preferences remain user- and tenant-scoped.
- The same settings suite proves TOTP enrollment, QR/manual setup, mandatory
  recovery-code acknowledgement, challenge login, recovery fallback, and
  password-plus-factor disable. The backend gate proves encrypted seed storage,
  revoked membership sessions, rate-limited challenge verification, TOTP replay
  rejection, and atomic single-use recovery codes. Workspace tests prove the
  complete five-field save contract, admin-only access, cross-tenant recipient
  rejection, server-side idle expiry, and all-three-language Monday recap copy.
- Workspace Users is covered in the same 18 viewport, language, and theme
  combinations. Contract tests cover Manager Agent-only invitations, Owner
  role/team/restriction updates, seat and plan gates, single-use acceptance,
  and public invite acceptance in Arabic, Hebrew, and English. The combined
  browser gate is green at `56/56`; the backend isolation gate is green at
  `91/91`.
- Teams is covered by the same 18 responsive, locale, and theme scenarios plus
  a combined metadata, routing, capacity, and membership save contract. Backend
  coverage proves atomic tenant-scoped membership replacement and immediate
  live socket-room revocation while the affected agent remains connected.
- Channels is covered by the same 18 responsive, locale, and theme scenarios.
  Its contract test proves temporary disconnect submits `unlink: false` and an
  unlinked session exposes the live QR pairing flow. The provider capability
  boundary remains explicit: OpenWA does not render Meta-only controls.
- Lifecycle is covered by the same 18 responsive, locale, and theme scenarios.
  Its contract test proves default selection, pointer/keyboard reorder, Lost
  stage creation, and deletion with explicit contact reassignment. The backend
  gate proves stage rename propagation, atomic default switching, protected
  Won/default invariants, and tenant-scoped deletion and reassignment.
- Snippets is covered by the same 18 responsive, locale, and theme scenarios
  plus a focused topic, variable, and creation contract. The backend gate
  proves workspace-scoped reads and mutations, composite topic ownership,
  signed unauthenticated provider file retrieval, and dynamic standard,
  custom, and system variables while preserving unknown variables literally.
  Snippet management is restricted to Owners and Managers; workspace users can
  search and insert active replies from the Inbox composer.
- Tags and Contact Fields are covered by the same 18 responsive, locale, and
  theme scenarios plus focused create, typed-list, workspace-view-order, and
  exact-count deletion contracts. The backend gate proves Owner/Manager/Agent
  authority, assignment provenance, immutable field identity/type, strict
  direct/import validation, and cross-organization isolation. Contacts-table
  column customization remains separately open.
- Global chrome and Onboarding are covered by the same 18 responsive, locale,
  and theme scenarios. The focused contract proves ten Help entries with
  descriptions, unavailable-service reasons, Escape focus return, live channel
  and teammate progress, and persisted lifecycle-guide completion after reload.
  The profile isolation gate proves that acknowledgement cannot mutate another
  organization user.
- Shared list, overlay, feedback, and composite implementations live under
  `components/ui/`; the existing global rail and report KPI implementation were
  audited against the requirements above.
- P3-P4, P19, P22, and P23 remain open because their complete interaction
  contracts are not yet present, even where a partial predecessor exists.

## Routing rules

- `/settings` opens Personal settings.
- Workspace settings begin at `/settings/general`.
- Unknown settings paths return to the dashboard.
- Permission failures use `/access-denied`.
- A module with a sub-rail redirects its bare route to its first available child.
- Drawers and all other detail states are URL-addressable.
- Slugs use kebab-case only.

## Execution order

1. Inventory existing components against P1-P24; certify, repair, or replace each.
2. Finish tokens and P14 operational states.
3. Complete navigation and routing primitives P1-P4.
4. Complete list and overlay primitives P5-P13 and P19.
5. Complete feedback/composite primitives P15-P24.
6. Assemble Personal and Workspace settings.
7. Assemble Contacts and Inbox.
8. Assemble all report destinations.
9. Assemble Dashboard and Broadcasts.
10. Build the workflow canvas after the workflow engine contract is proven.
11. Add provider-gated channel rails with each provider implementation.
12. Add AI and Calls only after their explicit product/infrastructure decisions.

## Required visual evidence

For each assembly phase, capture Playwright evidence at 375, 768, and 1440 px
in Arabic RTL and English LTR, in light and dark. Verify no overlap, clipping,
page-level horizontal scrolling, unreachable actions, blank data surfaces, or
unexplained disabled states. The campaign composer and platform-owner surfaces
must be tested with fixtures that grant access; a typecheck is not visual proof.
