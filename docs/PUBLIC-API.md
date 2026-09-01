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
| `conversations:read` | List and read conversations |
| `conversations:write` | Assign, close, reopen *(not yet implemented)* |
| `messages:read` | Read the messages in a conversation |
| `messages:send` | Send messages *(not yet implemented)* |
| `tags:read` | Read tags |
| `tags:write` | Apply and remove tags |
| `workspace:read` | `GET /me` |

`contacts:write` does **not** carry `tags:write`. Tagging is a separate grant
because a sync job that writes contact fields rarely needs to reshape the
workspace's tag vocabulary.

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

## Deliberately absent

**No `DELETE /contacts`.** The console has no contact deletion either. Deleting
a contact cascades to their conversations and every message in them — usually
the entire record of why the contact mattered. Defining those semantics for the
first time in a public API, where the caller is somebody else's script, is the
wrong place to define them. Use `PATCH` with `"archived": true`, which is what
most callers want.

**No `total` on list responses.** See above.

**No message sending yet.** Sending is not "a write to this resource": it goes
through a gateway, costs the subscriber money, counts against a quota, must
respect marketing consent, has to persist *before* it sends so a transport error
cannot lose what was written, and has to reach the agent's inbox live over a
socket. The console's reply route does all of that. The right way to expose it
is to lift that path into a service both callers share, not to write a second
one that drifts from it — so it is its own change rather than a rushed
appendix to this one.

---

## Verifying a change to this surface

```bash
cd apps/backend && npm run test:public-api
```

75 checks over HTTP against the running server, because everything that makes
this surface safe lives in the middleware chain rather than in the handlers.
Mutation-proved three times: leaking `organizationId` from the serializer,
unscoping the id lookup, and including internal notes by default each take it
red.

---

## Roadmap

P1c's remaining half adds message sending; P1d adds outbound webhooks with
HMAC-SHA256 signatures and a delivery log. See
[RESPONDIO-PARITY-ROADMAP.md](RESPONDIO-PARITY-ROADMAP.md).
