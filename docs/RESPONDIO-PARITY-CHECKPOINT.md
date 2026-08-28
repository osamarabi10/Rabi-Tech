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

- Frontend: `http://localhost:8080`
- Backend: `http://localhost:4000`
- Backend health: `http://localhost:4000/health`
- OpenWA: healthy in Docker
- PostgreSQL and Redis: running in Docker

Live database state:

- `63` Prisma migrations are applied.
- Latest live migration: `20260915090000_contact_metadata_settings`.
- `/settings/snippets`, `/settings/tags`, and `/settings/contact-fields` return `200`.
- Anonymous `/api/snippets`, `/api/contacts/tags`, and `/api/contacts/contact-fields` return `401`.
- `/health` returns `healthy`; database, Redis, OpenWA, and queue depth are `ok`.

Latest release evidence:

- Backend isolation and usage harness: `91/91`.
- Browser matrix: `56/56`.
- Backend production build and Prisma constructor lint: pass.
- Frontend production build, i18n completeness, and mojibake checks: pass.
- Verified backup: `auto-20260826-131332.dump`, `1.87 MB`.
- The backup was restored into a scratch database and counted `31` conversations, `97` messages, and `33` contacts before migration 63 was deployed.

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

## 6. Current unfinished subphase: Conversation Operations

This is the exact resume point. Execute it before deeper Contact data operations, reporting, Broadcast parity, or the Workflow canvas.

### Goal

Finish the operational contract around resolving and categorizing conversations so Inbox work produces reliable structured reporting rather than only a status change.

### Required scope

- Conversation categories.
- Closing summary/note policy and required/optional behavior.
- Auto-close settings.
- Category and summary reporting.
- Remaining Inbox rail, keyboard navigation, and mobile context-panel parity.

### Paused source checkpoint

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
