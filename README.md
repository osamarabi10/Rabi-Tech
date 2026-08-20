# RabiTech — WhatsApp Operations Platform

RabiTech is a **white-label, multi-tenant WhatsApp customer-conversation
platform** — a self-hosted alternative to Respond.io. Businesses ("subscribers")
get their own branded workspace where a team replies to WhatsApp customers from
a shared inbox, backed by contacts, broadcasts, auto-replies, and reports. A
separate platform-owner console manages subscribers, plans, and billing.

Full technical detail lives in [`docs/PROJECT-SPEC.md`](docs/PROJECT-SPEC.md)
(the master spec) and [`docs/TODO.md`](docs/TODO.md) (the working checklist).
This file is the orientation — read this first, then go there for depth.

---

## How the system works

```
WhatsApp ⇄ OpenWA gateway (self-hosted, one instance per subscriber)
              │  delivers events over a per-tenant webhook
              ▼
Backend — Express + Prisma + Socket.io
  • every database query runs inside a tenant scope (AsyncLocalStorage);
    a query with no scope throws instead of silently reading someone else's data
  • every tenant table carries organizationId + a composite foreign key,
    so the database itself refuses a cross-tenant write — not just app logic
  • background workers (BullMQ) handle inbound routing, campaigns,
    scheduled sends, gateway provisioning, and usage billing
              ▼
PostgreSQL (source of truth) · Redis (queues)
              ▲
Frontend — Next.js, RTL Arabic UI
  • tenant dashboard: five destinations (Inbox, Contacts, Broadcasts,
    Reports, Settings) — Respond.io's information architecture
  • platform console: subscriber list, provisioning, billing, and a
    read-only "view as subscriber" mode for support, fully audited
```

**Multi-tenancy is not a feature bolted on — it's the foundation.** Two
organizations on the platform can never see or affect each other's data,
enforced at the database layer, not just checked in application code. This is
covered by an automated isolation test suite that must pass before any schema
or scope change ships.

**White-label is a hard rule, not a preference.** Nothing a subscriber's
customer sees is hardcoded — every outbound message resolves from that
subscriber's own configured templates. If a subscriber hasn't configured a
reply for a given situation, the system sends nothing rather than falling back
to placeholder or platform-branded text. The RabiTech name never appears in a
subscriber's customer-facing messages.

---

## Workflow: how a message moves through the system

**A customer messages the business on WhatsApp:**

1. The message arrives at that subscriber's WhatsApp gateway, which forwards
   it to the backend over a private, tokenized webhook — so gateway traffic
   from one subscriber can never be mistaken for another's.
2. The backend resolves which subscriber owns that webhook, enters that
   subscriber's tenant scope, and hands the message to a background worker
   (so the webhook responds instantly and never blocks on slow processing).
3. The worker finds or creates the contact, then finds or reopens the
   conversation thread — a resolved conversation reopens with its full history
   intact rather than starting fresh.
4. If the message is a customer satisfaction rating, it's captured and the
   conversation is not treated as a new inbound message.
5. If the business is outside its configured working hours, an out-of-hours
   reply is sent — *only if the subscriber configured one*.
6. The message is checked against the subscriber's own keyword rules
   (configurable priority levels); a matching keyword can trigger a configured
   auto-reply and flag the conversation for follow-up.
7. If nobody is assigned yet, the conversation is auto-assigned to an
   available agent — round-robin or least-busy, whichever the subscriber's
   team is configured to use — skipping agents who are away or already at
   their workload cap.
8. The new message appears live in the assigned agent's inbox over a
   real-time connection — no refresh needed.

**An agent replies:**

1. The reply is saved to the database *before* it's sent to WhatsApp — so if
   the send fails, the message is marked failed and retryable rather than
   silently lost.
2. It's delivered through the gateway; delivery and read receipts flow back
   and update the message status live in the agent's view.

**A broadcast campaign:**

1. An admin composes a message, targets an audience (all contacts, or a
   filtered segment), previews exactly who will receive it with a live count,
   and sends now or schedules for later.
2. Sends are deliberately throttled — broadcasting too fast risks the
   WhatsApp number being blocked, so messages go out with spacing between
   them, respecting the subscriber's plan limits.
3. Delivery, read, and failure status come back per recipient, giving a real
   report instead of a fire-and-forget blast.

**A new subscriber signs up:**

1. They pick a plan, create an account, and verify their email.
2. Once payment is confirmed (automatically, once a payment provider is
   connected — see `docs/BILLING-PROVIDER-GUIDE.md`), their plan activates
   and their WhatsApp gateway begins provisioning automatically — no manual
   step from the platform owner.
3. They scan a QR code to link their WhatsApp number and start receiving
   messages into their new workspace.

---

## Stack

- **Backend:** Node.js, Express, TypeScript, Prisma, Socket.io, BullMQ
- **Frontend:** Next.js 14 (App Router), Tailwind CSS
- **Data:** PostgreSQL, Redis
- **WhatsApp:** self-hosted OpenWA gateway (one instance per subscriber)

---

## Quick start

```bash
# 1. Configure environment
cp .env.example .env
# fill in OPENWA_API_KEY, JWT_SECRET, CHANNEL_ENCRYPTION_KEY, and DB/Postgres credentials

# 2. Build and start everything
docker compose build
docker compose up -d

# 3. Apply migrations and seed demo data
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run db:seed

# 4. Open the dashboard
# http://localhost:8080
```

See [`CLAUDE.md`](CLAUDE.md) for the full command reference (schema changes,
typechecking, the tenancy isolation gate) and
[`docs/WHATSAPP-GATEWAY-RUNBOOK.md`](docs/WHATSAPP-GATEWAY-RUNBOOK.md) for
diagnosing WhatsApp connection issues specifically.

### Default logins (seeded demo data — change before production)

| Role | Email | Password |
|---|---|---|
| Subscriber admin | `admin@rabitech.co.il` | `admin123` |
| Platform owner | `owner@rabitech.co.il` | `owner12345` (or `PLATFORM_OWNER_PASSWORD` if set) |

Set `PLATFORM_OWNER_EMAIL` and `PLATFORM_OWNER_PASSWORD` in `.env` before
seeding anywhere beyond local development.

---

## Where to go next

- **[`docs/PROJECT-SPEC.md`](docs/PROJECT-SPEC.md)** — the master specification: verified
  current state, full surface map, feature parity against Respond.io, and every
  phase of remaining work with its definition of done.
- **[`docs/TODO.md`](docs/TODO.md)** — the working checklist, phase by phase.
- **[`docs/WHATSAPP-GATEWAY-RUNBOOK.md`](docs/WHATSAPP-GATEWAY-RUNBOOK.md)** — read first
  whenever "WhatsApp isn't working."
- **[`docs/BILLING-PROVIDER-GUIDE.md`](docs/BILLING-PROVIDER-GUIDE.md)** — how to switch
  on a real payment provider when ready.
- **[`CLAUDE.md`](CLAUDE.md)** — architecture and conventions reference for anyone
  (human or AI) working on the codebase.
