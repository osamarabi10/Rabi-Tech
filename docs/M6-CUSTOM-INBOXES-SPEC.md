# M6.3 — Custom inboxes / saved views

Implementation spec. Last open item in M6.

---

## 0. Corrections to the brief

Four things in the request do not match this codebase. Building to the brief
verbatim would produce a schema that does not compile and a filter that cannot
run.

| Brief says | Reality | Consequence |
|---|---|---|
| `workspace_id` tenant key | **`organizationId`** — 213 occurrences in `schema.prisma`, zero of `workspace_id` | Table and column naming throughout |
| `status [OPEN/PENDING/CLOSED]` | **`OPEN \| PENDING \| RESOLVED \| AWAITING_CLIENT`** | `CLOSED` does not exist; `AWAITING_CLIENT` was omitted and is used daily |
| `channel_id` | Conversations carry **`sessionId`** → `WhatsappSession` | See below — this is a domain conflation, not a rename |
| `sla_status` | **No SLA concept exists** anywhere in the schema | Must be derived or dropped |

### `channel_id` is the ostudio bug wearing a different hat

`OrganizationChannel` is **control plane**: the gateway deployment, its base URL
and API key. `WhatsappSession` is **data plane**: a phone number that receives
messages. A conversation belongs to a *session*, never to a channel.

Conflating them is what left `ostudio` displaying FAILED for weeks while its
gateway answered 200 — the health monitor asked a session question to decide a
channel fact. A saved view filtering by `channel_id` would filter by "which
gateway deployment", which on a shared gateway is every conversation in the
workspace.

**Decision: the field is `sessionNames: string[]`** — "the number it came in
on", which is what an agent means and what `Conv.sessionName` already carries.

### SLA

Nothing stores an SLA. Two options:

- **Derive it** (recommended): `unansweredOnly` plus a threshold is the useful
  90% — "open, nobody has replied, older than N minutes". `firstResponseAt`
  already exists on `Conversation` and is stamped by `response-time.ts`.
- **Model it**: a real SLA needs per-team targets, business-hours arithmetic
  against the existing `WorkingHours`, and a breach state machine. That is its
  own phase, not a field on a saved view.

**Decision: derived. `unansweredOnly: boolean` ships; `sla_status` does not.**

---

## 1. Domain boundary

Saved views filter **conversations**. They are not saved segments.

| | Saved segment | Saved view |
|---|---|---|
| Filters | Contacts | Conversations |
| Grammar | `ContactFilterDsl` (nested `$and`/`$or`, 5 categories) | Flat criteria — see §3 |
| Consumer | Campaign audience, contacts list | Inbox column 1 |

They stay separate. A contact is a person; a conversation is a thread with a
status, an assignee and a channel. One grammar over both would mean every rule
carrying "does this apply to contacts, threads, or both", which is how a filter
builder becomes unusable.

### Integration point

`InboxScope` gains one member. It does **not** gain a parallel query path:

```ts
export type InboxScope =
  | { kind: 'system'; value: 'all' | 'mine' | 'unassigned' | 'mentions' | 'snoozed' }
  | { kind: 'lifecycle'; value: string }
  | { kind: 'team'; value: string }
  | { kind: 'view'; value: string };   // ← the view id
```

---

## 2. Traps, before any code

**2.1 `scopeMatches` is already growing positional arguments.**
Today: `scopeMatches(conv, scope, currentUserId, mentioned?)`. Views need the
view definitions too. A fifth positional parameter is how this function becomes
unreadable and how a caller silently passes the wrong thing.

*Fix first, as a separate commit:* collapse to a context object —
`scopeMatches(conv, scope, ctx)` where
`ctx = { currentUserId, mentioned, views }`. Four call sites: the pane, the
mobile menu, the inbox filter, and the counts.

**2.2 Counts are client-side, and that ceiling is already documented.**
`inbox-selector.tsx` counts from loaded conversations because the list endpoint
has no pagination. Views must evaluate the same way or the count beside a view
will disagree with the list it opens — the failure that hit the snooze counts
twice.

**Consequence: every filter field must be expressible against the `Conv` object
the client already holds.** That is the hard constraint on §3. When the list is
paginated, views move server-side *with* the other scopes, not before them.

**2.3 `Conv` is missing one field the filter needs.**
`unansweredOnly` requires `firstResponseAt`, which `Conv` does not carry. Add it
to the type and both mappers in `lib/data.ts` in the same commit as the filter,
or the criterion silently matches everything.

**2.4 Shared views are last-write-wins over a JSON blob.**
Two supervisors editing the same shared view: the second save discards the
first's changes with no indication. Either send `updatedAt` as a precondition
and 409 on mismatch, or decide explicitly that last-write-wins is acceptable at
this team size. **Decision: `If-Unmodified-Since` semantics via an `updatedAt`
body field, 409 on mismatch.** Cheap now, impossible to retrofit once people
rely on shared views.

**2.5 The filter is user input stored as JSON.**
Validated on **write**, never trusted on read. A malformed filter that reaches
the client breaks the inbox for everyone who can see that view — and a shared
view breaks it for the whole workspace. Unknown keys rejected, not ignored.

**2.6 Socket emit outside the transaction.**
Emitting inside `$transaction` broadcasts a change that can still roll back.
Every existing route in this codebase emits after commit; keep that.

**2.7 No queue, so no open handles here.** Unlike the dunning and campaign
work, this touches no BullMQ queue. Nothing to tear down.

---

## 3. Filter shape

```ts
/**
 * Every field must be answerable from a loaded `Conv` — see trap 2.2.
 */
export type InboxViewFilter = {
  /** Any-of. Empty or absent means every status. */
  status?: Array<'OPEN' | 'PENDING' | 'RESOLVED' | 'AWAITING_CLIENT'>;
  /** 'me' resolves per-viewer, so a shared view means the right thing to each. */
  assignee?: 'me' | 'unassigned' | { userIds: string[] };
  teamIds?: string[];
  /** The number it arrived on. Not the gateway — see §0. */
  sessionNames?: string[];
  /** Any-of, matching the existing label filter. */
  labels?: string[];
  lifecycleStages?: string[];
  /** `firstResponseAt === null`. Requires trap 2.3. */
  unansweredOnly?: boolean;
  /** Snoozed threads stay out unless a view asks for them. */
  includeSnoozed?: boolean;
};
```

`assignee: 'me'` resolving per-viewer is deliberate: a shared "My open threads"
view is useful to everyone, and a hardcoded user id in a shared view is a view
that is wrong for every member but one.

---

## 4. Schema

```prisma
/// A named conversation filter, private to one agent or shared workspace-wide.
model InboxView {
  id             String   @id @default(cuid())
  organizationId String
  /// Null = shared with the workspace. Set = private to that user.
  ///
  /// A nullable owner rather than a boolean + owner: it cannot express
  /// "shared but owned by someone", and the FK does the cleanup — deleting a
  /// user takes their private views and leaves the shared ones standing.
  ownerId        String?
  name           String
  /// InboxViewFilter. Validated on write; never trusted on read.
  filter         Json
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  owner        User?        @relation(fields: [ownerId, organizationId], references: [id, organizationId], onDelete: Cascade)

  @@unique([id, organizationId])
  @@index([organizationId, ownerId, sortOrder])
}
```

Migration is additive and hand-written per the standing rule — never
`prisma migrate dev`. Composite FK on `[ownerId, organizationId]` so a view
cannot be owned by a user in another organization; the tenancy gate gets two new
checks matching the `PaymentReceipt` and `ConsentEvent` pattern.

---

## 5. API

All under `/api/inbox-views`, all behind `verifyToken` + `requirePermission`.

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/` | `conversation:read` | Own private views + all shared, ordered by `sortOrder`, then `name` |
| `POST` | `/` | `conversation:read` (private) / `inbox-view:manage-shared` (shared) | Permission depends on the **body**, not the route |
| `PATCH` | `/:id` | owner, or `inbox-view:manage-shared` | `updatedAt` precondition → 409 |
| `DELETE` | `/:id` | owner, or `inbox-view:manage-shared` | |

New permission in `ROLE_PERMISSIONS`:

```ts
'inbox-view:manage-shared': new Set(['ADMIN', 'SUPERVISOR']),
```

Mirrors the segment reasoning already written into that file: anyone may create
their own, but an agent must not delete a view the whole team relies on.

**Status codes:** `404` for another organization's id (existence is
information); `403` when a non-owner without the shared permission edits a
shared view; `409` on a stale `updatedAt`; `400` with the offending key named on
filter validation failure.

---

## 6. Real-time

Event added to `SocketEvents` — never build a room string by hand, use
`socket/rooms.ts`.

```ts
INBOX_VIEW_CHANGED: 'inbox_view_changed',
```

```ts
type InboxViewChanged = {
  action: 'created' | 'updated' | 'deleted';
  viewId: string;
  /** Absent on delete. */
  view?: { id: string; name: string; filter: InboxViewFilter; sortOrder: number; shared: boolean };
};
```

Routing:

- **Shared view** → `socketRoom.organization(orgId)`. Everyone's column 1 must
  re-read; a renamed shared view showing its old name to four agents is the
  cheap version of the same disagreement problem as the counts.
- **Private view** → `socketRoom.user(orgId, ownerId)` only. Broadcasting a
  private view org-wide leaks its name and its filter.

Emitted **after** commit (trap 2.6).

---

## 7. UI

`inbox-selector.tsx` gains a fourth group, `SAVED VIEWS`, rendered on the same
`Group`/`ScopeRow` primitives with counts through `countWhere`. Shown only when
at least one view exists — same rule as Mentions and Snoozed: an agent with no
views does not need a permanent empty heading.

`inbox-scope-menu.tsx` gets the same entries, from the same source, so wide and
narrow cannot disagree.

Creating a view: the inbox already holds a live filter state (scope, status
pills, labels, search). "Save this view" captures it, exactly as "Save as group"
captures a contact selection. Editing and reordering live in the pane's own
context menu, not in settings — a view is an inbox thing.

---

## 8. Definition of done

- [ ] `scopeMatches` refactored to a context object (trap 2.1), separate commit
- [ ] `Conv.firstResponseAt` added and mapped (trap 2.3)
- [ ] Hand-written additive migration; `npx prisma migrate deploy`
- [ ] Tenancy gate green with two new checks (cross-org owner FK; no cross-org read)
- [ ] Filter validation rejecting unknown keys, with the key named
- [ ] `409` proven on a stale `updatedAt`
- [ ] Private view never emitted org-wide, proven
- [ ] Counts in pane and mobile menu agree with the list they open
- [ ] `check:i18n` and `check:mojibake` green
- [ ] Verified live: create, rename, share, reorder, delete, and a second
      session seeing a shared change arrive
