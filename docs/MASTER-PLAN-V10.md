# RabiTech Master Plan V10

**Evidence snapshot:** 2026-08-31, repository `main` at `6f13e995`.

This plan is an evidence record, not an implementation promise. Statuses below
come from the current source tree, migration directory, test files, and the
recent release history. The checkpoint remains authoritative where documents
disagree; code and measured execution win over both.

## Current baseline

- The tenant Settings, lifecycle, tags, snippets, channel switching, inbound
  media filenames, delivery acknowledgements, and platform-console load states
  are shipped. They are not repeated as missing work because an older document
  says so.
- Meta template phase 1 exists at commit `29ea2eff`: lifecycle routes, webhook
  sync, polling worker, WABA isolation, and the schema migration are present.
  The migration is **not applied**. Sending and the tier ceiling remain absent.
- Item 1 below is already complete at `6f13e995`; it is retained in this plan as
  the measured status of the ordered work, not as a request to redo it.
- The real Meta path remains owner-blocked. The OpenWA gateway has a live
  session and must not be restarted without explicit approval.

## Ordered work

| Item | Size | Measured status | Dependencies | Hard stop |
| --- | --- | --- | --- | --- |
| 0. Hardcoded-value audit | S | **Complete; audited 2026-08-31** | Read-only source and runtime-value inventory | Report only. No runtime values were changed. |
| 1. Platform console repair | S | **Complete, `6f13e995`** | Existing `operational-state.tsx` | None beyond the serial gates. |
| 2. Shared reporting primitives | M | **Complete; measured 2026-08-31** | UI contract for seven date presets, first-click opening, and export formats | Built once for Dashboard and Reports; no duplicate date/chart controls. |
| 3. Tenant Dashboard | L | **Absent**; `/overview` redirects to `/reports`; backend summary exists | Item 2 and the summary/analytics data contract | Every card needs real loading, empty, and error states. Do not use placeholder metrics. |
| 4. Reports completion | L | **Partial**; six report tabs, plus an unexposed closures API | Item 2; owner approval of the eleven-report taxonomy | Propose the taxonomy and stop. Do not invent the missing destinations. |
| 5. Broadcast completion | M | **Partial**; list, composer, scheduling, and delivery dialog exist | Existing OpenWA campaign path; Meta templates are not required for OpenWA-only work | OpenWA only. Meta business-initiated sends remain blocked. |
| 6. Contacts merge and export | M | **Partial**; manual merge, import, filters, bulk actions exist; suggestions/export absent | Duplicate rules, merge history/undo policy, export permissions | Stop before a migration. Cross-tenant merge must be database-enforced and mutation-tested. |
| 7. Files library | L | **Absent**; thread-local media exists | Storage, retention, access, and reuse decision | Stop and report storage/retention first. Do not add records before that decision. |
| 8. Growth widgets | M | **Absent**; channel/QR connection primitives exist | Public-domain and attribution decisions | A placeholder may support UI work, but public-domain behavior must not be implied as live. |
| 9. Integrations | XL | **Absent** as a catalog/adapters surface; workflow HTTP webhook exists | Owner approval of Developer API and outbound Webhooks scope | Recommend the two primitives; do not build twelve adapters. Credentials use the vault pattern. |
| 10. Workflow canvas | L/XL | **Partial**; list, modal builder, runtime, validation, and executions exist | Contract decision: current 5 triggers/11 actions/20 cap versus target 11/19/100 | Stop before canvas work. Preserve the existing runtime and get the contract approved first. |
| 11. Login audit | S | **Not started as an audit**; working login, signup, reset, and 2FA paths exist | Current browser matrix and source review | Measure only. Do not rebuild working authentication. |
| 12. Signup and landing connection | M | **Partial**; landing, pricing, signup, plan selection, and verification flow exist | Live/API contract for `listPlans()` and public failure states | Propose the smallest end-to-end signup correction after measuring; stop before implementation. |
| 13. Promotions | M | **Not started**; per-subscriber `discountPercent` exists, public promotion model does not | Promotion semantics and resolver placement decision | Stop before migration. Keep public promotions distinct from subscriber commercial overrides. |
| 14. Meta templates phase 2 | L | **Phase 1 present, migration unapplied; phase 2 not started** | Applied phase-1 schema, real/stub provider contract, ack path | No migration application in this item. Build stubs first; real credential testing remains separate. |
| 15. Small deferred items | S, batched | **Mostly complete**: accessibility delta `5c1884da`, media filenames `e892c765`, and Inbox close-policy browser test are present; PlanCode cost report remains | Item 0 audit | Fix only confirmed small gaps. Do not make PlanCode data-driven in this item. |
| 16. Meta end-to-end validation | Blocked | **Owner-blocked**; no real traversal yet | `OPENWA_API_KEY` rotation, Meta app secrets, public HTTPS tunnel, test WABA/number/recipient, archive approval | Do not rotate, connect, restart, or tunnel until the owner explicitly supplies the decisions. |

## Item 0 audit scope

The audit will classify each value as **owner-editable**, **hardcoded**, or
**partial**, with the source location and whether changing it currently requires
a deploy. It will cover:

- Public pricing display and the `listPlans()` path.
- `PlanCode` and the relationship between the typed entitlement fallback and
  database `Plan` rows.
- `billing.trialHours`, including its platform-setting fallback.
- Feature availability flags, especially `callsAvailable: false`.
- Workflow trigger/action lists and action limits.
- Quota defaults in `OrganizationConfig`, plan rows, entitlement resolution,
  and any billion-value unlimited fallback.

The output must identify owner-controlled values that still have a compiled
copy which can drift, but it must not fix them as part of the audit.

### Item 0 result: hardcoded-value audit

| Value | Classification | Measured reality | Deploy risk and required follow-up |
| --- | --- | --- | --- |
| Public pricing | **Partial** | `/api/billing/plans` reads active database `Plan` rows and `listPlans()` returns database price, currency, and limits. Public pricing still hardcodes the three-hour trial sentence and filters out `FREE` in the UI. | Price and plan limits are owner-editable without deploy. The three-hour copy is a drift defect: changing `billing.trialHours` does not update it. The `FREE` exclusion is a deliberate product rule, not a price field. |
| `PlanCode` | **Partial** | `PlanCode` is the closed union `FREE | STANDARD | GROWTH | BUSINESS | ENTERPRISE`; `PLAN_ENTITLEMENTS` is the seed/boot fallback. Existing database rows are loaded into the edition cache after startup and used by resolution. | Editing an existing edition's supported fields is owner-editable and refreshes without restart. Adding a new code needs TypeScript, validation, seed, and likely migration/release work; an unknown database code is skipped or rejected. Making the code set data-driven is not a small audit fix. |
| `billing.trialHours` | **Partial** | `PlatformSetting` is read and written through the platform settings API. Missing, invalid, or out-of-range values fall back to the compiled `TRIAL_HOURS_DEFAULT = 3`; the maximum is compiled as 365 days. The public pricing copy also says three hours. | Normal trial-duration changes are owner-editable without deploy. Changing the fallback, maximum, or customer-facing copy requires deploy and currently can make the public promise disagree with the actual setting. |
| `callsAvailable` | **Hardcoded, deliberate deferral** | The backend returns `callsAvailable: false`; frontend capability fallbacks also use `false`. The sidebar omits Calls and no call provider/runtime exists. | It cannot safely become an owner toggle: setting it true without the Calls product would advertise a nonexistent capability. Enabling it requires a code, provider, permission, and compliance release. AI and Calls remain deferred by decision. |
| Workflow trigger/action lists | **Hardcoded product contract** | `TRIGGER_TYPES` contains 5 triggers and `ACTION_TYPES` contains 11 actions. Validation and the schema endpoint consume these compiled arrays. `MAX_BRANCH_DEPTH = 3`, `MAX_ACTIONS = 20`, `MAX_CONDITIONS = 10`, and the seven-day wait bound are also compiled. | Adding or changing semantics requires deploy and runtime code. The lists are not currently owner-editable; per-edition availability is not implemented. The target 11/19/100 contract must be approved before a canvas or data-driven catalog is attempted. |
| Edition prices, quotas, seats, workflows, and campaign pacing | **Partial** | Database `Plan` rows are the live catalogue after refresh. The owner console/API edits price, active contacts, outbound, campaign sends, custom fields, users, workflows, and campaign-rate fields. The UI does not expose every API-editable field, notably pacing. | Existing values can change without deploy. The compiled `PLAN_ENTITLEMENTS` object remains a seed and first-boot fallback, so it must stay synchronized with database rows; the harness checks this. |
| `OrganizationConfig` quota defaults | **Hardcoded fallback** | Schema defaults are `1000` active contacts, `10000` outbound messages, and `5000` campaign sends. Signup and plan activation explicitly write plan-derived values, but a direct config creation can still receive these defaults. | Changing the schema defaults needs a migration and generated-client release, although it should not be the normal way to change a plan. The intended source is the edition catalogue plus entitlement resolution; these defaults are a drift risk and should be removed or centrally justified in a later item. |
| Unlimited quota representation | **Hardcoded implementation detail** | Unlimited plan values are normalized to `null`, but config columns receive `1_000_000_000` and the resolver interprets values at or above that sentinel as unlimited. | It should not be owner-editable. Changing it requires deploy and possibly data handling; it must never appear as a customer-facing quota. |
| Trial plan default | **Partial** | `billing.trialPlan` is a platform setting with a compiled `GROWTH` fallback and validation against `PlanCode`. | The normal choice is owner-editable without deploy. Adding a new plan still hits the closed `PlanCode` boundary; changing the fallback requires deploy. |

**Item 0 conclusion:** the owner-controlled catalogue is substantially live for
existing editions, but three compiled boundaries remain: the closed PlanCode
set, invalid-setting fallbacks, and workflow/capability contracts. The clearest
customer-facing defect is the public three-hour trial sentence. No code or
configuration was changed in this audit.

### Item 2 result: shared reporting primitives

- `DateRangePicker` now owns seven presets (`today`, `yesterday`, last 7/30/90
  days, this month, and last month), opens on its first click, and resolves
  explicit local-day/month boundaries into the existing report range contract.
- `ChartCard` now owns chart grouping plus SVG, PNG, and CSV export controls.
  `LineChart` keeps its axes and date labels when the selected range has no
  points, so empty data is not rendered as a missing chart.
- Reports use these shared controls and expose a visible operational error
  state with retry. Loading, empty, and error paths remain separate in the
  report page and chart primitive.
- The focused reporting browser check passed, and the complete matrix passed
  **79/79** with the documented session fixture. The real stack was rebuilt
  with `docker compose build frontend` and redeployed with `docker compose up
  -d frontend`; backend, PostgreSQL, Redis, and OpenWA remained running.
- The unmocked visual check at `localhost:18080/reports` passed all six
  Arabic/English x 375/768/1440 combinations. Real platform login returned
  200, the platform returned three subscribers, the selected workspace was
  active, `/api/auth/me`, `/api/analytics/overview`, and
  `/api/analytics/gateway` returned 200, and the report contained six
  headlines and eight series points. Each viewport stayed on `/reports`, had
  one date-range control and one export control, and had no horizontal
  overflow. Screenshots are in `%TEMP%\\rabitech-reports-visual`.

## Dependency order

1. Complete the read-only audit and resolve scope decisions: report taxonomy,
   workflow contract, storage policy, promotion semantics, and reduced versus
   full parity.
2. Complete the independent platform-console repair, then build the shared
   reporting primitives.
3. Run Dashboard, Reports, Contacts, Broadcast, and Files as parallel tracks
   where their contracts permit. Contacts merge history and Files records are
   the likely migration boundaries and must be separately gated.
4. Finish the Workflow canvas only after its runtime contract is approved.
   Growth can proceed against stubs after public-domain decisions. Integrations
   require adapter scope; AI and Calls remain deliberately deferred.
5. Complete Meta template sending and the ceiling only after phase 1 is applied
   through the gated release sequence. Then perform the owner-approved real
   Meta validation.

Meta templates are a genuine prerequisite for Meta business-initiated messages,
but not for OpenWA broadcasts. AI and Calls are not prerequisites for the core
Inbox, Contacts, Broadcast, or reporting product.

## Owner decisions and external blocks

- Choose full parity or a reduced commercial scope.
- Approve the exact eleven report destinations before Reports completion.
- Approve the workflow vocabulary and limits: current 5/11/20 versus target
  11/19/100, including durable waits and named Else branches.
- Choose Files storage, retention, deletion, and download policy.
- Approve the recommended Integrations scope: Developer API and outbound
  Webhooks only.
- Decide whether AI and Calls remain deferred, as this plan assumes.
- Define promotion eligibility, stacking, codes, dates, display, and whether
  it is automatic or code-gated.
- For the real Meta test, explicitly approve credential rotation risk, the
  2026-08-26 recovery archive, test WABA/number/recipient, Meta app values,
  and the public tunnel.

## Standing rules

- Tenant copy goes through `t()` for Arabic, Hebrew, and English. Platform
  console copy is English-only.
- Use logical CSS properties only.
- Never branch on frontend `=== 'META'` or `=== 'WHATSAPP_CLOUD'`; use
  capabilities and provider contracts.
- Read `docs/UI-SURFACE-MAP.md` and `docs/RESPONDIO-UI-EXECUTION.md` before
  every UI edit.
- Mutation-test every check guarding tenancy, permissions, or policy boundaries.
- Gates run serially: isolation harness alone, i18n, mojibake, frontend build,
  then browser matrix alone. A gate is green only after its process was watched
  to completion.
- Before a migration: gates green, restore-verified backup, rebuilt images,
  confirmed pending migration, deploy, verify, and certify.
- Never touch the separate halla stack. Never restart OpenWA without explicit
  approval. No force-push and no history rewriting.

## Lessons paid for

- A documented green gate is not evidence that the gate could execute.
- Runtime duration does not identify what ran or why it failed.
- A passing fallback proves only the fallback; feature paths need direct
  exercise.
- Tenancy and policy checks require deliberate mutation tests: break the code
  and confirm the check fails.
- Containers and frontend builds are snapshots. Rebuild before migration or
  after adding a route; an old image can truthfully report the wrong reality.
- Documents must be verified against the repository before planning from them.
- When measurement contradicts an expectation, report the measurement and
  correct the record.
