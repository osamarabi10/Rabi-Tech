# RabiTech Respond.io Parity - Authoritative Implementation Checkpoint

> Status: active implementation record.
> Last updated: 2026-08-26 after work stopped during the Conversation Operations implementation.
> Purpose: this is the first document to read when work resumes after a stop, context reset, or handoff.

## 1. Product boundary

RabiTech is a multi-tenant messaging operations SaaS inspired by Respond.io. It is not a pixel-only replica. Parity means matching useful operational contracts while preserving RabiTech's existing tenancy, OpenWA, billing, queue, and Arabic-first architecture.

Every completed UI must support:

- Arabic, Hebrew, and English.
- RTL for Arabic and Hebrew; LTR for English.
- Light and dark themes.
- 375 px mobile, 768 px tablet, and 1440 px desktop without page overflow.
- Keyboard operation, visible focus, accessible labels, loading, empty, no-result, error, disabled, and permission-denied states.
- Server-enforced permissions and tenant ownership. Frontend hiding is never the security boundary.

## 2. Live baseline

The local production-like Docker stack is running at:

- Frontend: `http://localhost:18080`
- Backend: `http://localhost:4000`
- Backend health: `http://localhost:4000/health`
- OpenWA: healthy in Docker
- PostgreSQL and Redis: running in Docker

### Host port map

Host ports were remapped because another local stack on this machine holds
`5432`, `8080`, `3000`, and `3001`. Container-internal ports are unchanged, so
every compose service URL still reads `postgres:5432`, `openwa:2785`, and
`backend:4000`.

| Service | Host port | Container port |
|---|---|---|
| PostgreSQL | `15432` | `5432` |
| Frontend | `18080` | `8080` |
| Backend | `4000` | `4000` |
| Redis | `6379` | `6379` |
| OpenWA REST | `13000` | `2785` |
| OpenWA dashboard | `13001` | `2886` |

`8081` is deliberately left free: `playwright.config.ts` starts its own Next
server there with `reuseExistingServer: false`, so binding it would break the
browser gate. Host-run commands read `DATABASE_URL` from `.env`, which must
point at `localhost:15432` — pointing it at `5432` reaches the other stack.

Live database state:

- `66` Prisma migrations are applied.
- Latest live migration: `20260918090000_plan_editions_seed` (deployed 2026-08-29 — see §6b).
- `/settings/snippets`, `/settings/tags`, and `/settings/contact-fields` return `200`.
- Anonymous `/api/snippets`, `/api/contacts/tags`, and `/api/contacts/contact-fields` return `401`.
- `/health` returns `healthy`; database, Redis, OpenWA, and queue depth are `ok`.

Latest release evidence:

- Backend isolation and usage harness: `109/109`.
- Browser matrix: `75/75`.
- Backend production build and Prisma constructor lint: pass.
- Frontend production build, i18n completeness, and mojibake checks: pass.
- Verified backup: `auto-20260829-143026.dump`, `1,109,740` bytes.
- The backup was restored into a scratch database and counted `31` conversations, `97` messages, and `33` contacts before migrations 65 and 66 were deployed. Data is unchanged after them.

Both gate numbers rose because two gates were found non-functional on this
machine and repaired — see the preconditions in §8. Neither number is
comparable to the one it replaces without that context: the harness gained
conversation-lifecycle, closure-reporting and edition coverage, and the browser
matrix gained `/settings/conversations` across all eighteen combinations.

Known local deployment warnings, not introduced by the current parity work:

- `ALLOW_INSECURE_SECRETS` permits weak local database and OpenWA credentials. Do not carry this into an internet-facing deployment.
- Mail uses the non-delivering `log` provider. Email flows are structurally implemented but real delivery is not enabled.

## 3. Completed platform foundation

### Tenant and security boundary

- Separate platform and organization JWT scopes.
- Platform owner control plane and subscriber provisioning.
- Fail-closed `AsyncLocalStorage` tenant context.
- Prisma tenant extension plus composite parent-child foreign keys.
- Organization-prefixed Socket.io rooms and BullMQ job IDs.
- Organization-owned OpenWA provider resolution and webhook tokens.
- Signed/authenticated media access.
- Per-organization sequences, working hours, keyword caches, and provider caches.
- Token revocation, session tracking, rate limits, TOTP, and recovery codes.
- Two-tenant bleed, cross-ID, worker no-context, socket, aggregate, cache, quota, billing, workflow, and provisioning coverage.

### Operational and commercial foundation

- Worker fairness and per-conversation coordination.
- Append-only usage events and idempotent daily rollups.
- Monthly active-contact and outbound quota enforcement.
- Plans, trials, billing lifecycle, receipts, dunning, and platform commercial overrides.
- Resumable per-subscriber gateway provisioning lifecycle.
- Verified scheduled database backup and restore proof.
- Gateway, queue, worker, analytics, and backup operational monitoring.

## 4. Completed Respond.io-facing surfaces

### Shared UI system

- Responsive application and settings rails.
- Shared list toolbar, row action menu, drawer, dialogs, confirmation, operational states, feedback, tables, and KPI primitives.
- Notification Center with New, Archived, and All scopes.
- Access-denied boundary with a single return action.
- Global Help menu and persistent Onboarding checklist.

### Personal and workspace settings

- Personal profile, language, theme, password, presence, and two-factor authentication.
- Notification delivery preferences and sound control.
- Workspace General: name, inactivity policy, timezone, and weekly recap recipients.
- Workspace Users: secure invitations, roles, teams, restrictions, presence, and seat limits.
- Teams: metadata, members, routing strategy, capacity, default team, and safe deletion.
- Channels: OpenWA connection state, QR pairing, temporary disconnect, and unlink danger zone.
- Lifecycle: ordered active/lost stages, default stage, protected semantics, and reassignment on deletion.

### Contacts and Inbox depth

- Responsive Contacts table, search, filter DSL, nested filters, saved segments, bulk toolbar, URL-addressable detail drawer, and Contact import foundation.
- Three-pane Inbox foundation with conversation scopes, thread, contact context, assignment, consent provenance, lifecycle, custom field values, conversation history, files, activity, snooze, internal notes, mentions, retry, and channel readiness.
- Dedicated workspace Snippets:
  - Up to `5,000` Snippets.
  - Search by name, message, shortcut, or ID.
  - Up to `10` topics.
  - Up to `5` files per Snippet.
  - Signed provider-facing attachment URLs.
  - `/shortcut` composer expansion with legacy `:shortcut` compatibility.
  - Standard, custom Contact, assignee, and system dynamic variables resolved at final server send.
  - Unknown variables remain literal.
  - Correct OpenWA image, video, audio, and document endpoints.
  - Partial multi-file failure keeps successful sends visible and leaves unsent files pending.
- Dedicated workspace Tags:
  - Owners and Managers create, edit, and permanently delete shared Tags.
  - Name, color, emoji, description, and assigned Contact count.
  - Exact assigned-count confirmation before permanent deletion.
  - Agents can create Tags only while assigning them to a visible Contact in the Inbox.
  - Manual, import, workflow, and API provenance fields are retained on assignments.
- Dedicated workspace Contact Fields:
  - Locked standard fields plus custom text, list, checkbox, email, number, URL, date, and time fields.
  - Generated immutable Field ID and immutable type after creation.
  - Workspace order and Always show, Hide when empty, or Always hide visibility.
  - Owners and Managers create/edit; only Owners delete definitions and stored values.
  - Shared validation across direct Contact edits and bulk imports, including strict calendar dates.
  - Inbox Contact panel renders the correct control for every type and can reveal hidden/empty fields.

## 5. Contact Metadata release record

Migration `20260915090000_contact_metadata_settings` is deployed. The live database preflight found zero case-insensitive duplicate custom-field names and no existing rows requiring manual conflict resolution. The release was backed up before migration and verified after restart.

Release gates:

- Prisma format/generate, backend build, and constructor lint: pass.
- Tenant, role, provenance, immutable-field, value-validation, import, and cross-organization metadata contract: pass inside the `91/91` harness.
- Arabic/Hebrew/English completeness and mojibake checks: pass.
- Frontend production build: pass.
- All responsive settings and Contacts scenarios plus focused Tag/field mutation tests: `56/56`.
- Docker backend/frontend builds: pass.
- Live migration count: `63`; database schema is up to date.
- Live health: database, Redis, OpenWA, and queue depth are `ok`.

Important retained contracts:

- The Tag assignment audit stores a human-readable actor snapshot because identities may later be disabled or renamed.
- Import and direct editing call the same custom-field validator; an invalid typed field rejects the import row rather than storing malformed data.
- Tag deletion is permanent and can affect Segments and Workflows, so the server independently checks the exact current assignment count.
- Custom field IDs and types are ignored on update and protected by contract tests; clients cannot mutate them after creation.
- Snippet management UI now uses the same Owner/Manager authority as its backend instead of incorrectly hiding controls from Managers.

## 6. Conversation Operations — released 2026-08-29

**Migration `20260916090000_conversation_operations` is deployed.** Exactly one
migration applied, `63` → `64`. Everything below is transcribed from command
output, not from intent.

Release gates, all executed fresh immediately before the deploy rather than
carried over from earlier runs:

- Isolation and usage harness: **`102/102`**, exit 0, no orphan process, disposable schema dropped.
- Responsive browser matrix: **`75/75`**, exit 0, 4.5 minutes under real Chromium.
- Prisma format (no drift), generate (`5.22.0`), backend build, constructor lint, `check:i18n`, `check:mojibake`, frontend production build: all pass.
- Backup, restore-verified: `auto-20260829-130417.dump`, `1,092,532` bytes, restored into a scratch database and counted `31` conversations, `97` messages, `33` contacts. **Unused — no rollback was needed.**

Post-deploy verification:

- `prisma migrate status`: `64 migrations found`, `Database schema is up to date!`
- Live health: database, Redis, OpenWA, and queue depth all `ok`.
- Data intact: **`31` conversations, `97` messages, `33` contacts** — unchanged across the migration.
- `ConversationCategory` and `ConversationClosure` present and correctly empty; the nine new columns readable across all `31` conversations.
- `/settings/conversations` returns `200`; `/api/conversation-settings`, `/api/conversation-settings/categories`, and `/api/analytics/closures` return `401` — the auth gate is reached, not a `500`.
- No unhandled exceptions and no `prisma:error` entries since restart.

**The functional proof is the recovery query, not the route codes.** Before this
migration every boot logged `Failed to recover conversation auto-close jobs —
The column Conversation.autoCloseAt does not exist`. That line now appears zero
times, and `recover-conversation-auto-close-jobs` runs with nothing following
it. `recoverConversationAutoCloseJobs()` queries `Conversation.autoCloseAt`
directly, so its silence is a real production read against a migration-64
column. A `200` proves a route compiled; this proves the data path works.

Standing caveat, recorded rather than glossed: **`ALLOW_INSECURE_SECRETS` is
still `1`**, with `OPENWA_API_KEY` on a known-weak value as the outstanding
deferred item. It was deferred because rotating it requires restarting the
OpenWA gateway, and the live WhatsApp session is worth more than closing a
local key whose ports are now loopback-only. This release is complete; the
security posture is **not** clean, and nothing here should be read as saying it
is.

Precondition this release established, and the one most worth keeping.
**Confirm the image names the pending migration before deploying.** The running
image had been built while migration 64 was held out of the migrations
directory, so it contained `63` and reported `Database schema is up to date!`.
Deploying from it would have exited `0`, applied nothing, and left every
downstream check passing against tables that did not exist — a failure
indistinguishable from success. The check is one command, and it must name the
migration:

```powershell
docker compose run --rm --no-deps backend npx prisma migrate status
# Must list the migration under "have not yet been applied".
# If it says "up to date" at the previous count, STOP: the image is stale
# and migrate deploy is a silent no-op.
```

The record below is the pre-release state, kept as written for history.

### Original resume point (historical)

This was the exact resume point. Execute it before deeper Contact data operations, reporting, Broadcast parity, or the Workflow canvas.

### Goal

Finish the operational contract around resolving and categorizing conversations so Inbox work produces reliable structured reporting rather than only a status change.

### Required scope

- Conversation categories.
- Closing summary/note policy and required/optional behavior.
- Auto-close settings.
- Category and summary reporting.
- Remaining Inbox rail, keyboard navigation, and mobile context-panel parity.

### Paused source checkpoint

> **Superseded 2026-08-29.** Everything from here to the end of §6 describes the
> paused state before the release and is kept for history. It is no longer
> true: migration 64 is applied, the worktree is clean, and the coverage listed
> below as missing now exists. Read the release record at the top of §6 for the
> current state.

The live deployment is still migration `63`. Migration `20260916090000_conversation_operations` is a local draft and has **not** been applied.

Implemented in the current dirty worktree but not release-certified:

- Organization-owned conversation categories and immutable conversation closure episodes in Prisma.
- Closing source, category snapshot, summary, actor snapshot, opened time, and closed time.
- One idempotent lifecycle service used by manual and Workflow closure paths.
- Reopen starts a new episode and keeps earlier closure history.
- Manual close preserves assignment.
- Persisted auto-close eligibility, last-human-outbound timestamp, and deadline.
- Delayed BullMQ auto-close jobs with organization-prefixed deadline-specific IDs and stale-job no-op checks.
- Startup recovery for persisted deadlines.
- Successful human customer-facing sends schedule the timer; failed sends, internal notes, and automated sends do not.
- Customer replies cancel the timer; snooze moves it after wake-up.
- Conversation Settings API for auto-close policy, closing-note modes, and category management.
- `/settings/conversations` management surface and Inbox category/summary close form in Arabic, Hebrew, and English.

Verification state at stop:

- Backend and frontend builds passed during implementation, but additional source edits followed those runs. Treat the current tree as unverified until both builds are rerun.
- The i18n checker identified three missing generic strings; translations were added, but the checker has not been rerun.
- Conversation-specific tenancy, role, immutable-history, idempotency, and auto-close tests are not yet in the harness.
- Conversation Settings and Inbox closing behavior are not yet in the Playwright matrix.
- Migration `64`, backup, Docker rebuild, deployment, route checks, health checks, and documentation certification remain undone.

Deferred, recorded 2026-08-29 so it is not lost: **a browser test of the Inbox
close form**. The responsive matrix now covers `/settings/conversations` across
all eighteen combinations, and the closing-note mutation is asserted there —
but the Inbox close form itself is untested in the browser. It lives inline in
`app/(dashboard)/inbox/page.tsx` with no dedicated component, and there is no
Inbox spec in the matrix at all, so covering it means building Inbox mock
scaffolding — conversations, messages, contacts, assignment, channel state —
from scratch.

It was deferred on a judgement, not an oversight. The closing policy is
enforced on the server, and the isolation gate proves it cannot be bypassed
even by calling the service directly. A browser test would show the form
renders and submits; it could not show the rule holds. So the scaffolding buys
presentation coverage on top of a property that is already proven, which is not
where the next hour of test-writing pays best. Scope it separately if an Inbox
spec gets built for other reasons.

### First work on resume

1. Inspect `git status --short` and the migration `20260916090000_conversation_operations`; do not reset the dirty worktree.
2. Run Prisma format/generate, backend build, frontend i18n/mojibake checks, and frontend build against the current source.
3. Fix every compile or language failure before extending the implementation.
4. Add conversation lifecycle coverage to the disposable-schema tenancy harness, including role denials, cross-organization categories, policy bypass attempts, closure snapshots after category deletion, duplicate close idempotency, reopen episodes, assignment preservation, stale deadlines, due deadlines, and customer-reply cancellation.
5. Extend the responsive Playwright matrix for `/settings/conversations` and add a focused Inbox close-policy mutation test.
6. Add category/source/summary reporting backed by `ConversationClosure`, then prove exact reconciliation.
7. Run the complete backend and browser gates. Only then create and restore-verify a backup, build Docker images, apply migration `64`, restart services, and verify migration status, routes, health, and logs.

### Definition of done

- Owner/Manager/Agent resolution and reopen permissions are server-enforced; Viewer/Finance write attempts fail.
- Required closing summary/category rules cannot be bypassed by direct API calls.
- Manual close, auto-close, reopen, assignment, and category events are auditable and tenant-scoped.
- Auto-close is resumable/idempotent and cannot close a conversation after newer customer activity.
- Category/summary reporting reconciles exactly with persisted close events.
- Desktop/tablet/mobile Inbox behavior passes Arabic/Hebrew/English and light/dark browser coverage.
- The release evidence is written here before moving to R2.

## 6b. Owner-controlled edition ladder — released 2026-08-29

**Migrations `20260917090000_plan_editions` and `20260918090000_plan_editions_seed`
are deployed.** Two migrations applied, `64` → `66`. Transcribed from command
output, not from intent.

Until this, an owner could grant one subscriber a commercial exception — the P9
overrides are shipped and audited — but could not change the menu everyone is
sold from. Which editions existed, what each granted, and each list price lived
in a TypeScript constant, so repricing a tier was a code change and a deploy.

Release gates, executed fresh immediately before the deploy:

- Isolation and usage harness: **`109/109`**, exit 0.
- Responsive browser matrix: **`75/75`**, exit 0.
- Prisma format (no drift), generate (`5.22.0`), backend build, constructor lint, `check:i18n`, `check:mojibake`, frontend production build: all pass.
- Backup, restore-verified: `auto-20260829-143026.dump`, `1,109,740` bytes, restored into a scratch database and counted `31` conversations, `97` messages, `33` contacts. **Unused — no rollback was needed.**

**Both halves confirmed, not just the first.** A columns-only landing is the
subtle failure here: the schema would look right while every enforcement site
silently kept reading the compiled-in constant.

- Columns: all **13** new `Plan` columns present.
- Constraint: `Organization_planOverride_check` now admits `FREE, STANDARD, GROWTH, BUSINESS, ENTERPRISE`.
- Catalogue: **five editions seeded**, byte-identical to `PLAN_ENTITLEMENTS` — asserted field by field by a harness check, so a drift between the two is a failed gate rather than a surprise on an invoice.

| code | price | MAC | outbound | users | channels |
|---|---|---|---|---|---|
| FREE | 0 | 100 | 100 | 1 | `{OPENWA}` |
| **STANDARD** | **1900** | **500** | **2000** | **2** | `{OPENWA}` |
| GROWTH | 4900 | 2500 | 10000 | 5 | `{OPENWA}` |
| BUSINESS | 19900 | 10000 | 50000 | 25 | `{OPENWA}` |
| ENTERPRISE | 0 | *null* | *null* | *null* | `{OPENWA}` |

Enterprise keeps `NULL` on every metered limit, because null is the promise the
tier makes. The `1,000,000,000` sentinel lives in `OrganizationConfig`, whose
columns are NOT NULL, and a harness check asserts it never leaks into the
catalogue where it would read as a bizarre quota.

Post-deploy verification: `migrate status` reports `66 migrations found` and
`Database schema is up to date!`; `/health` green on database, Redis, OpenWA and
queue depth; data intact at **`31` / `97` / `33`**; `/platform/editions`,
`/platform/subscribers`, `/settings/conversations` and `/inbox` all `200`;
`/api/platform/editions` returns `401` anonymously — the auth gate, not a `500`;
no unhandled exceptions and no `prisma:error` entries.

**The proof of the phase is the restart test.** A price was edited, the backend
restarted, and the edit held:

```
before edit:    4900
after edit:     5500
docker compose restart backend      (ensurePlans runs at boot)
after restart:  5500   <- held
```

Before `ensurePlans` became create-only, that last line would have read `4900`:
the boot seeder rewrote the row from the constant, so an owner's Friday price
change was gone by Monday with nothing in any log to explain it. GROWTH was
restored to `4900` afterwards.

### Two bugs the pass criteria caught

Neither was found by reading the code. Both were found by writing the check that
had to pass.

**A SQL constraint would have blocked Standard at runtime.**
`Organization.planOverride` is `TEXT` with a CHECK listing valid codes, not an
enum, so the code list lives in SQL as well as in `PlanCode`. A fifth edition
without widening it would have let an owner select Standard in the console and
be refused by the database at write time — the failure landing on the one person
with no way to diagnose it. Folded into migration 65 rather than a third
migration, since 65 was unapplied everywhere.

**Deactivating an edition silently reverted its subscribers to compiled
defaults.** `refreshEditions` filtered `isActive: true`, so retiring a plan
dropped it from the cache and everyone on it fell back to `PLAN_ENTITLEMENTS` —
changing what a paying customer was entitled to as a side effect of a
pricing-page edit, and presenting as a billing bug days later. The cache now
holds **every** edition; only the published catalogue filters by `isActive`.
Retiring a plan removes it from the price list without touching the people
already paying for it.

### Standing caveat

**`ALLOW_INSECURE_SECRETS` is still `1`**, with `OPENWA_API_KEY` on a known-weak
value as the outstanding deferred item. It was deferred because rotating it
requires restarting the OpenWA gateway, and the live WhatsApp session is worth
more than closing a local key whose ports are now loopback-only. **This release
is complete; the security posture is not clean**, and nothing here should be
read as saying otherwise.

### Not built

**Creating an edition from the console.** A code must exist in `PlanCode` before
anything can resolve it, so a row created from the console would be a plan no
enforcement path recognises — and the seed diff test would fail on it. The page
states this rather than offering a button that produces an unusable row.
Deferred until `PlanCode` becomes data-driven, which is a larger change than this
phase.

Also carried but deliberately unenforced, both stated inline in the console with
their reason rather than greyed in silence: `autoProvisionGateway` (no
enforcement site exists) and `allowedChannels` (per-edition channel policy is
still OQ-2/OQ-4 in `docs/RABITECH-PRODUCT-VISION.md`). The API refuses both
fields as well — accepting a value nothing reads would let an owner believe they
had granted something.

## 7. Later roadmap

Execute in this dependency order after Conversation Operations.

### R2. Contact data operations

- Contact-field-aware column customization.
- Three-step CSV import: upload, mapping, review.
- Import history and generated import Tags.
- Data export with permissions and audit.
- Merge suggestions and merge history/undo policy.
- Block/unblock behavior across Inbox, Workflow, and Broadcast paths.

### R3. Shared files and integrations

- Workspace Files/media library reused by Snippets and message composition.
- Integrations connected/browse catalog with capability-driven cards.
- Growth widgets, click-to-chat, QR/link generation, attribution, and preview.
- Keep OpenWA capability boundaries explicit; do not show Meta-only controls as fake available options.

### R4. Dashboard and reporting

- Dashboard operational modules: lifecycle, Contacts, teams, conversations, merge suggestions, and Broadcasts.
- Shared date-range picker and chart card.
- Conversation, message, response time, resolution time, Contact, lifecycle, Agent, Tag, Broadcast, and channel reports.
- CSV/SVG/PNG export where supported by the data contract.
- Empty datasets keep chart axes and context intact.

### R5. Broadcast parity

- Rename Campaign presentation to Broadcast where appropriate without destabilizing worker internals.
- Status rail, table/calendar, URL detail, and two-stage composer.
- Segment/filter audience, consent enforcement, channel, schedule, review, throttling, and cancellation.
- Sent, delivered, read, failed, and replied reporting.
- Margin or AI features remain outside this messaging SaaS boundary unless separately approved.

### R6. Workflow completion

- Existing workflow runtime and execution records remain the base.
- Complete durable suspension for waits/questions and remaining trigger/action contracts.
- Build the visual canvas only after runtime contracts are green.
- Draft/published versioning, named branches, validation, run log, retry/stop controls, and 100-step cap.
- Port all remaining hand-written menu behavior into the engine before deleting legacy paths.
- AI nodes remain deferred until the product owner explicitly resumes AI and per-tenant spend caps are active.

### R7. Final parity and production certification

- Public API cursor pagination, error taxonomy, rate limits, and custom-channel contract.
- Platform support analytics and audited support access.
- Complete permissions audit for Owner, Manager, Agent, Viewer, and Finance.
- Full Arabic/Hebrew/English copy audit.
- Full responsive visual and interaction matrix.
- Production-like migration clone, backup restore, live health, queue, gateway, and log checks.
- Update all roadmap documents from evidence, never from implementation intent.

## 8. Mandatory resume procedure

When work resumes:

1. Read this file and `docs/RESPONDIO-UI-EXECUTION.md`.
2. Run `git status --short`; the current dirty worktree contains the ongoing implementation and must not be reset.
3. Confirm live migration status is still `63` before creating the next migration.
4. Confirm `/health` remains green and the latest verified backup is still available.
5. Continue at section 6, "First work on resume," item 1. Do not restart research, Snippets, Contact Metadata, or earlier phases.
6. After every material backend edit, run the backend build before adding more surface area.
7. Before every database migration, run the complete isolation and browser gates, then create a restore-verified backup.

Precondition, every fresh checkout. Dependencies are not committed, and without
them `npx` reaches the network and runs whatever Prisma is newest: this checkout
resolved Prisma `8.0.0-rc.12` against a schema declared `^5.10.0`, where
`prisma format` does not exist and `migrate deploy` would have driven a
three-major-version-newer CLI into the database. Run this first, and stop if the
version check disagrees:

```powershell
cd "C:\Desktop\RabiTech V5 Unfoolded\RabiTech V5\apps\backend"; npm ci
cd "C:\Desktop\RabiTech V5 Unfoolded\RabiTech V5\apps\frontend"; npm ci

cd "C:\Desktop\RabiTech V5 Unfoolded\RabiTech V5\apps\backend"
npx prisma --version
# Both the prisma and @prisma/client lines must report 5.x, inside the
# ^5.10.0 range declared in apps/backend/package.json. Any other version
# means npx resolved a CLI from outside the project: do not run format,
# generate, migrate, or deploy until it reports 5.x.
```

Precondition, and it applies to the **frontend** too. `docker compose up`
rebuilds nothing, and a route added since the last image build returns `404`
from a container that is otherwise healthy. That symptom is indistinguishable
from "the page was never written", which is how a working screen gets debugged
as missing code. On 2026-08-29 the frontend image was from `08-28 12:44` while
`app/platform/editions/page.tsx` was written `08-29 17:16`; restarting without
rebuilding would have served a `404` for a page that existed and compiled.

**Whenever a route is added, rebuild the frontend as well as the backend before
restarting:**

```powershell
docker compose build backend frontend
docker compose up -d backend frontend
```

Precondition, every resume after a transfer, restore, or long pause.
`docker compose up` starts containers from whatever images already exist; it
never rebuilds them. On 2026-08-28 that served a backend and frontend built
`2026-08-23` against a `2026-08-27` source tree, and the symptom looked like
missing work: `/settings/snippets`, `/settings/tags`, `/settings/contact-fields`,
and `/settings/conversations` all returned `404` because those routes were not
in the running bundle, while `prisma migrate status` inside the container
reported `Database schema is up to date!` at `53` migrations because the image
carried `53` of the `64` present on disk. The database, the folder, and the
branch were all correct. Rebuild before drawing any conclusion from a route
status or a migration count:

```powershell
cd "C:\Desktop\RabiTech V5 Unfoolded\RabiTech V5"
docker compose build backend frontend
docker compose run --rm --no-deps backend npx prisma migrate status
```

Consequence for the next session. The current backend image was built while
migration `64` (`20260916090000_conversation_operations`) was deliberately held
out of `apps/backend/prisma/migrations`, so that image contains `63` migrations.
The migration file has since been restored to disk, but the running image cannot
see it. Resuming Conversation Operations therefore requires rebuilding the
backend before any deploy, or Prisma will keep reporting `63`, report itself up
to date, and silently skip migration `64`:

```powershell
docker compose build backend
docker compose run --rm --no-deps backend npx prisma migrate status
# Must report 64 migrations found. If it still says 63, the image is stale
# and migrate deploy would be a no-op.
docker compose run --rm --no-deps backend npx prisma migrate deploy
```

Precondition, before the first real customer Meta credential is stored.
**`ALLOW_INSECURE_SECRETS` must be `0`.** This gate is about onboarding, not
about shipping: Phase 4 may be built and piloted against Meta Development Mode
test credentials with the flag standing, but the moment a real customer pastes a
System User token it becomes a vault of another company's secrets.

The asymmetry is what makes it a hard gate. A System User token sends **as that
business**, so losing one is impersonating a company to its own customers — a
different risk class from losing RabiTech's own gateway key. And this repository
is public with credentials in its history, which is a demonstrated leak path, not
a hypothetical one. Storing other businesses' tokens under a flag whose entire
purpose is to announce that the posture is knowingly unclean is not a trade
anyone would make deliberately; it is one that gets made by forgetting.

Concretely, before onboarding the first Meta customer: rotate `OPENWA_API_KEY`
off its known-weak value, set `ALLOW_INSECURE_SECRETS=0`, and confirm the boot
log no longer prints `RUNNING WITH INSECURE SECRETS`. The rotation needs an
OpenWA gateway restart, so it is scheduled work rather than a flag flip — which
is precisely why it is written down here rather than left to the moment.

Related, and deliberately **not** solved by that rotation:
`CHANNEL_ENCRYPTION_KEY` still has no re-encryption routine. A leaked Meta token
is customer-recoverable — they revoke it and paste a new one. A leaked
`CHANNEL_ENCRYPTION_KEY` exposes every stored token at once with no way to
re-encrypt, and the only remedy would be asking every customer to re-enter their
credentials. The Meta credential table therefore carries a `keyVersion` column
from the start: rotation stays out of scope, but making it possible later is a
different thing from building it now, and retrofitting the column is expensive.

Precondition, before trusting the isolation gate. The gate has silently failed
to complete at least four times, and nobody noticed because the failure mode
produces no output at all. Two independent causes compound, and both must be
checked.

**The trigger is environmental.** Docker Desktop's host port proxy degrades
across a host restart: the published port still appears in `netstat` as
`LISTENING`, and a TCP handshake to it still succeeds, but the proxy then closes
the connection without forwarding it. The container is healthy and the
application is unaffected, because container-to-container traffic uses the
compose network (`postgres:5432`) and never touches a host port. Only host-side
tooling breaks — which is exactly where the harness and the Prisma CLI live.
On 2026-08-29 this affected `15432`, `6379`, and `13001` while `4000`, `18080`,
and `13000` were fine; `4000` had failed the same way earlier that morning. The
fix is to recreate the affected containers:

```powershell
docker compose up -d --force-recreate postgres redis
```

**Verify with real protocol bytes, never a bare handshake.** This is the part
that produced a false green twice. `net.createConnection` succeeding proves only
that the proxy accepted the socket; it says nothing about whether anything
reached the service. A degraded port answers the handshake and then sends
`end` with `hadError=false`, which looks like a clean success to any check that
does not send data. Send a real query — `prisma migrate status` from the host,
or `PING` to Redis — and confirm the service answers. With `log_connections=on`,
`docker compose logs postgres` is the independent witness: if Postgres logged no
`connection received`, the connection never arrived, whatever the client thought.

**The amplifier was structural, and is now fixed.** `command()` in
`scripts/tenancy-bleed-harness.js` called `spawnSync` with no `timeout`. The
harness is single-threaded, so one stuck child blocked the entire gate
indefinitely with nothing on stdout. A degraded proxy left `prisma migrate
deploy` waiting on a half-open socket and the gate sat silent for 33 minutes
before it was killed by hand. It created nothing: an orphaned
`rabitech_bleed_16180_*` schema found alongside it embedded a different pid and
an older schema generation, so it was the corpse of an earlier run, not that
one. Schema names carry the creating pid — use it before attributing a corpse to
a run. `command()` now bounds every child
(`HARNESS_COMMAND_TIMEOUT_MS`, default 300000) and reports the tail of its
output, so this class of failure fails in one line instead of hanging. A release
blocker that can hang forever without output is not a safety net.

**A second, separate hang remains: the harness does not exit when it finishes.**
After printing `91/91 checks passed` and cleaning up its own disposable schema,
the process stays alive holding one open Redis connection to `::1:6379`, which
keeps Node's event loop from draining. It must be killed by hand. This is almost
certainly what happened on 2026-08-25, when two harness processes were found
still running three days later — each holding exactly one Redis connection, each
with roughly 20s of CPU, which is a completed run, not a stalled one. **A passing
gate can therefore look identical to a hung one**, which is how a green result
went unnoticed for three days. Read the printed summary line, not the fact that
the process is still on the process list. Fixing this means closing the Redis
handle (or calling `process.exit` on the recorded result) at the end of the run;
until then, expect to kill the process after reading its result.

Not every leftover schema is a failed run. `rabitech_diff_shadow`,
`rabitech_p1b_shadow` and `rabitech_p1d_debug` do not match the harness's
`rabitech_bleed_<pid>_<timestamp>` naming and come from other tooling; only
`rabitech_bleed_*` schemas are harness corpses.

Note also that the harness now loads its environment from the **repository
root** `.env`, not `apps/backend/.env`. That second copy existed, had drifted to
`localhost:5432` — a different Postgres entirely — and was silently winning, so
the gate would have created its disposable schema somewhere that proves nothing
about tenant isolation. It has been deleted; there is one `.env`, at the top.

Precondition, before trusting the browser matrix. Playwright's browsers are not
installed by `npm ci`. They live in `~/AppData/Local/ms-playwright/`, outside
`node_modules`, so no lockfile install has ever restored them and the snapshot's
`node_modules` exclusion never covered them. On 2026-08-29 that directory did not
exist at all on this machine, and every one of the 75 tests failed identically at
browser launch:

```
browserType.launch: Executable doesn't exist at
  ...\ms-playwright\chromium_headless_shell-1234\chrome-headless-shell.exe
```

Run this once per machine, and after any Playwright version bump:

```powershell
cd "C:\Desktop\RabiTech V5 Unfoolded\RabiTech V5\apps\frontend"
npx playwright install chromium
```

**The recorded `56/56` was not reproducible here.** Playwright enumerates and
reports every test before it launches a browser, so a run with no browsers
installed still looks like a real test session — it names all 75, then fails all
75 on the same missing executable. The count in a report is not evidence that
anything rendered.

That makes **two of the three release gates in this section non-functional on
this machine** when they were relied upon. The isolation gate hung silently after
passing and had to be killed by hand; the browser matrix could not start a
browser at all. Only the six core checks ran unaided. Both are now fixed — the
queue handle closed, the browsers installed — and both were fixed only because
someone ran them and read the output rather than trusting the recorded number.

The rule this leaves behind: **a gate is green when you watched it run, not when
a document says it was.** Before certifying any release, run all three and read
the summary line of each.

Core commands:

```powershell
cd C:\Users\dev\Desktop\malan-isp\apps\backend
npx prisma format
npx prisma generate
npm run build
npm run test:tenancy

cd C:\Users\dev\Desktop\malan-isp\apps\frontend
npm run check:i18n
npm run check:mojibake
npm run build
$env:RABITECH_E2E_SESSION='{"token":"e2e-token","user":{"id":"settings-user","name":"Settings Operator","email":"operator@rabitech.test","role":"ADMIN","permissions":[],"organizationId":"org-test","scope":"ORGANIZATION"}}'
npm run test:e2e
```

Release commands, only after all gates pass:

```powershell
cd C:\Users\dev\Desktop\malan-isp
docker compose exec -T backend npm run backup:now
docker compose build backend frontend
docker compose run --rm --no-deps backend npx prisma migrate deploy
docker compose up -d backend frontend
docker compose run --rm --no-deps backend npx prisma migrate status
curl.exe -s http://127.0.0.1:4000/health
```

## 9. Documents and precedence

Use these in order when statements conflict:

1. This checkpoint for current implementation and exact resume state.
2. `docs/ARCHITECTURE-MULTITENANCY.md` for tenant/security architecture.
3. `docs/RESPONDIO-UI-EXECUTION.md` for UI contracts and certification.
4. `docs/RESPOND-IO-PARITY.md` for researched product differences.
5. `docs/TENANCY-BLEED-HARNESS.md` for the release isolation gate.
6. `docs/PHASES-TO-LAUNCH.md` for broader commercial launch sequencing.

Checked boxes are evidence only when the associated build, isolation, browser, migration, and live health gates recorded here are green.
