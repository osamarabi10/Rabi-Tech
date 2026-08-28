# RabiTech — Respond.io Parity Spec (UI/UX + Logic)

> Purpose: define the product target so the phase work in
> [ARCHITECTURE-MULTITENANCY.md](ARCHITECTURE-MULTITENANCY.md) builds toward a specific shape
> rather than a vague "like Respond.io."
>
> **Sourcing** (all read 2026-08-19), in order of authority:
> 1. **`respond-io/typescript-sdk`** — Respond.io's own SDK. Primary source; where it disagrees
>    with anything else, it wins.
> 2. **`respond-io/custom-channel-integration-example`** — Respond.io's own reference
>    implementation of a custom channel (ClickSend SMS). This is the exact contract a third-party
>    channel must satisfy. See §2.9.
> 3. Third-party OpenAPI profile (`api-evangelist/respond`) — useful, but it got the conversation
>    close payload wrong; corrected below.
> 4. Public docs and product pages.
>
> `achasoft/roxana-backend` ("open source respond.io") was also reviewed. It is an early-stage C#
> scaffold — `Application.Data/Models` contains only `User.cs` and `UserToken.cs` — so there is no
> domain model to borrow. Its one useful signal is architectural: it splits **WhatsApp Business**
> (Cloud API) and **WhatsApp Personal** (QR-paired, what OpenWA does) into separate background
> services *and* separate endpoint projects. That split is correct and we should copy it — see §2.10.
>
> The **logic** here is therefore grounded and quotable. The **visual layout** in §3 is
> reconstructed from public product pages and the API's implied information architecture — a
> faithful structural target, not pixel parity.

---

## 1. The vocabulary gap

Respond.io's nouns differ from ours. Adopting their vocabulary early costs nothing and saves a rename later.

| Respond.io | RabiTech today | Action |
|---|---|---|
| **Workspace** | (none — `Organization` is the only tenant) | Add workspace as a sub-tenant layer inside Organization |
| **Channel** | `WhatsappSession` | Rename → `Channel`, with `source` discriminator |
| **Contact** | `Contact` | Expand (see §2) |
| **Conversation** `open` / `close` | `ConversationStatus OPEN \| PENDING \| RESOLVED` | Map: `close` ⇐ `RESOLVED`; keep `PENDING` as ours |
| **Comment** (internal, @mentionable) | `Message.isInternal` | Promote to first-class with mentions |
| **Tag** (workspace-scoped entity) | `Conversation.labels String[]` | Promote to a real model |
| **Custom Field** | (none) | New model |
| **Lifecycle** (`Contact.status`) | `Lead.stage` | Move onto Contact |
| **Snippet** / canned response | `MessageTemplate` + `SnippetTopic` + `SnippetAttachment` | Implemented as workspace-owned Snippets with `/shortcut`, topics, variables, and files |
| **Broadcast** | `Campaign` | Rename in UI at least |
| **Closing Note** | (none) | New: required-or-optional note on close |

---

## 2. The logic model (grounded in their API)

### 2.1 Contact identity — the biggest structural gap

Respond.io addresses a contact by **`id:{id}`, `email:{email}`, or `phone:{phone}`**. A contact is
channel-independent and reachable on **many** channels (`GET /contact/{identifier}/channel`).

Ours is `Contact.phone` bound to one WhatsApp session. That is the single deepest difference, and
everything omnichannel depends on closing it.

Target `Contact`:

```
id, firstName, lastName, email, phone, language, profilePic,
countryCode, status (lifecycle), assignee, created,
tags[], customFields[{name, value}]
```

Plus a **`ContactChannel`** join: one contact ↔ many channels, each with the channel-native address
(`@c.us` for WhatsApp, page-scoped ID for Messenger, chat ID for Telegram, address for email).

**Contact merge** is a first-class operation: `POST /contact/merge` with
`{primaryContactId, secondaryContactId}` — "consolidating conversations, tags, and fields onto the
primary." Note we already have `consolidateContactThreads()` in `utils/conversation-session.ts`, but
it merges *threads*, not *contacts*. Different operation; keep both.

### 2.2 Message send routing — the rule to copy exactly

> "If `channelId` is omitted, the message is sent through **the last interacted channel**."

That one line is the heart of omnichannel UX. The agent types in one box; the platform picks the
channel. Implement it as an explicit resolver, not an implicit fallback, and surface the resolved
channel in the composer so the agent can override before sending.

### 2.3 Message content types

```
type: text | attachment | quick_reply | whatsapp_template
attachment.type: image | video | audio | file
quickReplies: [{title, payload}]
template: {name, languageCode, components}
```

`traffic: incoming | outgoing` (we have `MessageDirection` — equivalent).
`status: sent | delivered | read | failed` (we have `MessageStatus` — we also carry `PENDING`, keep it).

**We are missing `quick_reply` entirely.** It is high-value and cheap: it converts our Arabic menu
flow from "reply with a number" into tappable buttons.

### 2.4 Conversation

**Corrected against the official SDK.** The third-party OpenAPI said `closingNoteId: integer`.
The real shape is a free-text summary plus a category:

```ts
client.conversations.updateStatus('id:123', {
  status: 'close',
  category: 'Resolved',
  summary: 'Issue was resolved by providing documentation',
});

client.conversations.assign('id:123', { assignee: 456 });                  // user id
client.conversations.assign('id:123', { assignee: 'agent@example.com' });  // or email
client.conversations.assign('id:123', { assignee: null });                 // unassign
```

Three things to copy:

- **Close = `category` + `summary`.** Category drives reporting; summary is the agent's note.
  Do not build a `ClosingNote` lookup table — that was my error from the third-party spec.
- **Assignee accepts a numeric user id *or* an email string *or* `null`.** Polymorphic by design.
- **Assignee may be a human *or* an AI agent.** Model AI agents as assignable principals from the
  start — retrofitting this later means touching every assignment path.

### 2.5 Comments (internal notes)

Internal, never sent to the contact, with user mentions in a specific token syntax:

```ts
client.comments.create('id:123', { text: 'Please follow up {{@user.456}}' });
```

We have the not-sent part (`Message.isInternal`); we lack mentions and the notification they imply.

### 2.6 Space (workspace) API — tags, custom fields, channels, users

Respond.io calls workspace-level operations **Space**. Everything below is workspace-scoped, which
maps to our `Organization` (or to the workspace layer once it exists):

```ts
client.space.listUsers({ limit: 50 });     // → items[].firstName, .email, .role
client.space.listChannels();               // → items[].name, .source

client.space.createTag({
  name: 'VIP Customer', description: 'High-value customers',
  colorCode: '#FF5733', emoji: '⭐',
});
client.space.updateTag({ currentName: 'VIP Customer', name: 'Premium', colorCode: '#FFD700' });
client.space.deleteTag({ name: 'Old Tag' });

client.space.createCustomField({
  name: 'Priority', slug: 'priority', description: '...',
  dataType: 'list', allowedValues: ['Low', 'Medium', 'High', 'Critical'],
});
```

Two details worth copying exactly:

- **Tags are addressed by name, not id** — note `currentName` on update. Names are the primary key
  from the API's point of view.
- **Tags carry `colorCode` and `emoji`.** Our `Conversation.labels String[]` (max 10) has neither,
  and can't be renamed globally or reported on.
- **Custom fields are typed** (`dataType`) with `allowedValues` for list types, and carry a `slug`
  distinct from the display `name`.

### 2.7 Contact filter DSL — what powers saved views

The SDK exposes a structured query language on contact list. This is the thing behind
Respond.io's saved segment views, and it is worth copying rather than inventing:

```ts
client.contacts.list({
  search: '',
  timezone: 'UTC',
  filter: {
    $and: [
      { category: 'contactField', field: 'assigneeUserId',
        operator: 'isEqualTo', value: '123' },
    ],
  },
}, { limit: 50, cursorId: 0 });
```

`$and` / `$or` combinators over `{category, field, operator, value}` predicates. Design the
segment model around this shape from the start — it is also exactly what Broadcast audience
selection and Workflow trigger conditions need, so building it once serves three modules.

### 2.8 Message text supports variable interpolation

```
'Hello $contact.name, your order #$contact.order_id is ready!'
```

Implemented at the final outbound send boundary for standard and custom contact
fields, assignee fields, and system date/time in the workspace timezone. Unknown
variables remain literal instead of silently deleting customer-facing text. The
legacy `{{key}}` template form remains supported for existing RabiTech content.

### 2.9 The custom-channel contract — copy this exactly

This is the most valuable find. Respond.io's own reference implementation
(`respond-io/custom-channel-integration-example`, an SMS provider) reduces an entire channel
integration to **two HTTP endpoints and one shared bearer token**.

**Outbound — Respond.io calls your server:**

```
POST /message
Authorization: Bearer <CHANNEL_API_TOKEN>

{ "contactId": "+60123456789",
  "message": { "type": "text", "text": "Hello" } }

200 → { "mId": "<provider's message id>" }
400 → { "error": { "message": "401: UNAUTHORIZED" } }
```

**Inbound — your server calls Respond.io:**

```
POST https://app.respond.io/custom/webhook
Authorization: Bearer <CHANNEL_API_TOKEN>

{ "channelId": "gfd8g7fd89dgfd",
  "contactId": "<sender address>",
  "events": [
    { "type": "message",
      "mId": "<provider message id>",
      "timestamp": 1699999999000,
      "message": { "type": "text", "text": "Hi" } }
  ] }
```

Four design decisions embedded in that, all worth adopting:

1. **One endpoint, typed message union** — not one verb per message type. This supersedes the
   four-verb `ChannelProvider` (`sendText`/`sendMedia`/`sendGroup`/`sendGroupMedia`) I specced
   earlier; that shape was wrong. One `send(contactRef, message)` with a discriminated union scales
   to new message types without new methods.
2. **`events[]` is an array** — inbound is a batch envelope, so a provider can deliver several
   events in one call. Design the inbound handler as a loop from day one.
3. **`mId` is the provider's ID, returned synchronously from outbound.** That is the correlation
   key for delivery-status callbacks. Our `waMessageId` plays this role; generalize the name.
4. **Auth is a single per-channel bearer token, compared on every request** — in both directions.
   Simple, and it means a channel's credential is also its identity. This is the same shape as the
   per-org `webhookToken` in architecture doc §4.

**Timestamps are epoch milliseconds** (the example multiplies a seconds-based provider timestamp
by 1000). Normalize at the adapter boundary.

### 2.10 Split WhatsApp Business from WhatsApp Personal

Roxana models these as two separate services, and that is correct. They are different products:

| | WhatsApp Personal (QR) | WhatsApp Business Cloud API |
|---|---|---|
| Pairing | QR scan, session state on disk | Meta app + phone number registration |
| What we run | OpenWA today | — |
| Templates | none | required outside the 24h window |
| Ban risk | real | none |
| Cost | free | per-conversation pricing |

Treat them as **two providers**, not one provider with a config flag. Our OpenWA integration is
WhatsApp Personal. Any move to Cloud API for scale is a new adapter behind the same interface —
which the §2.9 contract makes cheap.

### 2.11 Outbound webhooks

Subscribable events: **new message, message status, new contact, conversation opened/closed.**
We have none. This is what makes the platform integrable, and it is a Growth-tier selling point.

### 2.12 API conventions worth copying wholesale

- **Bearer token** from `Settings > Integrations > Developer API`
- **Cursor pagination**: `{items: [], pagination: {cursorId, hasMore}}`, `limit` max 100, default 10
- **Rate limit**: 5 req/s per method, `429` + `Retry-After` header
- **Client retry**: exponential backoff, 3 retries, 30s timeout (the SDK's defaults)
- **Error taxonomy** — worth mirroring in our own error class:
  `isRateLimitError()` (with `rateLimitInfo.retryAfter`), `isNotFoundError()`, `isAuthError()`,
  `isValidationError()`, `isServerError()`
- Errors: `{message, status}`

> **Inconsistency to avoid inheriting:** contact create/update takes `custom_fields` (snake_case)
> while the Contact response returns `customFields` (camelCase). Pick camelCase everywhere.

---

## 3. UI / UX target

### 3.1 Global shell

A **left icon rail** (not our current wide sidebar), with a workspace switcher at top and these modules:

```
Inbox · Contacts · Workflows · Broadcasts · Reports · Growth · Settings
```

RTL note: for Arabic the rail sits on the **right**. Our app is already `dir="rtl"`, so build the
shell logical-property-first (`inline-start`/`inline-end`, not `left`/`right`) or the LTR tenants
will be broken later.

### 3.2 Inbox — three panes

```
┌───────────────┬──────────────────────────┬────────────────────┐
│ Conversation  │  Message thread          │  Contact sidebar   │
│ list          │                          │                    │
│               │  ┌────────────────────┐  │  Profile fields    │
│ Tabs:         │  │ channel-tinted     │  │  Lifecycle         │
│  Mine         │  │ message bubbles    │  │  Assignee          │
│  Unassigned   │  └────────────────────┘  │  Tags              │
│  All          │                          │  Custom fields     │
│               │  ── Composer ──────────  │  Channels list     │
│ Filters:      │  [channel ▾][snippet]    │  Conversation      │
│  channel      │  [attach][template]      │   history          │
│  tag          │  ( Reply | Comment )     │                    │
│  assignee     │                          │                    │
│  status       │                          │                    │
└───────────────┴──────────────────────────┴────────────────────┘
```

Behaviours that matter:

- **Reply / Comment is a toggle inside one composer**, not a separate screen. Comment mode changes
  the composer's background colour and disables the channel selector. This is the single most
  copied interaction in the category and we already have the data model for it.
- **Channel selector defaults to last-interacted** (§2.2) and shows the resolved channel explicitly.
- **Close requires (or offers) a closing note.**
- **Snippet expansion** uses `/shortcut`; the former `:code` form remains as a compatibility path. Selected Snippets can include up to five files.
- Conversation list rows: avatar, name, channel icon, last message preview, unread badge, assignee
  avatar, relative timestamp.
- Keyboard: `Ctrl/Cmd+Enter` send, `Esc` deselect, `J`/`K` move through list.

### 3.3 Contacts module

Table with column chooser, saved filter views, bulk tag/assign, CSV import/export, and a contact
detail drawer sharing the same component as the inbox sidebar. Merge action lives here.

### 3.4 Workflows

Canvas with **Trigger → Steps → Branches**. Node palette grouped: Triggers, Messaging, Logic, Data,
Integrations, AI. Draft/published versioning, and an execution log per contact. Ours must swallow
the existing Arabic menu flow as milestone 1 (see architecture doc §7 Phase 4).

### 3.5 Broadcasts

Compose → audience (tag/segment filter) → channel → schedule → review. Post-send report: sent,
delivered, read, failed, replied. We have `Campaign` + `CampaignRecipient`; mostly a UI and
reporting gap.

### 3.6 Reports

Conversations opened/closed, first response time, resolution time, messages by channel, agent
leaderboard, tag distribution. Date range + workspace filter. Our `analytics.routes.ts` covers
perhaps a third of this.

### 3.7 Growth

Channel connect wizard (QR for WhatsApp), click-to-chat link generator, QR code generator, website
widget snippet. Our QR flow already exists inside subscriber admin — this is where it belongs in a
Respond.io-shaped IA.

---

## 4. Gap summary, ranked by cost

| Gap | Cost | Notes |
|---|---|---|
| Contact ↔ many channels (`ContactChannel`) | **High** | Foundation for everything omnichannel |
| Workspace / Space layer inside Organization | **High** | Touches every scoped query again |
| Workflow engine | **High** | Phase 4; biggest single build |
| Filter DSL (§2.7) | Medium | Serves segments + broadcasts + workflow conditions — build once |
| AI agent as assignable principal | Medium | Cheap if modeled now, expensive later |
| Tags + custom fields as typed entities | Medium | Migration off `labels String[]` |
| Inbox 3-pane restructure | Medium | Our inbox page is ~1,500 lines already |
| Outbound webhooks | Medium | |
| Custom-channel contract (§2.9) | Medium | Two endpoints; also makes us integrable *by* others |
| Variable interpolation `$contact.x` / `$system.x` | **Complete** | Resolved server-side at send time, including custom fields |
| Quick replies | **Low** | High value; upgrades the Arabic menu |
| Close `category` + `summary` | **Low** | Not a lookup table — free text + category |
| Comment @mentions | **Low** | Notification plumbing exists |
| Cursor pagination + rate limits + error taxonomy | **Low** | Do it when the public API ships |

---

## 5. Sequencing warning

Two of these gaps — **`ContactChannel`** and the **workspace layer** — change the shape of nearly
every tenant-scoped table.

The architecture doc's §0 composite foreign keys are currently unchecked. If the parity model lands
first, every new table and relation has to be retrofitted with composite FKs afterward, and the
Phase 1 bleed test has to be written twice.

**Do composite FKs and socket namespacing before the parity data model.** That ordering is not
conservatism — it is the difference between adding `organizationId` to a FK once versus once per
new table.
