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
| 0. Hardcoded-value audit | S | **Next; not started** | Read-only source and runtime-value inventory | Report only. Do not replace constants or apply a migration. |
| 1. Platform console repair | S | **Complete, `6f13e995`** | Existing `operational-state.tsx` | None beyond the serial gates. |
| 2. Shared reporting primitives | M | **Not started** | UI contract for seven date presets, first-click opening, and export formats | Build once for Dashboard and Reports; no duplicate date/chart controls. |
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
