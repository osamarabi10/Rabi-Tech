# RabiTech — Multi-Tenant Architecture & Sequencing

> Status: accepted architecture; Phase 0 is substantially implemented and Phase 1 is in progress.
> Scope: the authoritative target architecture, implementation sequence, and release gates for RabiTech.
> Last reality check: 2026-08-19. This document describes both the current repository and the work still required; a checked item is not evidence that the whole phase is complete.

## Summary

RabiTech is the platform owner and product brand. The codebase is a working WhatsApp support/marketing inbox: ~5,100 LOC backend (Express + Prisma + Socket.io + BullMQ), 20 Prisma models, ~245 Prisma call sites, and a Next.js 14 RTL Arabic frontend. This architecture turns it into a multi-tenant SaaS sold to subscriber organizations.

### Naming boundary

- Use **RabiTech** for the product, platform UI, services, packages, databases, deployment resources, logs, and documentation.
- Tenant-specific branding must eventually come from organization configuration rather than hard-coded product names.

### Business and authority model

RabiTech is not a tenant. It is the platform control plane above all subscribers.

| Actor | Stored as | Authority |
|---|---|---|
| RabiTech owner | `Identity.platformRole = OWNER` | Creates, suspends, and inspects subscriber organizations. Never enters tenant scope accidentally. |
| RabiTech support | `Identity.platformRole = SUPPORT` | Operational support with explicitly granted platform actions; cannot create platform owners. |
| Subscriber | `Organization` | Isolation, billing, branding, users, contacts, conversations, and WhatsApp ownership boundary. |
| Subscriber admin | `User.role = ADMIN` membership in one organization | Connects WhatsApp by QR and creates, updates, or disables workers in that organization. |
| Subscriber worker | `User.role = SUPERVISOR|AGENT|VIEWER|FINANCE` | Works only inside the subscriber organization and cannot provision channels or users. |

An `Identity` is the global login credential. A `User` is that identity's membership and role inside one subscriber organization. Platform authority and subscriber authority are separate JWT scopes and must never be inferred from each other.

### Required subscriber onboarding flow

1. A RabiTech owner signs in to the platform control plane.
2. RabiTech creates a subscriber with organization name, slug, and first subscriber-admin credentials.
3. Provisioning creates the `Organization`, admin `Identity` + `User` membership, and a namespaced WhatsApp session in one transaction.
4. The subscriber admin signs in and opens WhatsApp setup.
5. The backend verifies `ADMIN` membership and session ownership, starts the subscriber's provider session, and returns its QR code.
6. The subscriber scans the QR from WhatsApp's linked-devices screen. Connection status moves the organization from onboarding to operational.
7. The subscriber admin creates worker identities and assigns organization roles/departments.

No worker can request a QR, manage another subscriber, or create users. No platform endpoint may execute in organization scope, and no subscriber endpoint may execute in platform scope.

### Implementation checkpoint — 2026-08-19

- [x] Separate `PLATFORM` and `ORGANIZATION` JWT scopes.
- [x] RabiTech owner bootstrap and platform login.
- [x] Platform subscriber list, creation, activation, and suspension API.
- [x] Subscriber provisioning transaction creates organization, first admin, and namespaced WhatsApp session.
- [x] RabiTech owner console at `/platform/subscribers`.
- [x] Subscriber-admin-only worker creation, updates, and deactivation.
- [x] Subscriber-admin-only WhatsApp QR access; worker requests return `403`.
- [x] Clean migration chain, real-data clone migration, and production database migration.
- [x] Fail-closed `AsyncLocalStorage` tenant scope and Prisma `$extends` filtering for HTTP requests and workers.
- [x] Tenant columns, additive backfill, `NOT NULL`, and the first set of compound uniqueness constraints.
- [x] Organization-namespaced BullMQ job IDs for inbound and escalation jobs.
- [x] Signed/authenticated media access, organization-token webhook attribution, and JWT revocation through `tokenVersion`.
- [x] Add composite parent-child foreign keys so a child row cannot reference a parent from another organization.
- [x] Replace the process-wide OpenWA client/cache with an organization-owned provider deployment and credential lookup before adding subscriber #2 to live messaging.
- [x] Namespace every socket room with organization ID.
- [x] Make `WorkingHours`, keyword caches, and display sequences organization-scoped.
- [x] Add the tenant isolation and usage harness. After P3 the gate is green at `30/30`; see `docs/TENANCY-BLEED-HARNESS.md`.
- [x] Add append-only usage events, exact monthly active contacts, idempotent daily rollups, and outbound quota enforcement; see `docs/P3-USAGE-METERING.md`.

### Current release boundary

The code-level subscriber-isolation gate is green. A second subscriber may connect only after its
dedicated OpenWA deployment exists and its `OrganizationChannel` is activated; a `PENDING` channel
cannot send, pair, or receive callbacks. This operational provisioning step is intentionally outside
the application rather than an in-app container orchestrator. The resumable host-side provisioning
service remains open and blocks self-serve billing/signup.

P3 metering is complete. P6 billing therefore remains blocked only by the resumable automatic
OpenWA provisioning state machine, not by usage measurement or quota enforcement.

Three conclusions from reading the code:

1. **The work is ~28–38 dev-weeks, not 12.** 12 weeks gets you through hardening, tenancy, and branding — which is the right target, because that is already a sellable product.
2. **The phase ordering is wrong in four places**, each for a concrete reason in this codebase, not a general principle. See §1.
3. **The chosen isolation model (`organization_id` + Prisma `$extends`) is not sufficient on its own.** It needs composite foreign keys behind it. See §0. This is the most important recommendation in this document.

### Decisions taken as given

| Decision | Choice |
|---|---|
| Tenant isolation | Shared database, `organization_id` column, Prisma `$extends` extension. Not RLS, not schema-per-tenant. |
| WhatsApp isolation | One organization-owned OpenWA deployment per subscriber, with its base URL and encrypted API key stored as organization channel configuration. The current shared `OPENWA_URL` client is transitional and must not carry subscriber #2 live traffic. Every QR/status/send operation resolves and authorizes organization ownership first. |
| Existing data | Safe additive migration: add nullable column → backfill into a bootstrap subscriber organization → enforce `NOT NULL`. |

---

## §0 — The decision that isn't in the roadmap: composite foreign keys

**Implementation status:** not complete. Tenant columns and several compound unique constraints exist, but relations such as `Message → Conversation`, `Conversation → Contact`, and `TicketNote → Ticket` still use single-column parent IDs. Phase 1 remains gated until those relations include `organizationId` on both sides.

A Prisma `$extends` query extension only sees **top-level** `args`. Two consequences:

- It cannot see **nested writes**. `conversation.create({ data: { messages: { create: [...] } } })` produces Message rows the extension never touches.
- Unique operations still require care. Current Prisma versions allow an additional non-unique `organizationId` predicate beside a unique selector, and the implemented extension injects it. Compound unique selectors remain necessary where uniqueness itself is tenant-local, such as phone numbers, session names, short codes, and WhatsApp message IDs.

So `$extends` is a **convenience layer, not an isolation boundary**. With ~245 call sites — ~80 of them in workers and utilities with no request context — "we think we caught them all" is not a security posture.

**Recommendation: put the boundary in the schema.** Every tenant-scoped child table carries `organizationId`, and its foreign key to its parent is declared over `(parentId, organizationId)` against a matching `@@unique([id, organizationId])` on the parent.

```prisma
model Conversation {
  id             String @id @default(cuid())
  organizationId String
  @@unique([id, organizationId])   // enables the composite FK below
}

model Message {
  conversationId String
  organizationId String
  conversation   Conversation @relation(
    fields:     [conversationId, organizationId],
    references: [id,             organizationId]
  )
}
```

A message written with tenant A's `organizationId` pointing at tenant B's conversation is now a **foreign key violation at the database** — a loud 500 in staging, rather than a quiet cross-customer data leak in production.

**Cost:** one extra column on child tables, and care during the backfill migration (the parent's composite unique must exist and be populated before the child FK is added). **Take it.** Since RLS was explicitly declined, this is the only defense-in-depth on the table.

---

## §1 — Corrected phase sequencing

The original roadmap order was: multi-tenancy → channels → workflow builder → AI agents → billing
→ branding → analytics. AI is now deferred by product decision; the active sequence skips P5.

### 1. Branding is 6th. It should be 1.5.

Branding is the **cheapest phase in the roadmap** and it was sequenced near-last. `apps/frontend/tailwind.config.ts` and `app/globals.css` already drive every semantic color through HSL CSS variables — the architecture is ~80% there. What remains is roughly fifteen hardcoded violet literals (in `boxShadow`, `backgroundImage`, and four spots in `globals.css`), the logo in `components/app-sidebar.tsx` and the login page, and one React context mounted alongside the existing `lib/i18n.tsx` in `components/providers.tsx`.

That is days of work, and it is *the entire product proposition*. A white-label SaaS you cannot rebrand does not demo. Ship it immediately after tenancy so there is something sellable while the deep phases run.

### 2. "Channels" is 2nd, but half of it is a Phase 1 prerequisite.

Supporting organization-owned WhatsApp connections makes the current singleton design unsafe the moment subscriber #2 exists. `src/modules/whatsapp/openwa.service.ts:3` builds its axios client at **import time** from `OPENWA_URL` and `OPENWA_API_KEY`:

```ts
const client = axios.create({
  baseURL: process.env.OPENWA_URL || 'http://localhost:3000',
  headers: { 'X-API-Key': process.env.OPENWA_API_KEY || '' },
});
```

One base URL, one key, resolved once per process. The singleton→factory refactor belongs **inside Phase 1**, not Phase 2. What genuinely belongs in Phase 2 is only the *second* channel: the provider interface, address normalization, and pulling `@c.us` / `@g.us` / `@lid` out of `webhooks/openwa.webhook.ts`, `utils/phone.ts`, and `utils/group-id.ts`. Split the phase.

### 3. Analytics is last. Per-tenant analytics belongs in Phase 1.

`src/modules/analytics/analytics.routes.ts` and `src/modules/system/system.routes.ts` hold roughly fifteen `count` / `groupBy` / `aggregate` calls. These are the **highest-probability silent-leak sites in the codebase**: a leaked `count()` does not throw or log — it returns a number that is merely too large, and nobody notices until a customer asks why they have 4,000 contacts.

Analytics is not a later feature. It is the **acceptance test for Phase 1**. What genuinely belongs at the end is *platform* analytics (deliberately cross-tenant, super-admin) — a different thing entirely.

### 4. Billing was placed after AI agents. Metering must come first.

AI agents burn metered tokens. Shipping agents before you can meter and cap them makes your first enthusiastic tenant an uncapped cost-of-goods liability. Split billing in two: **metering + quota enforcement** moves before agents; **Stripe, plans, and invoicing** can stay late.

### A note on the workflow builder

Sequencing the workflow builder before AI agents is correct — an agent is best modeled as one node type in the engine, not a parallel system. But be aware that `src/utils/conversation-session.ts` and `src/utils/menu.ts` **already are** a hand-rolled workflow engine: menu state, awaiting-client, escalation timers. The new engine's first job is to swallow that logic. If it cannot express the existing Arabic menu flow, it is the wrong engine — and that must be discovered in week 1 of the phase, not week 4.

**Product decision, 2026-08-19:** AI agents are deferred until explicitly resumed. The workflow
phase excludes the AI node and AI palette; current implementation proceeds through billing and
platform analytics without P5. Reserved token metrics remain dormant and do not imply scheduled AI
work.

### Recommended order

| # | Phase | Why here |
|---|---|---|
| **0** | Security hardening | Latent bugs today; breaches the day org #2 exists. Non-negotiable gate. |
| **1** | Tenancy core (incl. platform owner, subscriber provisioning, WhatsApp ownership + analytics correctness) | Everything below assumes an `organizationId`. |
| **1.5** | Branding / white-label | Cheap, high visibility, unblocks sales. |
| **2** | Channel abstraction (2nd channel) | Builds on the Phase 1 client factory. |
| **3** | Usage metering + quotas | Provides cost controls for every metered capability. |
| **4** | Workflow builder | Needs tenancy + channels (nodes send via channels). |
| **6** | Billing / invoicing / self-serve | Consumes the Phase 3 counters. |
| **7** | Platform analytics + support operations | Deliberately cross-tenant — build only once isolation is trusted. The minimal owner control plane ships in Phase 1. |
| **Deferred** | AI agents | Excluded until the product owner explicitly resumes P5. |

---

## §2 — The tenant context mechanism

**Implementation status:** the fail-closed store, Prisma extension, organization/platform wrappers, HTTP entry point, and worker wrappers exist in `apps/backend/src/lib/tenant-context.ts`, `apps/backend/src/prisma/extensions.ts`, `apps/backend/src/index.ts`, and `apps/backend/src/workers/`. The remaining work in this section is defense-in-depth, socket/webhook completion, per-org configuration, and automated isolation proof.

### Recommendation: AsyncLocalStorage, fail-closed

Explicit parameter passing is theoretically safer, but it is not viable here. Roughly 80 query sites have no request context, spread across three BullMQ workers and all of `src/utils/*`. Threading an `orgId` parameter through `menu.ts` → `template.ts` → `welcome.ts` → `notification-service.ts` means touching essentially every function signature in the codebase. A missed parameter is a compile error only if every signature becomes required simultaneously — in practice you get an unreviewable diff and the temptation to add optional parameters, which is worse than nothing.

AsyncLocalStorage inverts the failure mode: **the absence of context becomes detectable in exactly one place.**

```ts
// src/lib/tenant-context.ts (new)
type Scope = { organizationId: string } | { scope: 'PLATFORM'; reason: string };
export const tenantStore = new AsyncLocalStorage<Scope>();
```

> **The single most important rule in this migration:** if the store is empty and the model is tenant-scoped, the extension **throws**. It never falls through to unscoped. Fail closed.

### How context enters, per path

**HTTP request.** The middleware in `src/index.ts` is registered after `verifyToken` and before the `/api/*` router mounts. The source of truth is the **JWT claim**, not the subdomain — Host headers are user-controlled, so trusting the subdomain for data scoping means anyone who edits a header changes tenants. `organizationId` is present in organization JWTs. When custom domains arrive, a subdomain/claim mismatch returns 403; it must never silently change scope.

**BullMQ job.** Put `organizationId` in the job payload and wrap the whole handler body in `tenantStore.run()` — in all three workers. Two companion fixes are mandatory, not optional:

- **jobId namespacing.** Implemented for inbound and escalation jobs as `${organizationId}:...`. Keep this invariant for every new queue because BullMQ deduplicates by job ID and WhatsApp IDs are not globally unique across gateways.
- **Head-of-line blocking.** The inbound and campaign workers still use `concurrency: 1`. One tenant's campaign reply-storm can starve every other tenant's support inbox. The ordering guarantee actually wanted is *per-conversation*, not per-process: raise concurrency and take a Redis lock keyed on conversation. Queue-per-org is the alternative but needs a dynamic worker registry and does not scale past a few dozen tenants.

**Webhook.** Per-org unguessable token in the path — see §4.

**Socket.** Implemented in `src/socket/index.ts` and `src/socket/rooms.ts`: organization-scoped JWTs are required, and every room is namespaced as `org:{id}:dept:it`, `org:{id}:conv:{convId}`, or `org:{id}:alerts`. Workers and routes use the same helper with their organization context. The bleed harness proves cross-organization join rejection and live delivery isolation.

### Writes

The extension *can* inject into `data` — it is simply a different branch from `where`:

```ts
if (op === 'create')     args.data = { ...args.data, organizationId };
if (op === 'createMany') args.data = toArray(args.data).map(d => ({ ...d, organizationId }));
if (op === 'upsert')     args.create = { ...args.create, organizationId };
```

Three caveats:

- **Nested writes are invisible.** `data.messages.create` receives no `organizationId`. This is precisely what §0's composite FKs catch.
- **`connect` / `connectOrCreate`** on a globally-unique field (`connect: { phone }`) resolves across tenants until the uniques become composite.
- **Shared models need an explicit typed allowlist**, not implicit skipping. `Zone` is genuine shared reference data — real Israeli/Palestinian towns seeded from `src/constants/zones.ts`. Write that decision down as `const PLATFORM_MODELS = ['Zone', 'Organization', ...] as const` and make everything not listed tenant-scoped **by default**. Default-shared is how leaks happen.

### Unique selectors: the constraint migration

Tenant-local uniqueness must be represented in the schema, even though current Prisma versions permit an extra `organizationId` filter alongside a unique selector.

| Current | Becomes |
|---|---|
| `Contact.phone @unique` | `@@unique([organizationId, phone])` |
| Login email on the former user record | Global `Identity.email @unique`; tenant membership is `@@unique([organizationId, identityId])` — implemented |
| `WhatsappSession.sessionName` / `phoneNumber @unique` | `@@unique([organizationId, sessionName])` / `[organizationId, phoneNumber]` |
| `MessageTemplate.shortCode @unique` | `@@unique([organizationId, shortCode])` |
| `Keyword @@unique([category, phrase])` | `@@unique([organizationId, category, phrase])` |
| `Message.waMessageId` / `GroupMessage.waMessageId @unique` | `@@unique([organizationId, waMessageId])` — **required**, since per-org gateways make WA IDs non-unique globally |
| `WorkingHours id @default("default")` | drop the singleton; `@@unique([organizationId])`, one row per org (5 call sites) |
| `Conversation.displayId @default(autoincrement())` | per-org counter — see below |

Prefer explicit compound selectors at call sites where the business key is tenant-local. The extension may add `organizationId` as defense-in-depth, but it must not translate one business key into another or silently remove a caller-supplied organization. Audit the finite set of unique operations by hand and cover collisions in the bleed suite.

### Aggregates — the silent leakers

`count` / `groupBy` / `aggregate` all accept `where`, so injection works exactly as it does for `findMany`. The danger is the calls with **no explicit `where`**, which look intentionally global. The current examples are `prisma.ticket.count()` and `prisma.contact.count()` in `apps/backend/src/modules/analytics/analytics.routes.ts`.

On a bare `count()`, `args` may be `undefined`. The implemented extension handles `args ?? {}`; keep both bare calls as mandatory bleed-test cases because their safety is invisible at the call site.

### Per-org sequences

`nextTicketLabel()` now increments a `Sequence` row atomically, which fixes the old `count()+1` race but still uses a platform-global key. `Conversation.displayId @default(autoincrement())` has the same tenancy problem: tenant B's first conversation can visibly disclose platform-wide volume.

Both need an organization-owned counter identified by `(organizationId, kind)` and bumped via `UPDATE ... SET value = value + 1 RETURNING value` inside a transaction. Keep the existing atomic pattern, move ownership into the key, and test simultaneous allocation in two organizations.

### The orphan query sites

The seed and several files under `apps/backend/scripts/` still construct their own `new PrismaClient()`, intentionally bypassing the extension. Require each operational entry point to accept an explicit organization scope or platform reason, then migrate it to `getPrismaForOrg(orgId)` or `getPrismaPlatform({ reason })`. The existing lint script must keep this exception list small and reviewed. Enforcement beats discipline.

---

## §3 — Escape hatches for legitimate cross-tenant work

One mechanism, three uses. Do not build three.

```ts
runAsPlatform(reason, fn)   // src/lib/platform-scope.ts
```

It writes `{ scope: 'PLATFORM', reason }` into the same AsyncLocalStorage. The extension sees `PLATFORM` and skips injection. The current helper writes a structured application log; before production support access is enabled, it must also **write a durable audit row first** through `src/lib/audit.ts`. Every cross-tenant read records who, why, and when. Make it noisy: emit a metric and alert if platform-scope queries appear outside the super-admin route tree or the nightly rollup job.

Deliberately, this helper is **not** exported from a general utility barrel. Give it its own import path and add a lint rule allowlisting which files may import it. There should be about six.

### The login-by-email problem

Login is implemented with a global `Identity` and tenant-scoped `User` membership. `Identity` owns globally unique email and password hash; `User` owns `organizationId`, role, department, and away state. One identity can therefore have memberships in multiple organizations without weakening tenant-local roles.

The remaining work is UX and hardening: return a tenant picker when an identity has multiple memberships, rate-limit the cross-platform email lookup, add MFA/SSO bindings later, and ensure the selected membership alone determines the organization claim in the JWT.

### The super-admin tier

The separate authority axis is implemented as `Identity.platformRole` (`NONE | SUPPORT | OWNER` values stored as strings), while subscriber authority remains the `User.role` enum. Keep those axes separate so no existing `ADMIN` permission check in `src/middleware/rbac.middleware.ts` can grant platform powers.

### Platform analytics

Do not run cross-tenant aggregates against live tables through the escape hatch. Have a nightly job write per-org rollups into a `PlatformDailyMetric` table, and serve super-admin dashboards from that. It is faster, it is auditable, and it means the escape hatch is exercised by one scheduled job rather than by an interactive dashboard.

---

## §4 — Per-org OpenWA architecture

**Target decision:** one OpenWA deployment per subscriber organization. The current `apps/backend/src/modules/whatsapp/openwa.service.ts` still creates one process-wide axios client from `OPENWA_URL` and `OPENWA_API_KEY`; this is a transitional single-gateway implementation, not the multi-subscriber production design.

### Provisioning

Org onboarding becomes a workflow, not a database insert. Model it as a **resumable state machine** on the Organization row:

```
PENDING → PROVISIONING → AWAITING_QR → ACTIVE → SUSPENDED
```

Container provisioning fails halfway sometimes, and you need to know which half. For the first ~20 tenants, do not build an orchestrator: template the `openwa` service out of `docker-compose.yml` and bring it up from a host-side provisioning service, with a per-org volume for WhatsApp session state. Graduate to the Docker API or a small k8s operator when tenant count justifies it. What matters architecturally is that **the single `openwa` service becomes a template** and no application code assumes a fixed gateway address.

### Credentials

```prisma
model OrganizationChannel {
  organizationId String
  kind           String  // 'openwa'
  baseUrl        String  // http://openwa-{slug}:3000
  apiKeyEnc      String  // encrypted at rest
  webhookToken   String  @unique   // per-org, unguessable
  status         String
}
```

Gateway API keys grant full send capability on a tenant's WhatsApp line. Encrypt at rest with a KMS or env master key, and support **rotation from day one** — it will be needed during your first incident.

### Singleton → factory

`src/modules/whatsapp/openwa.service.ts` becomes `getClient(organizationId)`, returning a per-org cached axios instance. Twelve importing files, ~28 call sites — but the surface reduces to four verbs (`sendText`, `sendMedia`, `sendGroup`, `sendGroupMedia`) plus WhatsApp-only pairing (`getQR`, `startSession`, `stopSession`, `createSession`, `getStatus`).

**Extract the four verbs behind a `ChannelProvider` interface now, in Phase 1**, and keep pairing on a WhatsApp-specific sub-interface. That turns Phase 2 into an implementation exercise rather than a refactor.

### Webhook attribution gets better, not worse

The transitional webhook attributes inbound traffic by looking up `sessionName`. Per-org gateways give you something far better: **`POST /webhooks/openwa/:webhookToken`**. The token resolves the org and enters `tenantStore.run()`; *then* `sessionName` routes within that org. The token is the tenant boundary; the session name is only a within-org route.

Two things must change alongside it:

- The global webhook secret is now mandatory and timing-safe. Replace it with per-org path tokens during gateway provisioning; an unresolvable token returns **404, not 401** so token existence is not disclosed.
- Dedupe lookups must include `organizationId` through the tenant scope or a compound selector. Missing this silently swallows one organization's message as a duplicate of another's.

### `sessionIdCache`

`openwa.service.ts:16` is a module-level `Map<name, uuid>` with no tenant key and no invalidation. The moment two orgs both name a session `it-support`, org B's send resolves to org A's cached UUID — **an outbound leak of message content to a third party**. `sessionNameById()` at line 31 does a reverse scan over the same map and has the same defect.

Fix: key the cache `${organizationId}:${sessionName}` and, more importantly, scope it **per client instance** — each org's UUIDs come from a different gateway and are meaningless elsewhere. Add a TTL; today a recreated session pins a stale UUID until process restart.

### `isSharedWhatsAppLine()` — migrate deliberately

`src/utils/whatsapp-sessions.ts` is seven pure functions over `process.env` (`IT_SESSION_NAME`, `MARKETING_SESSION_NAME`, `IT_NUMBER`, `MARKETING_NUMBER`). All of it moves to per-org DB config, and every function becomes `async (organizationId) => ...` behind a per-org config cache.

But note a latent bug first: `isSharedWhatsAppLine()` returns `!mkt || mkt === it`, and **`MARKETING_NUMBER` is not passed to the backend container in `docker-compose.yml`** — so in production it always returns `true`, and `dbSessionForRoute` / `conversationFilterForDept` silently collapse the marketing inbox onto the IT session.

Before moving this configuration, record the bootstrap subscriber's current IT/marketing routing behavior. If it uses one shared line, encode that as an explicit per-org `sharedLine: true` setting rather than deriving it from a missing environment variable. This preserves current behavior without retaining an accidental global default.

### Other process-global caches

`src/constants/keywords.ts` caches keywords at module level, refreshed once at boot — a process-wide cache of tenant data feeding ticket-priority and lead-categorization logic. It becomes a per-org keyed cache with invalidation on write.

Any module-level `Map` or array holding domain data is now a tenancy bug by default. Add a Phase 1 audit step: grep for module-scope `new Map(` and `let cached`.

---

## §5 — Risk register

Ranked by (probability of occurrence) × (probability nobody notices).

| # | Risk | Current status and mitigation |
|---|---|---|
| 1 | **Aggregates with no explicit `where`.** A leaked count returns a plausible number; nothing breaks. | ALS injection handles `args ?? {}`. Still open until the two-tenant bleed test proves every aggregate path. |
| 2 | **Nested writes bypassing the extension.** Invisible to `$extends` by design. | Open: add the composite parent-child FKs in §0. |
| 3 | **Workers running with empty tenant context.** | Mitigated by fail-closed scope and worker wrappers; retain no-context tests for every handler. |
| 4 | **BullMQ `jobId` collision.** A customer's request can disappear as a deduplicated job. | Organization namespacing is implemented for inbound and escalation jobs; add dedupe metrics and coverage. |
| 5 | **Provider cache or client misrouting.** Sends content over another subscriber's WhatsApp gateway. | Mitigated: organization-owned encrypted channel, request-scoped provider, and provider-local TTL session cache. |
| 6 | **Cross-organization media retrieval.** | Bearer/signed URL authentication is implemented; add negative ownership cases to the bleed suite. |
| 7 | **Flat socket rooms.** A missing organization prefix can broadcast tenant events globally. | Mitigated: joins, leaves, and emits use the central `socketRoom` helper; static and live two-organization tests pass. |
| 8 | **Tenant-local identifiers treated as global.** Shared customer phones or session names can merge or misroute records. | Initial compound uniques exist; complete all selectors and collision tests. |
| 9 | **Authenticated users with excessive route permissions.** | Default JWT authentication is implemented; finish the `VIEWER` no-write permission audit. |
| 10 | **Stale JWT access after worker deactivation.** | Mitigated by `tokenVersion`, active-user lookup, and `logout-all`; retain revocation tests. |
| 11 | **Operational scripts bypassing the extension.** | Lint rule exists, but direct Prisma clients remain in explicit scripts; require an organization/platform scope argument before production use. |
| 12 | **Webhook attribution or token failure.** | Mitigated: globally unique channel token resolves the organization before session routing; unknown tokens return `404`. |

---

## §6 — Phase 0: hardening gate (~1.5–2 weeks)

**Checkpoint:** items 1, 2, 3, 5, 6, and the default authentication guard in item 4 are implemented. Socket authorization has organization-aware record checks and every room is organization-prefixed. The Prisma constructor lint exists, with explicit operational-script exceptions still visible and reviewable.

Every item here is a bug **today** and a breach the day org #2 exists. None require the tenancy model, all are independently shippable, and doing them first keeps the Phase 1 diff about tenancy only.

1. **Auth both media proxies** (`apps/backend/src/index.ts`, `/media-proxy` and `/media-proxy/message`). Implemented with bearer authentication or short-lived signed URLs; retain ownership checks in regression coverage.
2. **Authorize `join_conversation` and `join_group`** (`apps/backend/src/socket/index.ts`). Implemented with tenant-context record authorization and organization-prefixed rooms.
3. **Attribute every webhook before processing** (`apps/backend/src/webhooks/openwa.webhook.ts`). Implemented with a globally unique organization-channel path token; unknown tokens return `404`.
4. **Guard the unprotected routers** — `contacts.routes.ts`, `templates.routes.ts`, `notifications.routes.ts` have no permission checks. Better: **invert the default.** Apply a permission-required guard at the router mount in `src/index.ts` and explicitly opt routes out. The opt-in model has already failed 3 times out of ~17.
5. **Auth `/api/network`** (`apps/backend/src/index.ts`). Implemented through `verifyToken`.
6. **JWT `tokenVersion`** + `POST /api/auth/logout-all`. Implemented.
7. **Fix ticket/display sequences.** A transaction-backed helper exists, but the schema still labels `Sequence` as global and `Conversation.displayId` still documents per-org work. Finish and test organization-local numbering before Phase 1 exits.
8. **Frontend: kill the host-derived API base** (`apps/frontend/lib/runtime-url.ts`), plus the hardcoded LAN allowlist in `next.config.js`. Replace with a same-origin `/api` path proxied by Next rewrites. This de-risks Phase 1.5 entirely.
9. **Lint rule: no accidental `new PrismaClient()` outside `src/prisma/`.** Implemented as `apps/backend/scripts/lint-prisma-client.js`; keep seed, bootstrap, and maintenance scripts on an explicit reviewed exception list or migrate them to scoped factories.

**Definition of done:** every endpoint in `src/index.ts` and every socket event either requires auth or sits on an explicit, reviewed public allowlist. An authenticated `VIEWER` token can perform no write anywhere. An unauthenticated request to `/media-proxy/message` with a valid msgId returns 401.

---

## §7 — Phase sizing and definitions of done

Sizing assumes one experienced full-stack developer. Multiply by ~1.4 for someone new to this codebase.

### Phase 1 — Tenancy core · 5–7 weeks

Ordered sub-sequence (the order matters):

1. [x] `Organization` + `Identity` models; migration adding **nullable** `organizationId` everywhere.
2. [x] Backfill into one RabiTech bootstrap subscriber → set `NOT NULL` → swap uniques to compound → add composite FKs (§0).
3. [x] `src/lib/tenant-context.ts` + the Prisma extension in `src/prisma/index.ts`, **fail-closed**.
4. [x] Separate platform and organization JWT scopes; login against `Identity`; minimal RabiTech owner control plane.
5. [x] Subscriber provisioning transaction: organization + first admin + namespaced WhatsApp session record.
6. [x] Subscriber-admin user management and QR authorization; workers cannot access either operation.
7. [ ] Workers: org in payload, `tenantStore.run()`, jobId namespacing, concurrency fix. Scope and namespacing are done; per-conversation ordering/concurrency remains.
8. [x] Socket room namespacing across all joins, leaves, and emit sites.
9. [x] Organization-owned OpenWA client/session resolution; per-org webhook tokens; provider-local TTL cache; `whatsapp-sessions.ts` env to DB.
10. [x] Per-org sequences (`displayId`, ticket labels); `WorkingHours` de-singleton; per-org keyword cache.
11. Complete onboarding state machine and connection-health transitions.

**Critical files:** `apps/backend/prisma/schema.prisma`, `src/prisma/index.ts`, `src/modules/whatsapp/openwa.service.ts`, `src/workers/incoming-message.worker.ts`, `src/webhooks/openwa.webhook.ts`, `src/socket/index.ts`, `src/utils/whatsapp-sessions.ts`, `src/utils/conversation-session.ts`, `src/modules/auth/auth.routes.ts`, `src/modules/analytics/analytics.routes.ts`.

**Definition of done — the two-tenant bleed test.** Build the harness *before* the code:

- Seed org A with a known fixture. Snapshot the full response body of **every** GET endpoint and every socket event as tenant A.
- Seed org B with 10× the data volume.
- Re-run tenant A's snapshot. **Every byte must be identical.** Any count, list length, or `displayId` that moved is a leak. Wire it into CI.
- **Negative tests:** A's token requesting B's conversation / contact / media by ID → **404, not 403** (do not confirm existence). A's socket calling `join_conversation` with B's ID → rejected.
- **Fail-closed test:** invoke a worker handler with no tenant context → throws, returns no rows.
- **Collision test:** two orgs both using `sessionName: 'it-support'`, plus one shared customer phone number → messages route correctly, contacts do not merge.
- **Grep audit:** zero `new PrismaClient()` outside `src/prisma/`; zero module-scope mutable domain caches.

### Phase 1.5 — Branding · 1–1.5 weeks

Per-org theme record (colors, logo URL, product name, favicon, default locale/direction, custom domain). New React context beside `lib/i18n.tsx`, mounted in `components/providers.tsx`; server-injected CSS variables so there is no flash of default violet. Replace the hardcoded literals in `tailwind.config.ts` (`boxShadow`, `backgroundImage`) and `globals.css`; parameterize the logo in `components/app-sidebar.tsx` and the login page. Add `public/` for tenant assets. Custom domains, wildcard DNS, automated TLS. A frontend `middleware.ts` resolves host → tenant for **presentation only** — never for data scoping, since the JWT lives in `localStorage` and is invisible to middleware. That is fine: the backend is the authority.

**DoD:** provision a throwaway tenant, set colors + logo + name via API, screenshot-diff every page against the default tenant — the only differences are branded elements. `grep -i` for the brand violet across `apps/frontend` returns nothing outside theme defaults.

### Phase 2 — Channel abstraction · 3–4 weeks

Formalize `ChannelProvider` (4 verbs) + `PairingProvider` (WhatsApp-only). Canonical address type; move `@c.us` / `@g.us` / `@lid` handling out of `webhooks/openwa.webhook.ts`, `utils/phone.ts`, `utils/group-id.ts` into a WhatsApp adapter. Generalize `WhatsappSession` → `Inbox` and `Conversation.sessionId` → `inboxId` (large but mechanical). Per-provider capability flags so the UI hides what a channel cannot do.

**DoD:** a `MockChannelProvider` exists, and the full inbound → auto-reply → ticket → outbound flow passes end-to-end against it with zero WhatsApp code in the path. Adding a third channel touches only one new directory.

### Phase 3 — Metering + quotas · 2 weeks

Append-only `UsageEvent` (org, metric, quantity, timestamp) written at send/receive/AI-call boundaries; nightly rollup into `PlatformDailyMetric` (also feeds Phase 7). Plan limits enforced at the send path with graceful degradation, not a crash.

**DoD:** a tenant at 100% of message quota gets a clear in-app error and zero outbound sends; usage counters reconcile with actual `Message` rows within 1% over a 24h synthetic run.

### Phase 4 — Workflow builder · 6–8 weeks

Engine first (nodes, edges, versioned definitions, durable per-conversation execution state, awaiting-reply suspension, timeouts), canvas second. **Milestone 1 is porting the existing Arabic menu logic** from `utils/conversation-session.ts`, `utils/menu.ts`, and `utils/out-of-hours.ts` into a workflow definition. If it does not fit, redesign the engine before building any UI.

**DoD:** RabiTech's current behavior runs entirely on the engine with the old code paths deleted, and a non-engineer can build a 5-node flow that sends a real WhatsApp message.

### Phase 5 — AI agents · DEFERRED

Do not implement this phase until the product owner explicitly resumes it.

Agent as one workflow node type. Per-org knowledge base, per-org model config and system prompt, handoff-to-human node, token metering via Phase 3, hard per-org spend caps.

**DoD:** an agent handles a full conversation and hands off cleanly; per-org token spend is visible and capped; tenant A's knowledge base is provably unreachable from tenant B's agent.

> **Note:** RAG retrieval is a **new query surface that does not pass through the Prisma extension**. The Phase 1 bleed harness will not cover it for free — add a KB-isolation case explicitly.

### Phase 6 — Billing · 3–4 weeks

Stripe, plans, subscription lifecycle → org status, self-serve signup wired to the Phase 1 provisioning state machine, dunning.

**DoD:** signup → provisioned org with a live WhatsApp gateway → paid subscription, with no manual step. A failed payment suspends the org without deleting data.

### Phase 7 — Platform analytics + support operations · 2–3 weeks

Extend the Phase 1 owner console with `PlatformDailyMetric` rollups. Add support impersonation via `runAsPlatform` — always audited, always visibly banner-flagged in the UI. Per-org health: gateway status, queue depth, error rate.

**DoD:** every cross-tenant read appears in the platform audit log with a reason string; the number of files permitted to import `platform-scope.ts` is ≤ 6 and enforced by lint.

---

## Total: ~28–38 dev-weeks, not 12

The 12-week figure is achievable for **Phases 0 through 1.5** — and that is the right thing to aim at. At the end of Phase 1.5 you have a genuinely multi-tenant, genuinely white-label product you can sell. Phases 2–7 are the roadmap of a company that already has customers.

Compressing Phase 1 to hit a 12-week all-seven target is the single most expensive decision available here. It is the phase where mistakes are silent, cross-customer, and discovered by someone other than you.

---

## Verification and unresolved deployment input

This architecture was rechecked against the repository on 2026-08-19. The key implementation evidence is `apps/backend/prisma/schema.prisma`, `apps/backend/prisma/migrations/20260819000000_add_tenancy_base/migration.sql`, `apps/backend/src/prisma/extensions.ts`, `apps/backend/src/lib/tenant-context.ts`, `apps/backend/src/index.ts`, `apps/backend/src/modules/platform/platform.routes.ts`, `apps/backend/src/modules/auth/auth.middleware.ts`, `apps/backend/src/socket/index.ts`, `apps/backend/src/modules/whatsapp/openwa.service.ts`, and all files under `apps/backend/src/workers/`.

Review verification for every Phase 1 release candidate:

1. Run backend typecheck/build and the Prisma constructor lint.
2. Apply migrations to a production-like clone and verify Prisma migration status.
3. Run the two-tenant bleed, negative-ID, no-context worker, and session-name collision tests defined above.
4. Grep all socket joins/emits and confirm every tenant event uses an `org:{organizationId}:...` room.
5. Grep for `new PrismaClient`, module-scope mutable domain caches, and bare aggregates; every result must be intentionally scoped or explicitly allowlisted.
6. Verify each subscriber resolves a distinct OpenWA base URL, credential, webhook token, and persistent session volume.

One deployment input remains: record whether the bootstrap subscriber currently uses one shared WhatsApp line for IT and marketing. This does not change the per-organization architecture; it determines the subscriber's explicit `sharedLine` configuration during gateway migration.
