# API contracts added in U2 and U6

Endpoints introduced by the UI phases, with the reasoning that constrains them.
Existing endpoints are not repeated here.

All tenant routes are scoped by the fail-closed tenancy extension — a request
carries its organization through `AsyncLocalStorage` and the extension injects
`organizationId` at the top level of `where`. Platform routes run under
`runAsPlatform`, which skips injection entirely, so every one of them scopes by
hand and is audited.

---

## U2 — Conversation activity

### `GET /api/conversations/:id/activity`

The Activity tab in the contact panel: what happened to this conversation, as
opposed to what was said in it.

Merges two sources that had never been read together:

- `AuditLog` rows for this conversation — this endpoint is their first consumer.
  They were written from day one and displayed nowhere.
- Messages with `isAuto: true` — an automatic reply is an event, not a
  contribution to the conversation, and reading it in the thread as if an agent
  wrote it is misleading.

**Response**

```jsonc
[
  {
    "kind": "audit" | "automated",
    "action": "opened" | "assigned" | "resolved" | "reopened" | "pending"
            | "updated" | "message-retried" | "welcome" | "csat" | "auto_reply" | "...",
    "actorName": "string | null",   // null on an automated event
    "at": "ISO-8601"
  }
]
```

`action` has the `conversation.` prefix stripped: the caller already knows what
resource it asked about, and the prefix only makes the label harder to map.

**404** on an unknown id. Not 403 — existence is information, and the tenancy
extension has already made a cross-organization id unreachable.

---

### `GET /api/contacts/:id/consent`

Where a contact's marketing consent came from. Its own endpoint rather than a
field on the contact: the panel asks for it when the Details tab is open, and
every other consumer of a contact — the list, the audience preview, the
campaign worker — has no use for a history it would pay to load on every row.

```jsonc
{
  "current": "UNKNOWN" | "OPTED_IN" | "OPTED_OUT",
  "source": "keyword | agent | import | api | null",   // from the Contact row
  "updatedAt": "ISO-8601 | null",
  "history": [
    {
      "id": "...",
      "fromValue": "UNKNOWN | null",   // null on the first recorded change
      "toValue": "OPTED_OUT",
      "source": "agent",
      "actorName": "string | null",    // null for a keyword or an import
      "at": "ISO-8601"
    }
  ]
}
```

`source` and `updatedAt` come from the `Contact` row, which predates the
history table. A contact whose consent was last set before `ConsentEvent`
existed has a source and a date and no event — reported honestly rather than
shown as never set.

### `ConsentEvent`

New table (`20260831090000_consent_events`). Composite unique
`[id, organizationId]` and a composite FK onto `Contact(id, organizationId)`;
both covered by the tenancy gate.

`Contact` already carried the current value, its source and its date. What it
could never answer was *who*, and each change overwrote the last — which is
why the contact panel showed a consent control with no provenance beside it.
"This customer opted out" is a claim a business may have to stand behind.

Written by both consent paths through one function in `src/utils/consent.ts`:
a customer's keyword (no actor — they sent it themselves) and an agent's
toggle (actor id and name). `actorName` is denormalised so the record stays
readable after the user is deleted; an audit trail that becomes a dangling id
is not an audit trail.

A no-op toggle writes nothing — an agent opening the dropdown and picking the
value already set has not changed anything, and a history full of those is a
history nobody reads.

The history write is deliberately **not** fail-closed, unlike the rest of the
consent machinery: refusing a customer's STOP because an audit row failed to
write would be the worse outcome by a distance.

---

## U5 — Delivery failure and retry

### `POST /api/conversations/:id/messages/:messageId/retry`

Re-attempt one failed outbound send.

Permission: `conversation:create`.

**Why it updates rather than re-sends.** The reply route persists the message
*before* it calls the gateway, precisely so a transport error cannot lose what
the agent wrote. That means a message marked FAILED may already have been
delivered — the failure could have happened after delivery — so creating a
second row would put the same text in front of the customer twice. Retry updates
the existing row.

It is audited as `conversation.message-retried`. It is the one conversation
action that can repeat a customer-facing message, so "who pressed it, and when"
has to be answerable.

**Guards**, in order:

| Condition | Status |
|---|---|
| Message unknown, or belongs to a different conversation | `404` |
| Inbound, or an internal note | `400` — it does not go over WhatsApp at all |
| Not currently `FAILED` | `409`, with the current `status` in the body |
| Gateway refused the send | `502`, with `error`, `code`, `retryable` |
| Plan quota exceeded | the quota status and body, unchanged |

The conversation is checked as well as the message id: without it, a message id
from another thread could be retried through this thread's route.

**On failure** the classified reason is written to `Message.failureReason` even
though the status stays FAILED, so the bubble updates to say what went wrong
this time.

### `Message.failureReason`

New nullable column (`20260829090000_message_failure_reason`). Holds the reason
in the words the agent is shown. NULL on anything that has not failed, and on
failures that predate the column.

Classified by `src/utils/send-failure.ts` into `channel-down`,
`not-on-whatsapp`, `media-rejected` or `unknown`, each with a sentence and a
`retryable` flag. The classifier reads **every** field the gateway might have
used, not the first non-null one: OpenWA answers a send to an unstarted session
with `{ error: 'Bad Request', message: "Session '…' is not active" }`, and the
useless field was shadowing the useful one.

The stored sentence is an Arabic source string, i.e. a dictionary key, and the
UI passes it through `t()` — a Hebrew or English workspace must not get one
Arabic sentence inside it.

---

## U6 — Platform finance

Every route below requires a platform **owner** session (`requirePlatformOwner`)
and writes a `PlatformAuditLog` row. A platform owner holds no `User` row in the
subscriber's organization, so the tenant-scoped `AuditLog` cannot carry these.

Verified live: anonymous `401`, tenant admin `403` on read, issue and export.

### Documents are not tax documents

No fiscal numbering sequence, no VAT breakdown, no jurisdiction, and nothing in
the rendered output labelled `חשבונית מס` or `فاتورة ضريبية`. References
(`INV-2026-XXXX-0001`, `RCPT-…`) are sequential per subscriber so they can be
quoted back in correspondence; a gap means an abandoned draft and nothing more.
The rendered page says so, and the disclaimer prints.

### `GET /api/platform/subscribers/:id/finance`

```jsonc
{
  "subscriber": { "id": "...", "name": "...", "ownerEmail": "string | null" },
  "documents": [
    {
      "kind": "invoice" | "receipt",
      "id": "...", "reference": "INV-2026-AB12-0003",
      "status": "OPEN" | "PAID" | "...",
      "amountCents": 4900, "amountPaidCents": 2000, "currency": "USD",
      "issuedAt": "ISO-8601",
      "effectiveAt": "ISO-8601 | null",   // due date on an invoice, payment date on a receipt
      "method": "bank_transfer | cash | card | other | null",
      "note": "string | null"
    }
  ],
  "outstandingCents": 2900
}
```

Both kinds in one list, newest first. A receipt and the invoice it settles are
the same event a few days apart; two lists would leave the reader interleaving
them by eye.

`ownerEmail` is the workspace's founding ADMIN, resolved through `Identity` —
`Organization` has no owner email of its own, and the address lives on Identity
because a person signs in once and may hold a User row in several workspaces.

### `POST /api/platform/subscribers/:id/invoices`

```jsonc
{ "amountCents": 4900, "currency": "USD", "dueAt": "2026-09-30 | null" }
```

`amountCents` must be a positive **integer**. A price typed as 49.99 and parsed
as a float is 4998.999… cents, and a ledger that rounds is a ledger that
eventually disagrees with the bank. `400` on anything else.

Audited as `platform.invoice.issued`.

### `POST /api/platform/subscribers/:id/invoices/:invoiceId/payments`

```jsonc
{
  "amountCents": 2000,
  "method": "bank_transfer",
  "externalRef": "string | null",
  "note": "string | null",
  "paidAt": "ISO-8601 | omitted (defaults to now)"
}
```

Records the payment and issues the receipt **in one transaction**. A receipt
without the invoice update claims money the invoice still shows as owed; an
invoice marked paid without a receipt loses how it was settled. Either half
alone is worse than neither.

| Condition | Status |
|---|---|
| Invoice not found for this subscriber | `404` |
| Already settled | `409` |
| Amount not a positive integer | `400` |
| Amount exceeds the balance | `400`, naming the balance |

Overpayment is refused rather than absorbed: a number larger than the balance is
nearly always a typo, and recording it leaves the ledger claiming a credit
nobody granted.

A part payment leaves the invoice `OPEN` with `amountPaidCents` set. There is
deliberately no `PARTIAL` status — nothing else in the system reads one.

Audited as `platform.payment.recorded`.

### `GET /api/platform/subscribers/:id/finance/:kind/:documentId`

`kind` is `invoice` or `receipt`. Returns a self-contained printable HTML
document as `Content-Disposition: attachment`.

**HTML rather than a generated PDF, deliberately.** pdfkit does not shape Arabic
or Hebrew without a text-shaping layer bolted on — an Arabic receipt would come
out as disconnected reversed glyphs, which is worse than no receipt. The browser
shapes correctly and prints to PDF on every platform. Attachment rather than
inline because this is a document the owner keeps, and a page that merely opens
in a tab is one refresh away from gone.

Every interpolated value is HTML-escaped: workspace names and payment notes are
typed by people, and a document that renders as HTML executes whatever is in
them.

Issuer name comes from `PLATFORM_ISSUER_NAME` (defaults to `RabiTech`).

### `GET /api/platform/subscribers/:id/finance-export.csv`

The whole ledger as CSV. Quoted with doubled inner quotes — a workspace called
`Ali "Abu" Trading` would otherwise split into three columns — and prefixed with
a UTF-8 BOM so Excel does not open every Arabic and Hebrew name as mojibake.

Amounts are in major units here: this file is opened in a spreadsheet by a
person, not parsed by the code that stores cents.

Audited as `platform.finance.exported` — an export is a copy of the ledger
leaving the system.

### `PaymentReceipt`

New table (`20260830090000_payment_receipts`).

Composite unique `[id, organizationId]`, and a composite FK onto
`Invoice(id, organizationId)` — a receipt cannot point at another
organization's invoice because the database will not allow it. Both are covered
by the tenancy gate (65/65).

`method` is free text rather than an enum: the platform owner settles however
they settle, and a new method must not need a migration to record.
