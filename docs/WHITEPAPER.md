# RabiTech — a technical white paper

**A multi-tenant, white-label WhatsApp customer-conversation platform.**
Version of record: 1 September 2026.

This document describes what RabiTech is, how it is built, and which of its
engineering decisions are load-bearing. It is written for someone who has not
seen the code: a prospective partner, a co-founder joining mid-flight, or an
engineer deciding whether the foundations hold.

It describes the system as it verifiably runs, not as it is intended to run.
Where something is unfinished, it says so. The companion documents are
[PROJECT-SPEC.md](PROJECT-SPEC.md) for the current-state ledger,
[PHASES-TO-LAUNCH.md](PHASES-TO-LAUNCH.md) for what remains, and
[KNOWN-DEFECTS.md](KNOWN-DEFECTS.md) for the open faults.

---

## 1. The problem

A small business in Palestine or Israel runs its customer relationship through
one WhatsApp number on one phone. That works until it doesn't: the phone belongs
to one person, nobody else can answer it, there is no record of who said what,
no way to route a question to whoever can answer it, and no way to know whether
anyone replied at all.

The existing answer is Respond.io or Intercom — good products, priced and
designed for a different market, in English or in a machine-translated Arabic
that reads as foreign. Neither is white-label, so a local agency cannot resell
either as its own.

RabiTech is that product, built for this market: **trilingual (Arabic, Hebrew,
English), right-to-left first, and white-label from the schema up** so an agency
can put its own name on it and sell it.

---

## 2. What it does

Customers message a business's WhatsApp number. RabiTech receives every message,
threads it into a conversation, routes it to the right team, replies
automatically when it can, and presents everything in a shared web inbox where
several agents work the same number without colliding.

The operator surface is a four-pane inbox: scope, conversation list, thread, and
contact context. The platform-owner surface is a separate console for managing
subscribers, plans and billing — deliberately a different application shell, not
a permission level inside the same one.

**What it is not.** RabiTech is a one-to-one text platform. WhatsApp group
messages are explicitly ignored at the webhook. There are no voice calls. Both
are product decisions, recorded so they are not re-proposed as gaps.

---

## 3. Architecture

Five services, composed:

| Service | Role |
|---|---|
| `postgres` | PostgreSQL 15 — the single datastore |
| `redis` | BullMQ queues for inbound messages and campaign sends |
| `openwa` | The WhatsApp gateway: REST API plus a QR pairing UI |
| `backend` | Express + Prisma + Socket.io |
| `frontend` | Next.js 14, App Router |

Roughly 32,000 lines of TypeScript in the backend across 146 files, and 34,000
in the frontend across 173. The frontend holds **zero** database references —
every read and write goes through the HTTP API, which is what makes the
data layer replaceable without touching the interface.

### 3.1 The inbound path

```
WhatsApp → gateway webhook → POST /webhook/message
  → BullMQ (incoming-message queue)
    → contact upsert
    → getOrCreateActiveConversation()   ← thread identity
    → CSAT rating intercept
    → out-of-hours reply
    → keyword detection → configurable auto-reply
    → auto-assignment (round-robin / least-open)
    → Socket.io emit to the team room   ← live inbox update
```

The queue is not decoration. WhatsApp delivers webhooks with no useful retry
semantics, and a message lost during a deploy is a customer who was ignored.
Queuing makes delivery survive a restart and makes a failing handler retry
rather than drop.

### 3.2 Thread identity

One thread per contact per session. A returning customer reopens their existing
conversation rather than starting a new one — same ID, history preserved. A new
thread is created only for a contact who has never written before.

This sounds obvious and is the single most consequential decision in the
product. The alternative — a new thread per message burst — produces an inbox
where a customer's history is scattered across a dozen rows, which is precisely
the problem the product exists to solve.

---

## 4. Multi-tenancy — the differentiator

RabiTech is not a tool one business runs. It is a platform many businesses run
on simultaneously, each seeing only its own customers' conversations. That
guarantee is the product. Everything below exists to make it hold.

### 4.1 Two independent layers

**Application layer.** A Prisma client extension injects `organizationId` into
every query — into the `where` of every read, the `data` of every write, and the
optional `where` of `updateMany` and `deleteMany`. It is **fail-closed**: a
query issued with no tenant context in scope throws rather than running
unscoped.

That last property was earned. Before it existed, `findFirst` ran completely
unscoped, and `deleteMany({})` reached the database with no tenant predicate at
all — not "delete mine" but "delete every organization's", silently.

**Database layer.** Every parent table carries a `UNIQUE (id, organizationId)`,
and children reference it as a **composite foreign key**:

```sql
ALTER TABLE "Message"
  ADD CONSTRAINT "Message_conversationId_organizationId_fkey"
  FOREIGN KEY ("conversationId", "organizationId")
  REFERENCES "Conversation"("id", "organizationId")
  ON DELETE CASCADE;
```

There are **50 such constraints across 30 models**. Their effect is that a
cross-tenant reference is not merely rejected — it is unrepresentable. A message
in organization A cannot point at a conversation in organization B no matter
what the application code does, because there is no row for the pair to
reference.

**The two layers are independent on purpose.** The extension catches mistakes in
routes; the constraints catch mistakes in the extension. A single layer, however
careful, can only catch bugs that are not in itself.

### 4.2 Proving it

Isolation is asserted by a harness of **127 checks** that seeds two
organizations, snapshots one, seeds ten times more data into the other, and
asserts the first is byte-identical — through the database, through every
authenticated HTTP endpoint, and through Socket.io rooms. It runs against a
disposable PostgreSQL schema created and dropped per run.

Nine of those checks deliberately bypass the extension and write with a raw
client, asserting the *database* refuses. Those are the ones that would go
silently green if the constraints were ever removed.

The gate is a release blocker, not a known issue. Two rules govern it:

> **Read the printed summary line, never the exit code alone.**
> **A gate is green only when it was watched to run.**

Both were written after gates in this repository reported on their environment
rather than on the code — four separate times.

### 4.3 Everything else is namespaced too

Socket.io rooms are built from a helper, never by hand, and every one is
prefixed `org:{orgId}`. The tenancy harness statically audits every emit site in
the codebase for that prefix, which is a stronger guarantee than a test over any
single module.

---

## 5. The WhatsApp reality

RabiTech runs on **OpenWA**, an unofficial gateway that drives WhatsApp Web. It
is honest about what that means:

- It breaks whenever WhatsApp changes its web client. This is not a risk, it is
  a scheduled event.
- Session credentials live in a Docker volume, not the database. Recreating the
  container preserves them; deleting the gateway session does not, and that is
  the only operation requiring a customer-visible QR re-scan.
- Conversation history is never at risk from any gateway operation, because
  threads are keyed on the *customer's* phone number, not the business's.

The path off this is Meta's official WhatsApp Cloud API, modelled in the schema
already — `OrganizationChannel.kind`, an encrypted credential vault with a
`keyVersion` column, template lifecycle, and the 24-hour service window enforced
before any send. The channel itself is not yet built; it is the largest planned
piece of work.

Channel credentials are encrypted at rest with AES-256-GCM under a key separate
from every other secret, and are never returned by any endpoint.

---

## 6. Commercial model

The platform owner defines **editions** — plans, held as data rather than code,
with entitlements resolved from a catalogue loaded at boot. An edition carries
message and contact ceilings, feature grants, permitted channels, a pricing
model and a billing interval. Editions can be created, edited, deactivated,
archived and scheduled to change on a date, all from the console.

Two invariants are enforced and tested:

- **Deactivating or archiving an edition never orphans its subscribers.** The
  edition stops being offered; everyone already on it keeps resolving their own
  entitlements. Withdrawing an edition by making it stop resolving would strand
  every existing customer.
- **An edition whose only channel the platform cannot operate is unofferable** —
  and its existing subscribers still resolve. Both halves together, because
  satisfying only the first is how you strand people.

Usage is metered into an **append-only ledger**. `UsageEvent` rejects updates
and deletes at the extension layer: a billing record that can be edited after
the fact is not evidence.

Invoice and receipt numbers come from a per-organization high-water mark
allocated inside the same transaction as the row that carries it —
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, proven under 20 concurrent
allocations per organization. Numbers are never reused. They used to be derived
from `count(rows) + 1`, which meant any deletion handed the next document a
number an earlier one already carried.

**Finance documents here are not tax documents.** No fiscal numbering, no VAT,
no tax-invoice labelling, and the rendered output says so. Issuing anything
tax-valid needs a real accounting provider behind it.

---

## 7. Access control

Five roles — `ADMIN > SUPERVISOR > AGENT > VIEWER / FINANCE` — enforced by
middleware against a single permissions matrix. Never by inline role checks,
because a matrix in one file and a check in another drift, and they drift toward
granting.

The frontend derives what it shows from the same matrix the server enforces,
returned at sign-in. A mirrored copy on the client would drift the first time a
role gained an operation, and would drift toward offering pages the server
refuses.

Sessions carry a token version so credentials can be revoked mid-token.
Two-factor authentication is available, with encrypted TOTP secrets and
single-use recovery codes.

---

## 8. Interface

Next.js 14 App Router, Tailwind, and a design system — Amarsail — with
colour tokens that carry **separate fill and text values**, because a colour
tuned as a button fill is too light as text on the same surface.

Three languages, two of them right-to-left. This shapes the CSS more than it
sounds: only logical properties are permitted (`ms`/`me`, `start`/`end`), and
`dir="ltr"` appears on numbers alone — phone numbers, money, dates — never on a
container.

Arabic source strings are dictionary keys, so a missing translation falls back
to itself: the interface keeps working and the failure hides. Two checks exist
for exactly that — one verifying every key is translated into Hebrew and
English, another finding text that was decoded as Latin-1 and written back as
UTF-8, which is valid UTF-8 that nothing else complains about and nobody can
read.

The Arabic is Palestinian colloquial, not Modern Standard. "أهلين", not
"مرحباً". A customer can tell.

One rule governs every control: **every control does something.** No toast-only
buttons, and nothing vanishes for a user who lacks permission — the restriction
is shown, because a blank space is indistinguishable from an empty card and from
a feature that was never granted.

---

## 9. Operational posture

**Backups.** A nightly dump that is **restored into a scratch database and
counted before it is called a backup**. Producing a file is the half that gives
false confidence; a truncated dump has plausible size and fails at the only
moment it matters. Retention deletes only files the job itself created, never a
hand-made dump taken before a risky migration.

An encrypted off-host replica and a weekly restore drill are built behind a
destination interface. The drill fails a copy older than its freshness window
*even when that copy restores perfectly*, because replication that stopped
quietly while the drill kept passing on an old file is the failure worth
catching. A real off-host destination is not yet configured; the item stays open
in the checklist and is not ticked.

**Migrations.** Eighty-one, hand-written, forward-only. Prisma Migrate has no
`down`, so reversal is a manual procedure that has been rehearsed and written
down before it was needed — including the step people miss, which is that
undoing the SQL leaves a row in `_prisma_migrations` claiming a schema the
database no longer has.

**Defects.** Twenty-nine are catalogued with reproduction and resolution. The
register is kept because the same shapes recur, and one recurs more than any
other: **a check that reports on its environment rather than on the code.** Four
separate defects were that. The countermeasures — bounded child processes,
printed summary lines, hermetic gates that need no database — all come from it.

---

## 10. Honest status

RabiTech is **pre-launch**. It runs, it is multi-tenant, it is metered, it is
gated, and it has no paying customers.

What works and is proven: the inbox, threading, assignment, auto-replies,
broadcasts with real delivery and read receipts, contacts with custom fields and
imports, saved segments, saved views, the workflow engine, reports, the edition
ladder, invoicing and receipts, dunning, provisioning, and tenant isolation.

What is missing and known: online checkout is a stub — the paywall works and the
payment does not exist, pending a provider decision. The workflow builder is a
form rather than a canvas. There are no AI features behind the AI metering. The
official Meta channel is modelled but not built. And the deployment runs over
plain HTTP on a local machine, not behind TLS on a server.

The distance from here to a first paying customer is one commercial decision and
about a week of work behind it. Everything else on the roadmap is sequenced
after revenue, deliberately.

---

## 11. The principle underneath

Most of what is written above is a countermeasure to something that already went
wrong once, in this repository, in a way that looked correct in the source.

That is the actual method: when something fails, find the shape of the failure,
write the shape down, and build the check that catches that shape rather than
that instance. The comments in this codebase are long because they carry the
incident, not the intention — a reader who knows *why* a line exists will not
delete it, and a reader who only knows what it does eventually will.
