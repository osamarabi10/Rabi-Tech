# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

RabiTech is a multi-tenant, white-label WhatsApp customer-conversation platform. Independent businesses (subscribers) each get a branded workspace: customers message their WhatsApp number, and the system auto-routes, auto-replies, and lets their agents respond from a shared web inbox. A separate platform-owner console manages subscribers, plans, and billing.

## Roadmap

The authoritative RabiTech target architecture, implementation checkpoint, release gates, and sequencing are documented in [docs/ARCHITECTURE-MULTITENANCY.md](docs/ARCHITECTURE-MULTITENANCY.md). Phase 1 is incomplete until every isolation gate marked there is verified.

[docs/RABITECH-MASTER-PLAN.md](docs/RABITECH-MASTER-PLAN.md) is the self-contained execution plan: verified current state, Respond.io parity target (logic + UI), and every phase brief P1-A through P7 with definitions of done. Hand this file to an agent to execute a phase.

**[docs/PHASES-TO-LAUNCH.md](docs/PHASES-TO-LAUNCH.md) is the launch plan** — what stands between here and a first paying customer, phased, with the owner-only items marked. Start there when the question is "what now".

**[docs/TODO.md](docs/TODO.md) is the working checklist** — every remaining phase as tick-boxes with a verify line each; work it top to bottom and mirror ticks into the spec.

**[docs/PROJECT-SPEC.md](docs/PROJECT-SPEC.md) is the master specification** — verified current state, surface map, Respond.io parity scorecard, dead-flow register, full phase ledger (done-with-evidence + remaining-with-DoD), and the owner-only blockers. **Start here.**

[docs/ROADMAP-REMAINING.md](docs/ROADMAP-REMAINING.md) keeps the detailed per-phase execution notes behind the spec's ledger.

**[docs/UI-SURFACE-MAP.md](docs/UI-SURFACE-MAP.md) — read before editing any UI.** Route and component map, and the places where the obvious edit is the wrong one. [docs/UI-PHASES.md](docs/UI-PHASES.md) records what the U1–U8 UI phases changed; [docs/API-CONTRACTS-U2-U6.md](docs/API-CONTRACTS-U2-U6.md) documents the endpoints they added.

[docs/AMARSAIL-DESIGN-SYSTEM.md](docs/AMARSAIL-DESIGN-SYSTEM.md) is the design system for Amarsail, which evolves this console: colour tokens with separate fill/text values, the IBM Plex trilingual stack, the role type scale, screen architecture for the four-pane inbox and the OpenWA session lifecycle, and component specs. Its rules are the shipped ones — read it before designing a new surface.

**[docs/WHATSAPP-GATEWAY-RUNBOOK.md](docs/WHATSAPP-GATEWAY-RUNBOOK.md) — read first when "WhatsApp isn't working".** Inbound-broken and outbound-broken are separate faults with separate causes; it covers both, plus which operations discard WhatsApp credentials.

[docs/BILLING-PROVIDER-GUIDE.md](docs/BILLING-PROVIDER-GUIDE.md) — everything needed to switch on online payments later. Activation is already automatic; only checkout is stubbed.

[docs/MARASIL-SPEC-FIT.md](docs/MARASIL-SPEC-FIT.md) analyses the 123-page Marasil product spec (same product, but designed for Meta Cloud API) against RabiTech on OpenWA — what does not port, what inverts, the full UI/design-token comparison, and the consent gap it exposes.

[docs/RESPONDIO-BLUEPRINT-FIT.md](docs/RESPONDIO-BLUEPRINT-FIT.md) maps the Respond.io architecture blueprint onto RabiTech's verified state — what already exists, what to build, and which parts of that blueprint to deliberately skip (multi-datastore persistence, light-canvas re-theme, omnichannel fan-out). Read it before starting workflow-engine or channel work.

## Commands

### Development (local, no Docker)
```bash
# Backend (port 4000)
cd apps/backend && npm install && npm run dev

# Frontend (port 8080)
cd apps/frontend && npm install && npm run dev
```

### Docker (production / preferred)
```bash
docker compose build
docker compose up -d

# Rebuild only one service after changes
docker compose build backend && docker compose up -d backend
docker compose build frontend && docker compose up -d frontend
```

### After any backend schema change
```bash
# 1. Write the SQL manually in apps/backend/prisma/migrations/<timestamp>_<name>/migration.sql
# 2. Regenerate Prisma client
cd apps/backend && npx prisma generate

# 3. Apply to live DB (run inside container or with DB accessible)
docker compose exec backend npx prisma migrate deploy

# 4. If migration file already exists but wasn't tracked yet
docker compose exec backend npx prisma migrate resolve --applied <migration_name>

# Apply SQL directly when migrate deploy isn't reachable
docker compose exec postgres psql -U admin -d rabitech -c "ALTER TABLE ..."
```

### Typecheck backend
```bash
cd apps/backend && npx tsc --noEmit -p .
```

### Tenancy isolation gate
```bash
cd apps/backend && npm run test:tenancy
```

The gate uses a disposable PostgreSQL schema and must stay **green (67/67)**. Treat a red gate as a release blocker, not a known issue.

### Platform finance check
```bash
cd apps/backend && npm run test:finance
```

Exercises the platform ledger against the real database (17/17): reference
numbering, receipt-and-invoice-in-one-transaction, part payments, overpayment
refusal, HTML escaping, CSV quoting. Builds first because it runs the compiled
output the server actually runs, and deletes everything it creates.

It was previously recorded here as 16/16 and was not: the suite picked its
subject with an unordered `findFirst`, so it drew a different organization
between runs and failed whenever it drew `org_rabitech_0`, whose id tail
`CH_0` the format assertion rejected. The selection is now ordered and the
assertion accepts the underscore that a slug id legitimately produces.

**References are drawn from `OrgSequence`, not from a row count.** The suite
asserts the issued reference matches the `invoiceRef` high-water mark, which
is what fails if numbering ever reverts to `count(rows) + 1`. The counter
survives the suite's own cleanup by design, so the sequence number rises
between runs — that is the non-reuse guarantee working, not a leak. Never
reset those counters to make a test read `0001` again; see
`docs/RESPONDIO-PARITY-CHECKPOINT.md`.

**Finance documents are not tax documents.** No fiscal numbering, no VAT, no
`חשבונית מס` / `فاتورة ضريبية` labelling. Do not add any without a real
accounting provider behind it — see [docs/API-CONTRACTS-U2-U6.md](docs/API-CONTRACTS-U2-U6.md).

### Check migration status
```bash
docker compose exec backend npx prisma migrate status
```

## Architecture

### Services (docker-compose.yml)
| Service | Port | Role |
|---|---|---|
| `postgres` | 5432 | PostgreSQL 15 database |
| `redis` | 6379 | BullMQ queues (campaign + inbound messages) |
| `openwa` | 3000/3001 | WhatsApp gateway REST API + QR web UI |
| `backend` | 4000 | Express + Prisma + Socket.io |
| `frontend` | 8080 | Next.js 14 App Router |

### Inbound message flow

```
WhatsApp → OpenWA webhook → POST /webhook/message
  → BullMQ (incoming-message queue)
    → incoming-message.worker.ts (processInboundMessage)
      → contact upsert
      → getOrCreateActiveConversation() ← core thread logic
      → handleClientFeedback()           ← CSAT ratings intercept
      → maybeSendOutOfHoursReply()
      → keyword detection → configurable auto-reply (or silence)
      → autoAssignConversation()         ← round-robin / least-open
      → Socket.io emit to team room      ← live inbox update
```

### Thread management (`utils/conversation-session.ts`)
One thread per contact per session. `getOrCreateActiveConversation`:
- Returns existing OPEN/PENDING thread unchanged
- Reopens a RESOLVED thread (same ID, history preserved) — sets `reopenedFromResolved: true`
- Creates a new thread only when the contact has never chatted before

### WhatsApp sessions
Each organization owns its own `WhatsappSession` rows, linked to a `Team`. A session starts unlinked and gets a real number when an admin scans its QR code. Never hardcode a session name — resolve it from the organization.

### Keyword detection + auto-reply
- Priority levels: `CRITICAL / HIGH / MEDIUM / LOW` — defined in `constants/keywords.ts`
- Categories: `network / hardware / speed / service / other`
- Add new keywords to `keywords.ts`, add reply text as an editable `MessageTemplate` row (see `constants/default-auto-replies.ts` for the seed set), wire trigger in `conversation-session.ts` — never scatter logic into the webhook itself

### Socket.io rooms
All rooms are namespaced by organization — see `socket/rooms.ts`, never build a room string by hand.

| Room | Purpose |
|---|---|
| `org:{orgId}` | Org-wide events (campaign progress, session status) |
| `org:{orgId}:team:{teamId}` | Live inbox updates per team |
| `org:{orgId}:conv:{id}` | Agents watching a specific conversation |
| `org:{orgId}:user:{id}` | Per-user bell notifications |
| `org:{orgId}:alerts` | Alert broadcasts |

Events are defined in `socket/index.ts` → `SocketEvents` const.

### RBAC (`middleware/rbac.middleware.ts`)
Roles: `ADMIN > SUPERVISOR > AGENT > VIEWER / FINANCE`. Use `requirePermission('operation:action')` middleware — never inline role checks. Permissions matrix is in `ROLE_PERMISSIONS` in that file.

### Media proxy (`src/index.ts` → `/media-proxy`)
WhatsApp media URLs are internal to the OpenWA container. The backend proxies them so a browser can load images/audio/video. MIME type is detected by magic bytes (not upstream header) because OpenWA sometimes returns wrong MIME for voice notes (OGG/Opus).

### Frontend (`apps/frontend`)
- Next.js 14 App Router, RTL Arabic UI, Tailwind CSS v3
- All API calls and types live in `lib/data.ts`
- Socket connection and inbox state live in `app/(dashboard)/inbox/page.tsx`
- Arabic dialect: Palestinian/Arab48 colloquial — "أهلين" not "مرحباً", "شو" not "ماذا", "فيني/فيك" for can. Match the tone in `constants/default-auto-replies.ts`.

#### UI rules that are load-bearing

Each of these was a bug that shipped and looked correct in the source. See
[docs/UI-SURFACE-MAP.md](docs/UI-SURFACE-MAP.md) for the full map.

- **Every control does something.** No toast-only buttons, no controls that
  vanish for users who lack permission — show the restriction
  (`components/permission-notice.tsx`). A blank space is indistinguishable
  from an empty card and from an ungranted feature.
- **Never state a fault you have not confirmed.** "Not yet known" renders as
  nothing or as "checking", never as an error. An agent sent to fix a working
  channel is worse off than one told nothing.
- **Logical properties only.** `ms/me`, `ps/pe`, `start-*`/`end-*`,
  `text-start`. Two of the three languages are RTL. `inset-inline-0` reads
  like a logical property and is **not** a Tailwind class — use `start-0
  end-0`.
- **`dir="ltr"` on numbers only** — phone numbers, money, dates, numeric
  inputs. Never on a container.
- **`cn()` is an extended twMerge.** The role type scale (`text-caption`,
  `text-micro`, …) is registered as font sizes in `lib/utils.ts`. Without
  that, tailwind-merge drops the size when a colour is in the same call and
  the component silently renders at 16px. Adding a role to the scale means
  adding it there too.
- **Never concatenate alpha onto a colour string.** `hsl(var(--x))20` is
  invalid CSS and fails silently. Use `color-mix()` — see `lib/tint.ts`.
- **Tenant colours are deepened, never replaced.** A subscriber picked that
  colour; mixing toward black keeps their hue and makes it legible.
- **Contrast is measured against the surface the text sits on**, not against
  white, in both themes. Tokens tuned as button fills (`--destructive`) are
  too light as text; the palette carries `--danger`/`--warning` for that, and
  `app/globals.css` maps the text utilities onto them.
- **Arabic source strings are dictionary keys.** A missing key falls back to
  itself, so the UI keeps working and the failure hides — which is what the
  checks below exist to catch.

```bash
cd apps/frontend && npm run check:i18n
```

```bash
cd apps/frontend && npm run check:mojibake
```

`check:i18n` verifies every literal `t()` key is translated in Hebrew and
English, with no duplicate or blank entries. `check:mojibake` finds Arabic or
Hebrew that was decoded as Latin-1 and written back as UTF-8 — valid UTF-8,
so nothing else complains, and unreadable to whoever is shown it.

### Key enums (Prisma schema)
- `ConversationStatus`: `OPEN | PENDING | RESOLVED`
- `MessageStatus`: `PENDING | SENT | DELIVERED | READ | FAILED`
- `Message.isInternal`: private agent notes — not sent to WhatsApp
- `Conversation.labels`: string array, max 10 per conversation
- `MessageTemplate.shortCode`: unique, triggers `:code` expansion in the reply box

### Workers
- `workers/incoming-message.worker.ts` — BullMQ, processes inbound WhatsApp messages with retry. `DISABLE_MESSAGE_WORKER=1` env var skips it.
- `workers/campaign.worker.ts` — BullMQ, sends bulk campaign messages with ~1.2s delay between sends. `DISABLE_CAMPAIGN_WORKER=1` skips it.

### Broadcasts
Campaigns target an audience via the contact filter DSL (`lib/contact-filter-dsl.ts`), stored on `Campaign.audienceFilter`. Sends are throttled — see `workers/campaign.worker.ts` and the `CAMPAIGN_*` env vars.

### WhatsApp groups are not supported
RabiTech is a **1:1 conversation platform**. Inbound group messages (`@g.us`) are explicitly ignored in the webhook. Do not reintroduce group handling without a product decision.

## Environment variables (key ones)
```
DATABASE_URL          postgresql://admin:secret@postgres:5432/rabitech
REDIS_URL             redis://redis:6379
OPENWA_URL            http://openwa:2785
OPENWA_API_KEY        dev-admin-key
JWT_SECRET            <secret>
IT_SESSION_NAME       it-support
MARKETING_SESSION_NAME marketing
IT_ALERT_GROUP_ID     <wa group id for CRITICAL alerts>
FRONTEND_URL          http://<lan-ip>:8080
```
Frontend also needs `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_SOCKET_URL` pointing at the backend LAN IP:4000.
