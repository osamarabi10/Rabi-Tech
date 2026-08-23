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
Frontend — Next.js, RTL Arabic UI (Arabic, Hebrew, English)
  • tenant dashboard: five destinations (Inbox, Contacts, Broadcasts,
    Reports, Settings) — Respond.io's information architecture
  • platform console at /platform: what needs a person today, staff and
    their scoped access, trial and dunning settings, subscribers, and a
    "view as subscriber" mode for support, fully audited
```

Three things run on their own, with no human in the loop:

| | What it does | Fails how |
|---|---|---|
| **Access gate** | Refuses every workspace route for an expired trial or a suspended subscriber, keeping billing reachable so they can fix it | **Open**, loudly logged — a database hiccup must not lock out every paying customer at once |
| **Dunning** | Warn → deadline → suspend → restore on payment | Its own try/catch, so a provider outage cannot stop the deadline clock |
| **Backups** | Nightly `pg_dump`, then **restored into a scratch database and row-counted** before it is called a backup | Alerts *and* emails the owner; a failed dump is renamed so it cannot be mistaken for a good one |

Expiry is decided **when someone asks**, never by a job that flips a flag.
A sweeper that dies leaves tenants holding access they lost; read-time expiry
cannot fail, and extending a trial becomes one field with nothing to reconcile.

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

1. They create an account and verify their email. No card, no payment.
2. They get a **3-hour trial of the full product** — not a reduced tier. The
   trial runs on a real paid plan, because the free tier grants no WhatsApp
   connection and a trial that cannot connect a number demonstrates nothing.
   The deadline is stamped once, at signup.
3. Their gateway provisions automatically and they scan a QR code to link
   their WhatsApp number — the thing the trial exists to show.
4. A countdown banner shows what is left, counted against the *server's*
   clock so a device with the wrong time cannot mislead them.
5. When the trial ends, the API refuses every workspace route with a
   machine-readable code and the app redirects to pricing. Billing, identity
   and branding stay reachable — a paywall that blocks the route to the
   payment page has locked the customer out of paying you.

Trial length and which plan it runs on are settings in the owner console, not
constants — see `/platform/settings`.

**A payment fails, and the subscriber gets it back:**

1. An invoice passes its due date. The next dunning pass gives the subscriber
   a *deadline* rather than cutting them off, records it, and emails the
   workspace admins once — deduplicated by a database constraint, so a pass
   that runs twice cannot warn the same customer twice.
2. Meanwhile the product keeps working, and a persistent in-app banner names
   the date. This is the state that matters: everything responds, and on
   Thursday it stops. The email was sent; whether it was read is not
   something this product assumes.
3. If the deadline passes unpaid, the workspace is suspended — locked out at
   the API, gateway stopped — and told so by email.
4. **Payment restores access automatically.** No support ticket, no manual
   step. The gateway resumes, and a recovery email says so. Nothing was
   deleted; messages that arrived while paused are waiting in the inbox.

---

## Support staff, without database access

Platform staff are created and scoped from `/platform/staff`. An advisor gets
a list of permissions rather than a role — support work is not a ladder, and
one advisor may need to extend trials while never touching a discount.

Three boundaries the code enforces, each covered by the isolation gate:

- **Staff management is never grantable.** An advisor who could grant
  permissions could grant themselves permissions, and every other scope
  becomes decoration.
- **Permissions are read per request**, never trusted from the token, so
  revoking one takes effect immediately rather than whenever a seven-day
  token expires.
- **Disabling bites at once**, in the token check and not only at login.

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

### Seeded logins

The seed creates a subscriber admin and a platform owner. **Their passwords are
not published here** — this repository is public, and a default credential
printed on a public page is a credential, not a placeholder.

Set these in `.env` **before seeding**, and the seed will use them:

```bash
PLATFORM_OWNER_EMAIL=you@yourdomain.com
PLATFORM_OWNER_PASSWORD=          # long, and not reused anywhere
```

If you seeded before setting them, the seed fell back to a well-known default.
Change it now — see [`docs/SECURITY-ROTATION.md`](docs/SECURITY-ROTATION.md).

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
