# The RabiTech public API

`/api/v1` — for a subscriber's own software. Bearer-authenticated, scoped, and
versioned in the path.

This is the contract. Everything in it is deliberate; the "why" notes exist so a
later change is made knowing what it costs somebody else's running integration.

---

## Authentication

```
Authorization: Bearer rbt_<prefix>_<secret>
```

Tokens are created in the console at **Settings → Developers → API keys**, by an
organisation admin. The full token is shown **once**, at creation, and is stored
only as a SHA-256 hash — nobody, including us, can show it again. A lost token
is revoked and replaced, not recovered.

| Property | Value |
|---|---|
| Prefix | `rbt_` + 12 hex, public, identifies the key in logs and lists |
| Secret | 48 hex (192 bits), never stored, never logged |
| Default expiry | 90 days (30 / 90 / 180 / 365 / never) |
| Max live keys | 20 per workspace |
| Revocation | Immediate, on the next request, and irreversible |

### Failures

| Status | Body `error` | Meaning |
|---|---|---|
| 401 | `invalid_token` | Missing, malformed, unknown, expired, revoked, or wrong secret |
| 403 | `insufficient_scope` | Valid key, but it does not carry the scope this endpoint needs |
| 403 | `TRIAL_EXPIRED` / `SUBSCRIBER_SUSPENDED` | The workspace's access is gated |
| 429 | — | Rate limit; see `Retry-After` |

**All five authentication failures return the same 401 body.** Distinguishing
"expired" from "revoked" from "unknown prefix" would tell an attacker which of
the three they hold. The reason is in the workspace's server log, where support
can read it.

**401 is worth retrying after fixing the credential; 403 is not.** A key that
lacks a scope will never gain it by retrying — reissue it with the scope.

---

## Scopes

A key can do only what it was granted. **An empty scope list grants nothing**,
never everything.

| Scope | Grants |
|---|---|
| `contacts:read` | Read and list contacts |
| `contacts:write` | Create and update contacts |
| `contacts:delete` | **Erase** a contact and their entire history |
| `conversations:read` | List and read conversations |
| `conversations:write` | Assign, close, reopen, label |
| `messages:read` | Read the messages in a conversation |
| `messages:send` | Send a message to a contact or into a thread |
| `tags:read` | Read tags |
| `tags:write` | Apply and remove tags |
| `workspace:read` | `GET /me` |

`contacts:write` does **not** carry `tags:write`, and it does **not** carry
`contacts:delete`. A sync job that writes contact fields rarely needs to reshape
the tag vocabulary, and almost none of them need to destroy a person's entire
conversation history — bundling those would mean every integration ever given
write access could delete, and the day one has a bug the workspace discovers what
"cascade" means.

`contacts:delete` is also a *new* scope, so no token issued before it existed can
hold it.

---

## Rate limits

120 requests per minute, **keyed by token**, not by IP.

An IP key is wrong in both directions: several integrations behind one corporate
NAT would throttle each other for reasons none of them can see, and one
integration spread across a serverless fleet would get a fresh budget per cold
start. A 429 carries `Retry-After` in seconds.

---

## Identifying a contact

One path segment, always prefixed:

```
GET /api/v1/contacts/id:clx7k2p9q0001
GET /api/v1/contacts/phone:+972501234567
GET /api/v1/contacts/email:someone@example.com
```

**The prefix is required.** `972501234567` is a plausible phone number *and* a
plausible id; guessing wrong does not produce an error, it addresses a different
contact — and on a `PUT`, overwrites someone else's record. An unprefixed
identifier is a 400 that states the grammar.

Phone numbers are normalised before lookup, so `+972-50-123-4567` and
`972501234567` find the same contact. A local number without a country code is
**rejected**, not guessed; send `defaultCountryCode: "972"` in the body if your
source data is local-format.

Email lookup is case-insensitive; addresses are stored lower-cased.

---

## Endpoints

### `GET /me` · `workspace:read`

Confirms a key works and reports what it may do. The first call to make.

```json
{
  "workspace": { "id": "...", "name": "...", "slug": "..." },
  "token": { "id": "...", "scopes": ["contacts:read"], "known": ["contacts:read"] }
}
```

### `GET /contacts/:identifier` · `contacts:read`

### `POST /contacts` · `contacts:write`

Creates. `phone` is required. **Refuses to overwrite** — an existing phone
returns `409` with the existing `contactId`, so a caller who meant upsert can
switch to `PUT` without a second lookup.

```json
{ "phone": "+972501234567", "name": "Sara", "email": "sara@example.com",
  "tags": [], "customFields": { "account_number": "A-1024" } }
```

### `PUT /contacts/:identifier` · `contacts:write`

Create or update — what most sync jobs actually want. `201` when it created,
`200` when it updated.

Creating through `email:` or `id:` needs a `phone` in the body: a contact this
product cannot message is not a contact, so it refuses rather than inventing one.

### `PATCH /contacts/:identifier` · `contacts:write`

Updates only. A missing contact is `404`, **never** a create.

> The four verbs mean four different things on purpose. Collapsing any pair is
> the most common way an integration destroys data it did not mean to touch — a
> job that means "add if new" and gets upsert semantics silently overwrites every
> field it left blank.

### `POST /contacts/list` · `contacts:read`

A POST for a read, because the filter grammar nests arbitrarily deep and a query
string cannot carry that without inventing an encoding every client must then
implement.

```json
{ "limit": 50, "cursorId": "...", "includeArchived": false,
  "filter": { "$and": [ { "field": "lifecycleStage", "operator": "isEqualTo", "value": "customer" } ] } }
```

The filter grammar is the same one the console's segment builder uses — richer
than Respond.io's — and the same validator, so a filter that works in a saved
segment works here unchanged. `GET /api/contacts/filter-schema` (console auth)
describes the available fields and operators.

Cursor pagination: pass back `pagination.cursorId` while `pagination.hasMore`.
There is no `total` — counting the whole filtered set on every page is a table
scan the caller pays for and rarely reads.

### `POST /contacts/:identifier/tags` · `tags:write`

`{ "tag": "vip" }` or `{ "tags": ["vip", "arabic"] }`. Creates the tag if the
workspace does not have it — a sync job that must create tags in a separate call
with separate error handling is a sync job that half-applies its tags.
Assignments are recorded with source `API`, so an operator can tell an automated
tag from one a colleague applied.

### `DELETE /contacts/:identifier/tags/:tag` · `tags:write`

Removing a tag the contact does not have is a success, not a 404 — a retrying
client must be able to converge without special-casing "already gone".

### `GET /conversations` · `conversations:read`

Query: `limit` (max 100), `cursorId`, `status` (`OPEN`/`PENDING`/`RESOLVED`),
`contactId`, `assigneeId`, `includeArchived`.

Ordered by `lastMessageAt` descending, tie-broken by id so cursor pagination
never skips or repeats a row when two threads share a timestamp — which happens
constantly during an import.

### `GET /conversations/:id` · `conversations:read`

```json
{ "id": "clx...", "displayId": 1042, "status": "OPEN",
  "contact": { }, "assignee": { "id": "...", "name": "..." },
  "team": { "id": "...", "name": "..." }, "labels": [],
  "archived": false, "snoozed": false, "snoozedUntil": null,
  "openedAt": "...", "lastMessageAt": "...", "firstResponseAt": "...",
  "resolvedAt": null, "createdAt": "...", "updatedAt": "..." }
```

`displayId` is the number an agent reads on screen; `id` is what the API takes.
Both are published, because an integration filing a support ticket has to name
the thread in a way a human can find.

`snoozed` is derived server-side. `snoozedUntil` in the past means *not
snoozed*, and a caller comparing clocks gets that wrong half the time.

Internal scheduling columns — `sessionId`, `autoCloseAt`, `autoCloseEligible`,
`pendingMenuChoice` — are not published. They describe how this product runs its
own queues and change whenever that does.

### `GET /conversations/:id/messages` · `conversations:read` **and** `messages:read`

Newest first. Query: `limit`, `cursorId`, `includeInternal`.

**Internal notes are excluded by default.** They are agent-to-agent and were
never sent to the customer, so a caller building a transcript gets a transcript
rather than having to remember to filter — otherwise an integration quotes an
agent's private note back to the person it was written about. Pass
`includeInternal=true` to see them; each message carries `"internal": true`.

Both scopes are required. A reporting integration that counts open threads per
team has no business reading what customers wrote in them.

```json
{ "id": "...", "conversationId": "...", "direction": "INBOUND",
  "status": "DELIVERED", "body": "…", "mediaUrl": null, "mediaType": null,
  "internal": false, "automated": false,
  "sentBy": null, "failureReason": null, "timestamp": "..." }
```

### `POST /contacts/:identifier/messages` · `messages:send`

Send to a person. `{ "text": "Your order has shipped." }`

Resolves the thread through the same function the inbound webhook uses, so the
message lands in the thread the agent is already reading, reopens a resolved one
rather than starting a parallel history, and obeys the one-thread-per-contact
rule the product is built on. It then goes through the same send path as the
console's reply box: it persists, stamps analytics, restarts the auto-close
clock, and appears live in the agent's inbox. An integration whose messages are
invisible in the inbox is how an agent ends up answering a customer who was
already answered.

### `POST /conversations/:id/messages` · `messages:send`

The same, addressed to a thread instead of a person.

**Three refusals the console does not make (403):**

| `error` | Why |
|---|---|
| `contact_opted_out` | `OPTED_OUT` is a marketing opt-out and the API cannot know whether a given message is marketing. The workflow engine takes the same line — *a workflow is not an exemption from consent* — and an integration is the same kind of actor. |
| `contact_blocked` | Blocking exists because a number will not stop writing, or there is a dispute. Outbound stays open in the console so an operator can send a final message; nothing in that reasoning extends to a script. |
| `contact_archived` | The contact was deliberately taken out of circulation. |

In all three an agent can still reply from the inbox, where the judgement is
being made by someone accountable for it.

`isInternal` is **not accepted**. A note is addressed to colleagues by name and a
token has no name to sign it with; a note from "nobody" is worse than no note.

**Status codes.** `201` sent. `202` recorded but the gateway refused — the message
row exists, is visible in the inbox as FAILED with a reason, and can be retried
there, so this is deliberately not a 5xx that would send a well-behaved client
into a retry loop delivering duplicates. `402` the workspace plan or quota does
not currently allow the send.

### `PATCH /conversations/:id` · `conversations:write`

`{ "status": "RESOLVED", "assigneeId": "...", "labels": ["urgent"],
   "closingCategoryId": "...", "closingSummary": "..." }`

Closing goes through the lifecycle service, never a status column: it writes an
immutable closure row, applies the workspace's closing-notes policy, and cancels
the auto-close job. A bare status write would close the thread in the list while
every report that reads closures still believed it open. The closure is recorded
with source `API`, so a supervisor can separate threads an integration closed
from ones an agent did.

Reopening advances the thread's `openedAt` and starts a new episode, preserving
the earlier closure rows.

If the workspace requires a closing category or summary, that policy applies to
the API too — you get a `400` naming it rather than a closure the reports cannot
categorise.

### `DELETE /contacts/:identifier` · `contacts:delete`

Erasure. Deletes the contact, **their conversations, and every message in them.**

Three guards, each closing a different way this goes wrong:

1. **Its own scope**, never part of `contacts:write`.
2. **A dry run by default.** Without `confirmConversations`, nothing is deleted —
   you get `409` and a `willDelete` block with the counts. You learn the cost by
   asking, not by paying it.
3. **The number must match.** `confirmConversations` has to equal the current
   count. If a conversation opened since your dry run, the delete is refused with
   the new number, so nobody erases more than they looked at.

```
DELETE /api/v1/contacts/phone:+972501234567
→ 409 { "error": "confirmation_required",
        "willDelete": { "conversations": 3, "messages": 214 } }

DELETE /api/v1/contacts/phone:+972501234567   { "confirmConversations": 3 }
→ 200 { "deleted": { "conversations": 3, "messages": 214 } }
```

There is no soft delete: `archived` already means "hidden but retained", and a
second, softer delete would leave a workspace unable to answer *is this person's
data gone* with a yes. The erasure is logged — the one record that outlives the
contact, so "did we honour that request" stays answerable.

---

## The contact object

```json
{
  "id": "clx...", "phone": "+972501234567", "email": "sara@example.com",
  "name": "Sara", "firstName": null, "lastName": null,
  "language": null, "countryCode": null, "lifecycleStage": "customer",
  "assignee": { "id": "...", "name": "..." },
  "notes": null, "archived": false, "blocked": false,
  "marketingConsent": "OPTED_IN",
  "tags": ["vip"], "customFields": { "account_number": "A-1024" },
  "createdAt": "...", "updatedAt": "..."
}
```

The field list is explicit and will not silently grow. Internal columns — the
tenant id, `blockedById`, `consentSource`, `profilePic` — are never published.

### Masked keys

If a key was created by a user whose contact details are masked, `phone` and
`email` come back as `••••••` and the object carries `"masked": true`.

A token must not see what the person who minted it cannot. The flag is fixed at
creation and shown on the key in the console. `"masked"` is present so a caller
can tell *hidden from you* from *not set* — without it, an integration writes
over a value it was never allowed to see.

---

## Consent

`marketingConsent` accepts `UNKNOWN`, `OPTED_IN`, `OPTED_OUT` on `POST`, `PUT`
and `PATCH`. It is not a plain column write: the change is recorded with source
`api` and a history row, so "who changed this and when" stays answerable. **An
`OPTED_OUT` contact is excluded from every broadcast, always.**

---

## Errors

```json
{ "error": "invalid_request", "message": "…", "details": { } }
```

| `error` | Status |
|---|---|
| `invalid_token` | 401 |
| `insufficient_scope` | 403 |
| `not_found` | 404 |
| `already_exists` | 409 (carries `contactId`) |
| `invalid_request` | 400 (may carry `details`) |
| `server_error` | 500 |

Messages are English — the reader is an integrator reading a log, not an agent
reading a screen. The console's own API answers in Arabic for the same reason
inverted.

---

## Webhooks

Configured in the console at **Settings → Developers → Webhooks**. We POST a
signed JSON body to your URL whenever a subscribed event happens.

### Verifying a delivery — do this before trusting anything

```
X-RabiTech-Signature: t=1730000000,v1=<hex hmac-sha256>
X-RabiTech-Event:     message.received
X-RabiTech-Delivery:  whd_<hex>
```

The signature is `HMAC-SHA256("<timestamp>.<raw body>", secret)`.

**The timestamp is part of what is signed, and that is the point.** A signature
over the body alone proves the body came from us and nothing about *when* —
anyone who captures one valid request can replay it forever and every replay
verifies. Reject deliveries whose `t` is more than five minutes from your clock.

Compare in constant time, and verify against the **raw** body bytes: a body that
has been parsed and re-serialised is a different string and will not match.

`v1` is versioned so a future scheme can ship alongside this one rather than
replacing it mid-flight.

### Events

| Event | Fires when |
|---|---|
| `contact.created` | A contact appears — a stranger writes in, or one is created through the API |
| `contact.updated` | Contact fields change, from the console or the API |
| `contact.tagged` | Tags are applied |
| `contact.lifecycle_updated` | The lifecycle stage moves — its own event, because this is what most automations wait for |
| `contact.consent_updated` | Marketing consent changes, with `from` and `to` |
| `conversation.opened` | A thread is created. `isFirstEver` distinguishes a new customer from a returning one |
| `conversation.assigned` | Auto-assignment claims a thread |
| `conversation.closed` | A thread is resolved, with the closing `source` |
| `conversation.reopened` | A resolved thread starts a new episode |
| `message.received` | A customer message arrives |
| `message.sent` | An outbound message is delivered. Internal notes never fire this |

### The envelope

```json
{ "id": "whd_...",
  "event": { "id": "evt_...", "type": "message.received", "occurredAt": "..." },
  "workspace": { "id": "..." },
  "data": { } }
```

`id` is per **delivery attempt**; `event.id` is per **occurrence**. A retry
repeats `event.id` with a new `id` — that pair is what lets you deduplicate.
Without it you cannot tell "we sent this twice" from "it happened twice", and an
order gets shipped again.

Fan-out shares the event id too: three endpoints subscribed to the same event
get three deliveries and one `event.id`.

### Retries

**30s, 60s, 90s** — four attempts in total. Any 2xx is success.

Linear rather than exponential on purpose: your endpoint is usually a small
server or a serverless function, and what is being recovered from is a deploy or
a restart. An exponential ladder would still be retrying tomorrow, long after the
event stopped being useful.

A **4xx is not retried** — it means the request itself is wrong and repeating it
changes nothing. The exceptions are `408` and `429`, which explicitly say "try
again". Return a 2xx quickly and do your work asynchronously; we time out at 10
seconds.

### Auto-deactivation

**30 failed deliveries within 30 minutes** switches the endpoint off.

Failures, not *consecutive* failures — an endpoint alternating success and
failure thirty times in half an hour is broken in a way a consecutive counter
would never fire on.

The console shows **why and when**, on the endpoint itself, with one button to
turn it back on. Re-enabling clears the reason: a stale "turned off after 30
failures" sitting on a working endpoint is worse than no message.

### The delivery log

Every attempt is recorded with its status code, latency, attempt number, and the
first 2 KB of the response body — visible in the console, filterable to failures
only, refreshable, and with a **Send test** button so you can check a URL without
waiting for a real event.

This is the piece Respond.io does not have; it is an open feature request against
them. Without it, "did you send it?" is unanswerable by both parties.

### Restrictions

HTTPS only in production, and private or loopback addresses are refused. Without
that, a webhook endpoint is a request-forgery primitive: point it at an internal
address, have our server make the request from inside our network, and read the
response back out of the delivery log.

The signing secret is stored in clear, unlike an API token — HMAC needs the same
secret at both ends, so hashing it would make signing impossible. It is shown
once, rotatable, and scoped to one endpoint. **Rotation is immediate**: the old
secret verifies nothing the moment you rotate.

Ten endpoints per workspace.

---

## Deliberately absent

**No `DELETE /contacts`.** The console has no contact deletion either. Deleting
a contact cascades to their conversations and every message in them — usually
the entire record of why the contact mattered. Defining those semantics for the
first time in a public API, where the caller is somebody else's script, is the
wrong place to define them. Use `PATCH` with `"archived": true`, which is what
most callers want.

**No `total` on list responses.** See above.

**No internal notes through the API.** See the messaging section.

**No soft delete.** See `DELETE` above.

---

## Verifying a change to this surface

```bash
cd apps/backend && npm run test:public-api   # 103 checks, over HTTP
cd apps/backend && npm run test:webhooks     # 52 checks, hermetic
```

103 checks over HTTP against the running server, because everything that makes
this surface safe lives in the middleware chain rather than in the handlers.
Mutation-proved three times: leaking `organizationId` from the serializer,
unscoping the id lookup, and including internal notes by default each take it
red.

---

## Roadmap

See
[RESPONDIO-PARITY-ROADMAP.md](RESPONDIO-PARITY-ROADMAP.md).
