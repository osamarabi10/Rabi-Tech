# RabiTech Respond.io Parity - Authoritative Implementation Checkpoint

> Status: active implementation record.
> Last updated: 2026-08-31 after the Contacts merge/export completion gates.
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

- `67` Prisma migrations are applied.
- Latest live migration: `20260919090000_meta_credential_vault` (deployed 2026-08-30 — see §6c).
- `/settings/snippets`, `/settings/tags`, and `/settings/contact-fields` return `200`.
- Anonymous `/api/snippets`, `/api/contacts/tags`, and `/api/contacts/contact-fields` return `401`.
- `/health` returns `healthy`; database, Redis, OpenWA, and queue depth are `ok`.

Latest release evidence:

- Backend isolation and usage harness: `122/122`.
- Browser matrix: `85/85`.
- Backend production build and Prisma constructor lint: pass.
- Frontend production build, i18n completeness, and mojibake checks: pass.
- Verified backup: `auto-20260829-143026.dump`, `1,109,740` bytes.
- The backup was restored into a scratch database and counted `31` conversations, `97` messages, and `33` contacts before migrations 65 and 66 were deployed. Data is unchanged after them.

Release record (2026-08-30), **migration 67 released**:

- Isolation and usage harness: **`120/120`**, exit 0. The latest check pins
  inbound media filename persistence across both OpenWA and Meta.
  Every check added since the release above was mutation-tested — each fails
  when the fix it guards is reverted, so none is passing through a fallback.
- Browser matrix: **`75/75`**, exit 0. Backend and frontend builds, i18n and
  mojibake: pass.
- **`67` migrations applied.** `20260919090000_meta_credential_vault` was
  deployed 2026-08-30 10:31:58 — see §6c. Nothing is pending.
  `MetaChannelCredential` exists with 16 columns and **0 rows**.
- GitHub Actions tenancy bleed gate: **success** on run `33322278068`, triggered
  by `a77c63c9`. This is the workflow's first successful run — see §8.

**Measured current state (2026-08-31).** The 2026-08-30 release block above is
historical evidence, not the present migration state. The live database still
has 67 applied migrations, but `20260920090000_meta_template_lifecycle` is
written and unapplied. The generated Prisma client knows about the lifecycle
fields, including `Campaign.metaTemplateId`; the live `Campaign` table does
not. A tenant-scoped `GET /api/campaigns` query therefore failed with Prisma
`P2022` until the route was repaired to use an explicit pre-migration select.
No migration was applied during that repair.

**Resolved 2026-08-31, opening the Editions phase.**
`20260920090000_meta_template_lifecycle` is now applied and
`prisma migrate status` reports the database up to date. `migrate deploy` is
the normal path again.

Historical note, because the workaround is visible in the git history: the
invoice integrity migration `20260921090000_invoice_reference_integrity` was
applied by direct SQL and recorded with `prisma migrate resolve --applied`,
deliberately **not** with `migrate deploy` — at that time deploy would have
applied the meta template migration too, as a side effect of an unrelated
phase. That constraint no longer applies.

Applying it also closed drift wider than this section had recorded: three
further schema/database mismatches existed, including
`MetaChannelCredential.businessPortfolioId`, which live code in
`meta.service.ts` **writes**, so connecting a Meta channel failed with `P2022`.
The campaigns route's explicit pre-migration column list has been removed. See
D-6 and D-7 in [KNOWN-DEFECTS.md](KNOWN-DEFECTS.md) — D-7 records that
`MetaTemplateSend`'s `ON DELETE RESTRICT` foreign keys will start refusing
contact, campaign and subscriber deletions once send rows exist, and that no
`P2003` handling exists anywhere in the backend.

### HARD RULE — invoice and receipt numbering cannot be rolled back

> Once **any** invoice or receipt row exists, migration
> `20260921090000_invoice_reference_integrity` must not be reversed, and the
> `invoiceRef` and `receiptRef` rows in `OrgSequence` must never be reset,
> lowered, or deleted.
>
> Recovery past that point is **snapshot-restore or forward-fix. Never a
> rollback that touches the sequence.**

This is not a caution, it is a constraint on what recovery options exist.

Numbering used to be `count(rows) + 1`. It is now a high-water mark held in
`OrgSequence`, which only ever increases. Those two schemes disagree in exactly
one place, and it is the place that matters: after a document is removed or
voided, the count goes down and the high-water mark does not.

So reverting the code while resetting the counter — or restoring a database
snapshot taken before the counter advanced, while keeping documents issued
after it — lets the old scheme reissue a number that a real document already
carries. Two different amounts answering to one reference is not a display
bug; it is discovered by the customer being billed, and it is not detectable
from the row itself, because both rows look correct in isolation.

`down.sql` ships alongside the migration and was exercised (see below), but it
deliberately does not touch `OrgSequence`, and its header says plainly that it
is useless once real documents exist. It is a rehearsal artifact, not a
recovery plan.

**Rollback rehearsal, performed 2026-08-31 while both tables were empty.**
Applied the migration, ran `down.sql`, captured the schema, and diffed it
against the pre-migration capture — migration history, column definitions,
unique indexes and row counts were **identical**. Re-applied and diffed again
against the post-migration capture — also identical. `OrgSequence` was
unchanged throughout, which was the point of the exercise. A fresh verified
`pg_dump` was taken immediately before the first apply.

### Prisma has no down-migration — the procedure, written down before it is needed

Prisma Migrate is forward-only. There is no `migrate down`, no `migrate revert`
and no rollback command of any kind. Reversing a migration is a manual
procedure, and the part that surprises people is the last step: undoing the SQL
is not enough, because `_prisma_migrations` still holds a row saying the
migration is applied. Leave that row and `migrate status` reports a database
that is a schema ahead of what it actually is.

This is the procedure actually used during the invoice integrity rehearsal.
It is recorded here so the first person to attempt a rollback is reading it
beforehand rather than deriving it during an incident.

```bash
# 0. Snapshot first, always. This is the only step that is not reversible
#    by the steps that follow it.
docker exec rabitech-postgres-1 pg_dump -U admin -d rabitech -Fc -f /tmp/pre.dump
docker cp rabitech-postgres-1:/tmp/pre.dump ./pre.dump
docker exec rabitech-postgres-1 pg_restore -l /tmp/pre.dump   # verify it reads

# 1. Reverse the SQL. --single-transaction so a partial reversal cannot happen.
docker exec -i rabitech-postgres-1 psql -U admin -d rabitech \
  -v ON_ERROR_STOP=1 --single-transaction \
  < apps/backend/prisma/migrations/<migration_name>/down.sql

# 2. Remove the history row. Prisma will not do this, and without it the
#    database claims a schema it no longer has.
docker exec rabitech-postgres-1 psql -U admin -d rabitech -tAc \
  "delete from _prisma_migrations where migration_name='<migration_name>';"

# 3. Confirm. The migration should now read as pending again.
cd apps/backend && npx prisma migrate status
```

Re-applying is the same shape in reverse: pipe `migration.sql` through `psql`,
then record it with `npx prisma migrate resolve --applied <migration_name>`.

Two things this procedure does **not** do, both deliberate:

- **It does not use `prisma migrate deploy`.** Deploy applies every pending
  migration, so on this database it would also apply
  `20260920090000_meta_template_lifecycle` as a side effect. See D-6 in
  [KNOWN-DEFECTS.md](KNOWN-DEFECTS.md).
- **It does not touch `OrgSequence`.** See the hard rule above. Reversing
  schema is recoverable; lowering a document counter is not.

A `down.sql` is only meaningful if it was run at least once. One that has never
been executed is an assertion about the past, not a tested path.

### HARD RULE — the plan-code space cannot be closed again

> Once **any** `Plan.code` or `Organization.planOverride` holds a value outside
> `FREE`, `STANDARD`, `GROWTH`, `BUSINESS`, `ENTERPRISE`, migration
> `20260923090000_open_plan_code_space` must not be reversed.
>
> Recovery past that point is **snapshot-restore or forward-fix. Never a
> rollback that re-adds the constraint.**

This is not a caution, it is a constraint on what recovery options exist.

`down.sql` re-adds `Organization_planOverride_check`, and `ADD CONSTRAINT`
validates every existing row. One `planOverride` holding a sixth code makes it
fail — and fail **late**, after any code rollback has already happened, leaving
a system half-reverted.

The half that does not fail is worse. Nothing constrains `Plan.code`, so
catalogue rows carrying new codes survive the reversal intact and become
**unresolvable**: the restored closed union and membership test reject them, so
every subscriber on one resolves to the restricted floor and is entitled to
nothing, while the row still sits in the catalogue looking present. Losing the
rows would be more honest than that.

**Applying the migration is not the irreversible act. Creating the sixth
edition is.** Before anyone does:

1. E4 rehearsed and re-applied — done, see below.
2. E5 landed, with a create path that sets `sortOrder` explicitly. E2's
   `Object.keys(PLAN_ENTITLEMENTS).indexOf(code)` returns `-1` for a code the
   constant does not carry, which would sort a new edition ahead of Free.
3. `rowToEdition` no longer consulting `PLAN_ENTITLEMENTS` — done in E4.
4. The silent skip replaced by a loud failure — done in E4.
5. A fresh `pg_dump -Fc`, verified readable with `pg_restore -l`.

Check before running `down.sql`; it is one query and it is the difference
between a clean rollback and a half-reverted system:

```sql
SELECT DISTINCT "planOverride" FROM "Organization"
WHERE "planOverride" IS NOT NULL
  AND "planOverride" <> ALL (ARRAY['FREE','STANDARD','GROWTH','BUSINESS','ENTERPRISE']);
```

**Rehearsal, performed 2026-08-31 before any new code existed.** Applied, ran
`down.sql`, diffed the schema against the pre-migration capture — constraints,
migration history, plan codes, row counts and the `planOverride` values in use
were **identical** — then re-applied and diffed against the post-apply capture,
also identical. A verified `pg_dump` was taken immediately before.

**What that rehearsal does not prove, which matters more than what it does.**
It ran with only the original five codes present, which is the one condition
under which rollback works at all. It exercised the reversible case to build
confidence about a change whose risk lies entirely in the irreversible one. It
says nothing about whether a sixth edition resolves correctly, and nothing
about whether the floor is being silently reached. **Do not cite it as evidence
for either.**

Those two were verified separately, and directly: a well-formed unknown code
(`TESTSIX`) was inserted and confirmed to load and resolve to its own name and
price rather than the floor, and a malformed code (`bad-code`) was confirmed to
fail the entire refresh at `error` level, keeping the previous cache and
refusing to advance freshness. Both probe rows were removed afterwards.

Both gate numbers rose because two gates were found non-functional on this
machine and repaired — see the preconditions in §8. Neither number is
comparable to the one it replaces without that context: the harness gained
conversation-lifecycle, closure-reporting and edition coverage, and the browser
matrix gained `/settings/conversations` across all eighteen combinations.

Known local deployment warnings, not introduced by the current parity work:

- `ALLOW_INSECURE_SECRETS` permits weak local database and OpenWA credentials. Do not carry this into an internet-facing deployment.
- Mail uses the non-delivering `log` provider. Email flows are structurally implemented but real delivery is not enabled.

### RULE — reading `Plan`: offer questions filter, resolution questions do not

> Every read of `Plan` answers one of two questions. **What is on sale** filters
> on `isActive` *and* `archivedAt`. **What a subscriber already has** filters on
> neither.

Offer: `getEditions`, `listPlans`, `editionGranting`, and the upgrade target in
`channelRefusal`, which inherits the rule by reading `getEditions` rather than
the table. Resolution: `getEdition`, `sellableCurrencies`, and the
billing-summary plan-currency read — a subscriber on a withdrawn edition is
still entitled to it and still invoiced for it. The query that loads the cache
(`refreshEditions`) filters on neither and must not: the filter belongs on the
published set, never on the read that populates it.

Getting it backwards fails silently in both directions. Filtering a resolution
read drops a paying subscriber to the restricted floor or refuses their invoice;
not filtering an offer read advertises an edition nobody can buy. Settled
per-site in E5f-1 — this is the general form, so the next `Plan` query does not
have to rediscover it.

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

> **CORRECTED 2026-08-29, later the same day.** The certification below is kept
> as written, but one of its claims was false when written and the correction
> matters more than the record.
>
> **The edition cache never loaded.** `startEditionRefresh` runs on a timer,
> owned by no request, so it had no ambient tenant scope; the extension is
> fail-closed on a query with *no* scope at all and checks that before the
> `PLATFORM_MODELS` exemption. `refreshEditions` therefore threw on every tick
> from the moment the feature shipped, and every `getEdition` fell through to
> the `PLAN_ENTITLEMENTS` constant. The catalogue was owner-editable in the
> database and **inert in the running process**: the console wrote a price, the
> row held it, and nothing read it. This was live from the Phase 3 release until
> commit `bc66c468`.
>
> **The restart test proved persistence, not resolution.** It confirmed the row
> survived a restart — which was the `ensurePlans` property under test, and
> which is genuinely true. It never confirmed that anything *read* the row. Both
> halves were green and only one was verified.
>
> Three things concealed it, each a deliberate decision made for a good reason:
> the catch that keeps the previous cache on a failed refresh turned the throw
> into a log line; the constant fallback returned plausible values, so nothing
> misbehaved; and every harness check wrapped the call in `runAsPlatform`,
> testing a shape the timer never uses.
>
> **The lesson, stated generally: a test that passes through a fallback proves
> the fallback, not the feature.** When a feature has a fallback path, at least
> one test must assert the fallback is *not* what answered — here, by editing a
> value in the database and requiring the cache to return the edited value
> rather than merely a plausible one. A regression check doing exactly that
> landed in `ab62cf29`.

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

## 6c. Meta credential vault — migration 67 released 2026-08-30

A **schema-only** deploy, chosen deliberately because nothing can use the table
yet. That is the whole reason it was safe to ship on its own: there is no
behaviour to regress, and it stopped the vault accumulating a sixth pending gate
after riding along through five.

### What was verified, transcribed from command output

```
npm ci (backend + frontend)   clean; prisma / @prisma/client 5.22.0 unchanged
prisma format / generate      no schema drift; client knows MetaChannelCredential
isolation gate                119/119, exit 0, 52s   (run alone)
browser matrix                 75/75,  exit 0, 4.7m  (started after the harness returned)
backup                        auto-20260830-101506.dump, 1,150,640 bytes
                              restore-verified into a scratch database:
                              31 conversations / 97 messages / 33 contacts
docker compose build          backend + frontend, exit 0
migrate deploy                applied 20260919090000_meta_credential_vault
migrate status (container)    67 found, "Database schema is up to date!"
_prisma_migrations            67 applied; newest = the vault, 2026-08-30 10:31:58
MetaChannelCredential         exists, 16 columns, 0 rows
                              MetaChannelCredential_phoneNumberId_key present
counts after                  31 conversations / 97 messages / 33 contacts
/health                       database, redis, openwa, queue_depth all ok
frontend                      /login returns 200
logs                          no unhandled exceptions since restart
openwa                        Up 39 hours — never restarted
```

**The stale-image trap was live and was caught.** Before the rebuild the
container answered *"66 migrations found / Database schema is up to date!"* while
the host answered *"67 found, one pending"*. Trusting the container would have
made 67 look already-released. After `docker compose build backend frontend`
the container named 67 as pending, which is the only form of that check worth
anything.

### What this release gives

- The vault schema in production: `MetaChannelCredential`, with the globally
  unique `phoneNumberId` index that lets the database — not application
  vigilance — refuse two workspaces claiming one number.
- The **entire connect → webhook → ingest path** deployed: four-step credential
  validation, `X-Hub-Signature-256` verified over raw bytes, tenant resolution
  from `phone_number_id`, and inbound messages normalised into the existing
  pipeline with media downloaded at ingest.

### What this release does NOT give

**Meta is not usable.** Two independent gates stand between this schema and a
working channel, and both are deliberate:

1. **The vault hard gate is locked.** `secretProblems()` currently returns one
   problem — `OPENWA_API_KEY uses a known-weak value` — so
   `connectMetaChannel` refuses every credential with `META_VAULT_LOCKED`.
   The backend announces this on every boot. It does **not** honour
   `ALLOW_INSECURE_SECRETS`: that flag is permission to keep serving through a
   half-finished rotation, never permission to start storing other businesses'
   secrets. Rotating `OPENWA_API_KEY` is what opens it.
2. **The webhook fails closed.** `META_APP_SECRET` and
   `META_WEBHOOK_VERIFY_TOKEN` are unset, so every inbound delivery is rejected
   unsigned rather than trusted. An unsigned endpoint anyone can POST to is a way
   to inject messages into any tenant, which is why absence means refusal rather
   than a default.

So **releasing 67 and Meta becoming usable are two separate events.** This one
carried no behaviour change; the next one will.

### The four remaining Phase 4 items

1. **Meta template management, and the messaging-tier ceiling with it.** The
   largest piece. Outside the 24-hour window Meta accepts only approved
   templates, so until this exists a Meta workspace can reply and can never
   initiate — no broadcasts, no first contact, no next-day follow-up (§3.9 of
   docs/RABITECH-PRODUCT-VISION.md). The tier ceiling belongs in this same step
   and cannot usefully precede it: until templates exist no business-initiated
   conversation can start, so a counter would guard an unreachable state.
   This decides whether Growth, Business and Enterprise are sellable as
   described.
2. **`/settings/channels` completion.** Includes a real defect: **the channel
   switch is one-way.** The UI only ever calls
   `setActiveChannel('WHATSAPP_CLOUD')`; nothing calls it with `'OPENWA'`, so
   a workspace that moves to Meta cannot move back without a database edit. The
   backend supports both directions and the harness covers it — only the control
   is missing. Also outstanding: OpenWA has no capability display, and the page
   does not render the `409` capabilities state (mid-switch, or two active).
3. **Meta App Review.** External, gated on Meta's queue, and the long pole in
   calendar time rather than in work. Worth starting before it blocks anything.
4. **Never tested end-to-end against real Meta.** Every layer is unit- and
   harness-tested against stubs; no message has travelled from a real WhatsApp
   number into this inbox. That gap closes only with a real credential, which
   item 1 of the previous section currently forbids — so the sequence is:
   rotate the key, set the two secrets, connect one number, then test.

## 6d. Broadcast completion — measured 2026-08-31

Item 5 completed the tenant Broadcast surface for the existing OpenWA campaign
path. It adds a status rail, list/calendar views, URL-addressable delivery
analytics, result breakdowns, failure detail, and explicit loading, genuine-empty,
no-result, and retryable-error states. It does not add Meta business-initiated
sends; those remain blocked until the approved-template sending phase and tier
ceiling are shipped.

### Evidence

- Backend isolation harness: **`121/121`**, exit 0, run alone.
- Frontend `check:i18n`: pass.
- Frontend `check:mojibake`: pass.
- Frontend production build: pass; the build included `/campaigns/[id]`.
- Browser matrix: **`83/83`**, exit 0, run alone. The focused Broadcast checks
  cover scheduled list → calendar → URL detail and a failure → retry transition.
- Frontend Docker image: rebuilt and redeployed before the real-stack check.
  Backend, database, Redis, and OpenWA were not restarted.
- Real-stack visual check: read-only platform view-as access to the entitled
  `ostudio` workspace, with no mocked routes, at 375/768/1440 px in Arabic and
  English. All six combinations received `200` from `/api/campaigns`, with zero
  campaigns in the live workspace, and rendered the genuine empty state. The
  observed `/api/auth/me`, billing, notifications, templates, campaigns, and
  billing-summary requests were successful; overflow checks were clear.
  Screenshots are retained at `%TEMP%\\rabitech-broadcast-visual\\` with
  `campaigns-{ar|en}-{375|768|1440}-{list|calendar}.png` names. The mocked
  contract supplies the scheduled calendar and populated detail data that the
  live workspace does not contain.

This release is UI and test coverage only. No migration was applied, no backend
campaign behavior was changed, and the live OpenWA session was left untouched.

## 6e. Contacts merge and export — measured 2026-08-31

Item 6 completed the Contacts data-operations slice without a schema change.
The existing Contact model, composite tenant foreign keys, and role permissions
were sufficient. Merge suggestions are tenant-visible active contacts grouped
by a normalized non-empty name; the oldest record is the primary and later
records are offered as secondaries. The merge route moves conversations, tags,
and custom fields transactionally, archives the secondary, and requires an
explicit confirmation in the UI. A separate `contact:export` permission is
required for CSV export, which is capped at 20,000 rows, respects the current
filters and masking policy, and creates an audit record.

### Evidence

- Backend isolation and usage harness: **`122/122`**, exit 0, run alone. The
  new check passed same-name normalization and deterministic pairing, Agent
  permission denials, cross-tenant merge rejection, the composite database FK
  boundary, tenant-excluded CSV output, and `contact.exported`/
  `contact.merged` audit rows. Weakening the merge-suggestions permission was
  mutation-tested: the harness failed at `200 !== 403`; the guard was restored
  and the clean rerun returned `122/122`.
- Frontend `check:i18n`, `check:mojibake`, and production build: pass.
- Browser matrix: **`85/85`**, exit 0, run alone. The focused contacts checks
  cover merge suggestion review, irreversible confirmation, export visibility,
  and permission-hidden controls, in addition to the existing responsive
  contacts coverage.
- Backend and frontend images were rebuilt and only those two services were
  redeployed before the live check. Postgres, Redis, and OpenWA were not
  restarted.
- Real-stack visual check: read-only tenant-admin access at
  `http://localhost:18080/contacts`, with no mocked routes, returned `200` for
  `/api/contacts` and `/api/contacts/merge-suggestions`, rendered 24 live
  contact rows and one live merge suggestion, and exposed merge/export controls
  in Arabic and English at 375/768/1440 px. The loading skeleton, genuine empty
  state, and retryable error state remain distinct in
  `components/contacts/merge-suggestions.tsx`; no live merge or export action
  was clicked. Screenshots are retained in
  `%TEMP%\\rabitech-contacts-visual-admin\\contacts-{ar|en}-{375|768|1440}.png`.

This release added no migration, did not apply any migration, and left the
live OpenWA session untouched.

## 6f. Editions phase — closed 2026-09-01

### What moved, in plain language

Before this phase the product's commercial shape was a TypeScript constant. The
five editions, their prices and every limit they granted were compiled in, so
changing what a customer got for their money meant an edit, a review, a build
and a deploy.

It is now a database table the owner edits from `/platform/editions`, and four
things follow from that which did not before:

- **Prices and limits are owner-editable without a rebuild.** The catalogue is
  read from the database into a cache that refreshes on a timer; a change is
  live in the editing process at once and everywhere else within the refresh
  interval. Nobody has to restart anything.
- **A refusal now says which kind of refusal it is.** A capability an edition
  does not include answers "not included, upgrade to X" rather than "monthly
  limit reached, resets on the 1st" — a message that told a subscriber to wait
  for a reset that would never grant them anything. Capability and quota are
  different states needing different actions, and they are finally distinct.
- **An archived edition still resolves for the subscribers on it.** Retiring an
  edition removes it from the price list and from every upgrade prompt, and
  changes nothing at all for the people already paying for it. That property is
  the phase's central invariant and the thing most easily broken by accident:
  an edition dropped from the cache resolves to the restricted floor, which
  grants nothing while every response still returns 200.
- **The catalogue can be extended.** Editions can be created through an
  owner-only endpoint that is built, audited and exercised — and shipped
  closed. See below.

Also landed along the way: pricing has an explicit model (`FIXED`, `FREE`,
`NEGOTIATED`) so `ENTERPRISE` at zero cents is not mistaken for free; AI token
allowances became an edition lever rather than a per-deal-only field; and
`allowedChannels` and `autoProvisionGateway` became switches that grant
something instead of decoration.

### Rules this phase established

Stated once here so they are inherited rather than rediscovered.

1. **Offer versus resolution.** A read asking *what may we sell* filters on
   `isActive` and `archivedAt`. A read asking *what does this subscriber have*
   filters on neither. Getting it backwards fails silently in both directions.
   The long form is in §2 above.
2. **The constant and the rows change in the same commit.** `PLAN_ENTITLEMENTS`
   seeds and the harness asserts the two match field for field, so a migration
   that moves a row without moving the constant fails the gate — which is the
   point, not an inconvenience.
3. **A gate is green only when it was watched to run.** Not because it was green
   last time, not because an exit code was zero. Three separate defects (D-5,
   D-10, D-12) were gates reporting on their own environment rather than on the
   code, and all three were found by running them in a clean state rather than
   the state they happened to work in.

### What is deliberately not done

- **E6 — billing interval, effective dates, revision history.** There is one
  mutable row per edition and an `updatedAt`. **Editing a live edition today
  changes what existing subscribers get, with no record of what it granted
  before, when the change took effect, or who it applied to.** For most fields
  the change reaches them immediately; for the five metered usage limits it does
  not reach them at all until their next activation (D-14). Neither behaviour is
  written down anywhere a subscriber or an auditor could consult.
- **E7 — consequence preview.** Nothing tells an owner what an edit will do
  before they make it. Narrowing `allowedChannels` can disconnect a live
  channel; lowering a limit can put a subscriber instantly over quota. D-13 is
  the loudest instance, not the only one.
- **E8 — frontend dynamic lists, and the hardcoded `REQUIRES` map moved
  server-side.** The console still carries a compiled-in map of which capability
  needs which edition, which is the same defect this phase spent its length
  removing from the backend, one layer up.

Together E6 and E7 close the same gap from two ends: E6 makes what an edition
granted a matter of record, E7 makes what a change will cost visible before it
is made.

### The channel model, as shipped

| Edition | Channels |
|---|---|
| FREE | `OPENWA` + `WHATSAPP_CLOUD` |
| STANDARD | `OPENWA` + `WHATSAPP_CLOUD` |
| GROWTH | `WHATSAPP_CLOUD` |
| BUSINESS | `WHATSAPP_CLOUD` |
| ENTERPRISE | `WHATSAPP_CLOUD` |

**STANDARD is the tier for customers who do not have a Meta WhatsApp Business
Account**, and it is the only paid edition allowing OpenWA. Everything above it
is Meta-only, because those customers bring their own WABA and token. FREE
allows both so that a trial can start without a WABA.

E5d had widened every edition to both kinds on purpose, so that switching
enforcement on would not withdraw Meta from anyone who had it. Migration
`20260929090000_plan_channel_narrowing` is the other half, and its UPDATE is
guarded on the row still holding exactly the pair E5d shipped, so an owner who
has since edited an edition's channels from the console keeps that decision.

**What narrowing does not do, which is worth knowing before a real customer
meets it.** Enforcement lives at the connect paths only —
`POST /channels/meta/connect` and `POST /channels/active`. Nothing on the send
path reads `allowedChannels`. So an organization on a narrowed edition with an
already-ACTIVE OpenWA channel keeps sending: the row is untouched, the channel
is not disconnected, and no message is refused. What it loses is the ability to
select OPENWA again once it has switched away. **It is a one-way exit, not an
outage** — which is the first real evidence of what D-13's cliff does to someone
already connected, and materially gentler than "their number stops working."

Verified against `ostudio`, which is test data: still ENTERPRISE, still holding
`OPENWA` at status `ACTIVE`, still sending, and now unable to re-select it.

The narrowing also armed D-15: the refusal names the *cheapest* edition granting
a channel, which for OpenWA is FREE, so an ENTERPRISE customer is told to
"upgrade to Free." Correct refusal, absurd advice. Recorded, not fixed.

### The drift that nothing can report (D-14)

Worth stating here because it is the phase's sharpest remaining edge.
`applyPlanLimits` copies an edition's numbers into `OrganizationConfig` at
activation, and `effectiveLimits` reads those columns unless a live
`planOverride` exists. So the five metered usage limits are **a snapshot from
the subscriber's last activation, not the current catalogue**. Everything else
reaches them on the next cache refresh.

The asymmetry catches people because both halves read as limits on the same
screen:

| Live on refresh | Frozen until next activation |
|---|---|
| name, price, **seats** (`usersLimit`) | active contacts, outbound messages |
| flags, channels, campaign pacing | campaign sends, AI tokens in/out |

`detectQuotaDrift` sees this divergence and is *required to stay silent about
it*: an edition edit is treated as a new baseline rather than drift, because
otherwise raising one limit would report every organization on that edition as
drifted, and a detector that always fires is one nobody reads. Re-applying
limits on edit was considered and rejected as stomping per-subscriber overrides.
So the one thing that could report it must not, and there is no other signal.
E6 is what closes this.

### Evidence, measured 2026-09-01

- Backend isolation and usage harness: **`125/125`**, exit 0, run alone. Three
  checks added by this phase: archiving an edition without orphaning its
  subscribers, the ladder's ordering and tie-breaking, and the create path
  exercised against a closed code space — the last by deleting `STANDARD`,
  rebuilding it through the endpoint and restoring it, so the create body is
  genuinely executed rather than only refused.
- Platform finance ledger: **`17/17`**, exit 0, run in a shell with
  `DATABASE_URL` explicitly unset — which is the check that matters for D-12,
  because the same gate failed outright in that shell before the fix.
- Backend `tsc` + Prisma constructor lint: pass. Frontend `tsc --noEmit`,
  i18n completeness, mojibake, production build: pass.
- Container images rebuilt: `rabitech-backend` fresh, `rabitech-frontend` from
  cache (no frontend source changed in this phase).
- Playwright browser matrix: **not run — unavailable without
  `RABITECH_E2E_SESSION`.** Recorded as unavailable rather than green, because
  a gate nobody watched run is not evidence.
- Verified backups, both confirmed readable with `pg_restore -l` at 1056
  objects: `pre-e5-closeout-20260901-010036.dump`, and
  `pre-channel-narrowing-20260901-084806.dump` taken immediately before the
  only migration this closeout applied.

The harness first returned `124/125` on a check unrelated to editions, and the
cause is worth recording: the usage reconciliation fixture spanned `now − 23h`
while the metric it was compared against sums the calendar month in UTC, so on
the first of a month part of the fixture fell outside the window. It failed at
71.4% against a 1% tolerance on code that had passed five consecutive runs the
day before. Fixed and recorded as D-16 — the fourth instance of the pattern this
phase named, and the cleanest specimen of it.

### HARD RULE — edition history is not reconstructible

> Once an edition's terms have changed, the previous terms exist **only** in the
> `PlatformAuditLog` revision record. The `Plan` row holds the current values and
> nothing else; `updatedAt` says a change happened and never what it was.
>
> **The point of no return is the first change anybody relies on reading back.**
> Before that, the audit rows are a convenience. After it, they are the record —
> and there is no second copy to rebuild them from.

Recovery past that point is snapshot-restore or forward-fix, never a rollback
that discards the trail. The two E6 migrations are reversible *because neither
touches applied history*:

- `20261001090000_plan_billing_interval` — `down.sql` drops `billingInterval`.
  Every yearly edition silently becomes monthly: the price stays the same number
  and starts being charged twelve times as often. **Check first:**
  `SELECT code, "monthlyPriceCents", "billingInterval" FROM "Plan" WHERE "billingInterval" <> 'MONTHLY';`
- `20261002090000_plan_scheduled_changes` — `down.sql` drops the two schedule
  columns, **discarding every pending change silently**. A price rise dated to
  next month simply never happens and the edition still looks correct. **Check
  first:** `SELECT code, "scheduledFrom", "scheduledChanges" FROM "Plan" WHERE "scheduledFrom" IS NOT NULL;`
  Each row is a decision somebody made about a future date.

### What "in force" means, and who a change reaches

Written here because it is the single most surprising thing about the
catalogue, and effective dating does not change it — it changes *when* the
catalogue moves, not *who* the move reaches.

| Reaches existing subscribers at the next cache refresh | Does not reach them until their next activation |
|---|---|
| name, price, seats (`usersLimit`) | `monthlyActiveContactsLimit` |
| `allowedChannels`, `autoProvisionGateway` | `monthlyOutboundMessagesLimit` |
| `customDomain`, `whiteLabel`, `maskContactDetails` | `monthlyCampaignSendsLimit` |
| campaign pacing, `pricingModel`, `billingInterval` | `monthlyAiTokensInLimit`, `monthlyAiTokensOutLimit` |

The right-hand column is D-14: `applyPlanLimits` copied those five values into
`OrganizationConfig` at activation, and enforcement reads that copy rather than
the plan. Raising GROWTH's contact allowance changes nothing for anyone already
on GROWTH. Seats being live while quotas are frozen is the asymmetry most likely
to catch someone out, because both read as limits on the same screen.

A scheduled change lands up to one refresh interval (30s) after its time,
because `refreshEditions` resolves what is in force rather than `getEdition()`
doing it per call — that accessor is synchronous and nineteen call sites depend
on it, two of them on the send path.

### The door is still closed

`CREATABLE_PLAN_CODES` in `platform.routes.ts` holds exactly the original five
codes, so every create refuses today. The create path is complete and exercised
against a real create — the harness deletes `STANDARD`, rebuilds it through the
endpoint and restores it — so widening the set is not shipping untested code.

**Before it is opened, all of these must be true:**

1. A fresh `pg_dump -Fc`, verified readable with `pg_restore -l`. Recovery past
   the first sixth edition is snapshot-restore or forward-fix; there is no
   rollback, because `down.sql` re-adds a CHECK constraint that a sixth code
   makes fail late, leaving a half-reverted system.
2. The HARD RULE in §2 read and understood, not merely present in the file.
3. `sortOrder` set deliberately for the new edition — the create appends past
   the ladder, which is safe but is rarely where a new edition belongs.
4. A decision on D-9: `FREE` is still reserved, so the free tier cannot become
   an ordinary catalogue row until `isPaidPlan` no longer needs the name during
   the boot window.
5. E7, or an accepted equivalent. A sixth edition is the first catalogue change
   whose consequences nobody can preview, and it is the least reversible one.
6. **A price for it at the payment provider.** Since the Stripe adapter landed,
   an edition is sellable only if `STRIPE_PRICE_<CODE>` names a price id, and
   those ids are per-environment so they cannot live in the repository. A sixth
   edition created from the console today would appear on the pricing page and
   **refuse at checkout** — `createCheckout` throws rather than charging against
   another edition's price, which is the correct failure and still a broken
   purchase. This is the point at which the environment map has to become a
   column on `Plan` that the console can set, and it is the most concrete
   operational reason the door being closed is currently load-bearing rather
   than merely cautious.

**Applying E4's migration was never the one-way door. Creating the sixth edition
is.**

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

> **SUPERSEDED 2026-08-30.** The numbered resume list below was written before
> Conversation Operations and the two following release records were completed.
> It is retained as evidence of the old resume point, not as current
> instruction. Verified on 2026-08-30: `docker compose exec -T backend npx
> prisma migrate status` reports **67 migrations found** and
> `Database schema is up to date!`; `_prisma_migrations` has **67** finished
> rows, newest `20260919090000_meta_credential_vault` at
> `2026-08-30 10:31:58.901589+00`. The current rule is: read this checkpoint,
> run `git status --short`, confirm `/health`, confirm no pending migration
> before creating a new one, and use the full gated release sequence for any
> migration.

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

> **SUPERSEDED 2026-08-30, lesson retained.** The specific "next session"
> warning above was true before migrations 64-67 were released. It is no longer
> the current state: the live database and backend container both report **67**
> migrations and no pending migration. The stale-image rule remains current:
> rebuild images before trusting container route status or container Prisma
> migration status, and before deploying require the rebuilt image to name the
> intended migration as pending.

**Fifth stale-image occurrence — platform console visual certification,
2026-08-31.** Item 1's source was correct: `app/platform/page.tsx` contained
the `/platform/editions` link, and its platform pages had the visible error and
genuine-empty states. The running frontend image was older, however. A real
platform-owner Playwright check against `localhost:18080` found zero Editions
links at 375, 768, and 1440 px in both Arabic and English, while the real
backend returned `200` for the subscriber and billing requests and the Editions
page returned all five database editions. Rebuilding only the frontend and
bringing only that service up made the same six checks find exactly one visible
Editions link each. Source-correct was not deployed-correct.

**Sharpened visual-certification rule, 2026-08-31.** Any item that changes a
route, link, or page must rebuild the frontend image before its real-app visual
check can count. Then bring the rebuilt frontend up and verify the changed
surface against the running backend. A source diff, a TypeScript build, or a
mocked browser matrix cannot certify a stale container; if the live result
disagrees, report the deployment finding before counting the item green.

**Unapplied-migration hazard, 2026-08-31.** When a migration is written but
unapplied, the generated Prisma client is ahead of the database. Any query that
selects a column added by that migration can fail at runtime with `P2022`.
This is the opposite direction of the stale-image trap: a stale image carries
an older client behind the migrations on disk, while this state has a current
client ahead of the live schema. Rebuilding an image does not apply a migration.
Before certifying or using a new-column path against the live stack, rebuild
the relevant image, confirm the intended migration is named as pending, and
follow the gated release sequence before deployment. Item 14 will add more
unapplied migrations, so this check is required again there.

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
the process is still on the process list. **Both routes are now closed.** The first was the Redis handle, closed at the
end of a completed run. The second surfaced on 2026-08-29 on the *early-failure*
path — `waitForBackend` throwing before the backend ever answers — and it is a
timing bug in the cleanup itself, not a second kind of leak.

`databaseAudits` closed each queue only `if (require.cache[...])`, i.e. only
those already loaded when its `finally` ran. On the early-failure path
`auto-close.queue` and `gateway-provisioning.queue` were **not yet loaded**, so
both were skipped. `workerAudits` then ran and required
`incoming-message.worker`, which transitively loads both — opening two Redis
connections *after* the only sweep that would have closed them. That is why the
failure was path-dependent: on a successful run those modules are already in
`require.cache` when the sweep runs, so they get closed.

The fix is one idempotent `closeLoadedQueues()` called again **after**
`workerAudits`. Measured A/B against the pre-fix script, both forced to fail at
`waitForBackend`: before, the run printed its summary and never exited (killed
at 90s); after, it exits **38ms** after the summary line.

**Two things this cost, worth remembering.** The surviving harness went on
holding `query_engine-windows.dll.node`, and the next `npx prisma generate` in
an unrelated task failed with `EPERM` — nothing in that error pointed back to a
harness run an hour earlier. *A leaked gate process breaks tooling that has
nothing to do with the gate.* And the first diagnosis of this bug was wrong: it
blamed the spawned child missing an emulated `SIGTERM`, which was plausible,
mechanical, and false. What settled it was dumping
`process.getActiveResourcesInfo()` at the end of `main()` and finding two
sockets to `::1:6379` that appeared *two seconds after* cleanup had finished.
*Name the handle before naming the cause.*

There is now also a net under whatever the third leak turns out to be: `main()`
ends with an unref'd 5s `drainGuard` calling `process.exit(process.exitCode)`.
Unref'd, so an empty event loop still exits naturally and nothing is truncated
on the normal path — confirmed by that 38ms, which shows the guard is not what
is ending the process. A gate may fail; it may not hang.

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

**Two known defects on the OpenWA inbound path — found 2026-08-30, not fixed.**
Both were found while wiring the Meta inbound path, both are pre-existing, and
neither is blocking. Recorded here so they are visible rather than rediscovered
as a surprise.

> **PARTIALLY SUPERSEDED 2026-08-30.** Defect 1 below remains open. Defect 2 is
> fixed for both inbound channels and its original text is retained as the
> pre-fix diagnosis.

1. **Stored Arabic sentinels in `Message.body`.**
   `workers/incoming-message.worker.ts:136` writes `[صورة]`, `[فيديو]`,
   `[رسالة صوتية]` or `[ملف]` into the body of an uncaptioned media message.
   That is the same stored-language defect the Meta placeholder ruling exists to
   avoid: **an English- or Hebrew-locale workspace sees Arabic**, and no
   translation can fix it afterwards because the language is baked into the row
   rather than derived at render time. The Meta path deliberately does not do
   this — it stores the type in `mediaType` and lets the existing
   `MEDIA_LABELS` map render the copy through `t()`, which is machinery that
   already existed. The fix for OpenWA is the same shape and small: stop writing
   the sentinel, let `MessageMedia` render from the type it already receives.
   The awkward part is existing rows, which keep their stored Arabic unless
   backfilled — so this needs a decision about history, not just a code change.

2. **`mediaFileName` is never populated.** The inbound worker accepts
   `mediaUrl` and `mediaType` and writes both, but nothing sets
   `mediaFileName` on either channel, so a customer sending `invoice-2026.pdf`
   produces a document the agent sees as an untitled file. The column exists and
   the UI already reads it. Meta supplies the name in
   `document.filename` and the normaliser already carries it as `fileName`;
   it stops at `queueIncomingMessage`, whose payload type has no field for it.
   Fixing it means widening that payload and the worker's create — small, and
   touching a path both channels share, which is why it was not folded into the
   Meta work.

   > **SUPERSEDED 2026-08-30.** OpenWA now extracts the live gateway contract's
   > `media.filename`; Meta carries `document.filename` through download; the
   > shared queue persists both to `Message.mediaFileName`. The isolation
   > harness is `120/120`. Mutation proof: forcing the worker write back to
   > `null` produced `119/120`, with only `audit: inbound media filenames reach
   > Message.mediaFileName on OpenWA and Meta` failing.

**Mutation-test every check that guards a boundary — standing practice from
2026-08-30.** A check that has never been seen to fail proves only that it runs.
Before a check guarding a tenancy or policy boundary is trusted, revert the fix
it guards, watch it go red, and restore — and keep the failure message it
produced, because that message is what the next person will have to diagnose
from.

This is not a theoretical discipline. It caught two distinct failure modes in
one phase, and they are different from each other:

- **A check that could not fail.** The Meta webhook routing check was written,
  passed, and would have passed just as happily against a resolver that guessed.
  Adding the forbidden `findFirst` fallback made it fail with "an unrecognised
  phone_number_id entered a tenant scope" — which is the only reason it is known
  to test anything.
- **A check passing through the wrong path.** The service-window check reused a
  seeded fixture contact that already carries an INBOUND message, so the window
  it observed was held open by seed data rather than by the code under test. It
  now builds its own contact and thread.

Both are the same class as the edition-cache incident in §6b, where a green
restart test proved persistence while the value was never read. **A test that
passes through a fallback, a default, or someone else's fixture proves the
fallback.** Mutation is what tells the difference, and it costs one extra run.

**Do not add exceptions to a mechanical gate.** The capability gate — no
frontend file may compare a channel kind, because behaviour must be read from
the capability descriptor — caught a violation on its very first execution: a
*comment* in `meta-channel-card.tsx` that quoted the pattern it was warning
against. The comment was reworded rather than the gate taught to skip comments.
An exception is where the next violation hides, and the cost of having none is
rewording a sentence.

**Accepted behaviour change, not a regression — 2026-08-30.** Phase 4.5 made
channel resolution deterministic, so an organization holding channels with none
ACTIVE now raises a named `CHANNEL_NOT_ACTIVE` with an Arabic message instead
of falling through to OpenWA. One organization on the live database is in that
state: the one named `test`, with `status=PENDING` and
`provisioningState=PENDING` — a half-provisioned subscriber that has never been
able to send. It failed before this change too, reaching
`OpenWAService.getProvider` and throwing the internal English "Active OpenWA
channel is not configured for organization". The change replaces an internal
error with a named, actionable, Arabic one for an org that could not send under
either. Recorded here so a later reader does not rediscover it and mistake an
improvement for a regression.

**The GitHub Actions gate is red, and has never been green — 2026-08-30.**
`.github/workflows/tenancy-bleed.yml` has run 43 times since 2026-08-20 with
**zero successes** (41 failures, 2 cancelled). It was already failing on run 1,
three days before any of the harness work in this checkpoint, so nothing here
caused it and no local change is going to fix it by itself.

> **SUPERSEDED 2026-08-30 — first successful CI run.** Commit `a77c63c9`
> supplied the missing CI-only `CHANNEL_ENCRYPTION_KEY`. GitHub Actions run
> `33322278068`, triggered by that commit, completed with `conclusion: success`
> at 2026-08-30 16:23:32Z. The 43-run record above remains the historical state
> before the fix. Together with the bounded, cleanly exiting isolation harness
> and the installed, exercised Playwright browser matrix recorded above, all
> three release gates are now genuinely executable for the first time in this
> project's history.

*Confirmed cause.* The workflow's `env:` block supplies four variables;
this project's environment defines twenty-three. **`CHANNEL_ENCRYPTION_KEY` is
among the missing**, and running the harness locally under CI's exact
environment reproduces five failures, every one of them
`CHANNEL_ENCRYPTION_KEY must be at least 32 characters` — the four
`provisioning:` checks and the TOTP encryption check. That is a sufficient
cause for a red gate on its own, and the fix is one line of workflow `env:`
holding a CI-only dummy of at least 32 characters.

**Settled 2026-08-30 from the job log: the missing key is the whole cause.**
The log shows `[PASS] database: apply migrations to disposable schema` and all
112 checks running to completion. The run was not truncated — it was simply
fast, on a runner with no other load. `CHANNEL_ENCRYPTION_KEY` produces five
failures and there is nothing else.

**The early-return hypothesis is disproved.** It had been reasoned from the
19-second duration and the `if (!migrated) return` after `prisma migrate
deploy`, which would indeed skip the whole database suite — but the log shows
that step passing, so the mechanism never fired. Recorded as disproved rather
than deleted, so it is not re-derived from the same timing evidence by the next
person who notices 19 seconds and finds the same early return. **A duration is
not a measurement of what ran.**

Two related things were also ruled out along the way and are worth not
re-investigating. The harness reading its environment from the repository root
`.env` cannot break CI: `dotenv` is strictly additive, tested against a
controlled file — an already-set `DATABASE_URL` survived the load while an
absent variable was filled in — and a missing file returns `{ error: ENOENT }`
rather than throwing. And `@prisma/client` **does** generate on a clean
install here: `npm ci` on 2026-08-30 produced a client that knows
`MetaChannelCredential`, so "the client was never generated" is not the
explanation either.

**The fix is one line of workflow `env:`** holding a CI-only dummy of at least
32 characters.

*Explicitly not the cause:* the harness loading its environment from the
repository root `.env`. `dotenv` is strictly additive — tested against a
controlled file, an already-set `DATABASE_URL` survived the load while a
variable absent from the environment was filled in — and a missing file returns
`{ error: ENOENT }` rather than throwing. CI's own `env:` therefore wins, which
is exactly the behaviour wanted in both environments. The repoint also landed 25
commits before the run in question.

**This is not blocking.** All three local gates are green and, unlike this one,
genuinely executable here: isolation 112/112, browser matrix 75/75, six core
checks. A gate nobody can run is not evidence of anything, in either direction —
which is the same rule as above, applied to a gate that has never once been
watched succeeding.

**A Meta channel can reply, and can never initiate — recorded 2026-08-30.**
Meta allows free-form messages only within 24 hours of the customer's last
message; outside it, only pre-approved templates, which this product does not
manage. So a workspace sending through Meta can answer within 24 hours and
cannot start a conversation: no broadcasts, no first contact, no next-day
follow-up. The send path refuses these locally with an Arabic message rather
than relaying them to Meta, because rejected sends depress the number's quality
rating and therefore its messaging tier — spending the customer's own standing
to learn something already known.

This is material to Growth, Business and Enterprise, which are the Meta-capable
editions, so it is a launch conversation rather than a later support ticket. See
§3.9 of docs/RABITECH-PRODUCT-VISION.md. It closes with Meta template
management, and the messaging-tier ceiling (250 recipients per rolling 24 hours
unverified) becomes enforceable in that same step and not before — until
templates exist no business-initiated conversation can start, so a counter would
guard a state that cannot be reached.

> **SUPERSEDED 2026-08-30.** The `ingestChange` note below is stale. Verified
> against code before this correction: `src/webhooks/meta.webhook.ts` now uses
> `ingestChange` as the default `dispatchMetaWebhookPayload` handler; it calls
> the pure `normalizeMetaMessages` / `normalizeMetaStatuses` normaliser in
> `src/modules/channels/meta-inbound.ts`, downloads Meta media at ingest through
> `downloadMetaMedia`, queues inbound messages into
> `workers/incoming-message.worker.ts`, and applies monotonic delivery acks via
> `applyMetaStatus`. The existing worker then upserts the contact, opens or
> reuses the one-thread-per-contact conversation, creates the message, meters
> it, and emits through the existing pipeline. The harness contains the three
> added checks that brought the Meta ingest coverage to 119: tenant-scoped acks,
> redelivery uniqueness, and normaliser/status/placeholder behaviour, plus the
> webhook tenant-routing/signature boundary check. Remaining caveat verified in
> code: the shared inbound queue still carries `mediaUrl` and `mediaType`, but
> not `mediaFileName`, so document filenames are not persisted by this path yet.

**Next scoped step: wire `ingestChange`.** The Meta inbound webhook is complete
up to the point of ingestion — signature verified over the raw bytes, tenant
resolved from `phone_number_id`, scope entered, unknown ids dropped — and
`ingestChange` in `src/webhooks/meta.webhook.ts` currently resolves, logs and
returns. It creates no contacts, conversations or messages. The reason it stops
there is that the Cloud API payload is a different shape from OpenWA's, so
normalising it into this product's inbox — contacts, one-thread-per-contact
sessions, delivery acks, media — is its own piece of work rather than a few
lines at the end of a webhook. Everything outside that function is the part that
cannot be corrected later without consequence, which is why it was finished
first. Until it is wired, **a connected Meta number sends nothing and receives
nothing into the inbox**, and `/settings/channels` says so on the card rather
than leaving it to be discovered.

**Run the isolation gate and the browser matrix serially. Never concurrently.**
They contend for the same machine and the loser reports a false failure. The
harness starts a real backend and waits a bounded budget for it to answer on
`/health`; Playwright runs Chromium workers in parallel and will happily take
every core. When both run at once, `waitForBackend` spends its budget queued
behind browser processes and times out — and the harness reports that as a
failed isolation check, which reads exactly like a real tenancy bleed.

This has now produced two phantom failures on this machine, both after the rule
was already known. The second cost a full diagnostic pass on a check that was
never broken. **A gate that fails because of contention is indistinguishable
from a gate that fails because the code is wrong** — so the sequencing is part
of the gate, not an optimisation. Run the harness, read its summary line, then
run the matrix.

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
