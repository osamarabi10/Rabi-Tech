# Wiring a payment provider

Online payment is deliberately **not** live yet. Everything around it is, so
switching it on is a contained job. This file is the whole map.

Status: `PAYMENT_PROVIDER=manual`. A paid signup lands on
`/contact-us-to-activate`, and a human activates the workspace from the platform
console. Everything *after* activation is already automatic.

---

## What already works, unattended

Verified end-to-end on 2026-08-20 with a signed test webhook:

```
signed webhook  →  HTTP 200 {"processed":true}
                →  Organization.tier  FREE → GROWTH
                →  queueGatewayAction(orgId, 'provision')   ← gateway starts itself
```

So the moment a provider says "paid", the subscriber is upgraded and their
WhatsApp gateway begins provisioning with no human involved. The only manual
step left in the whole chain is taking the money.

---

## What you implement

One file: a class satisfying `PaymentProvider` in
`apps/backend/src/modules/billing/payment-provider.ts`, then one line in
`provider-registry.ts`.

```ts
if (provider === 'stripe') return new StripeProvider();
```

The interface declares seven members. **Three of them make a paid signup reach
ACTIVE; two more complete the lifecycle; two are never called by anything.**
This distinction used to be missing from this page, and following it as a flat
list meant writing two methods nothing invokes.

`ManualProvider` is a worked example of all seven; `StripeProvider` is a worked
example of the three that matter first.

| Member | Status | Purpose |
|---|---|---|
| `provider` | **required** | Identifier string, stored on `Subscription.provider` and `Invoice.provider`. |
| `createCheckout(orgId, planCode)` | **required** | Return a hosted payment URL + your `externalRef`. **Put `organizationId` *and* `planCode` in the provider's metadata** — the webhook has to carry both back. |
| `verifyWebhook(rawBody, headers)` | **required** | Verify the signature over the raw bytes, then **map the event to a canonical `kind`** (below). |
| `getCheckoutStatus(externalRef)` | lifecycle | The poll fallback `reconcileBilling` depends on. Stub it and a dropped webhook becomes a customer who paid and was never activated, recoverable only by someone noticing. |
| `cancelSubscription(ref)` | lifecycle | Called from `cancelCurrentSubscription`, but **only when `subscriptionRef` is set**. |
| `changeSubscription(ref, planCode)` | **never called** | Every plan change goes through `activateManualSubscription`, which rewrites the local row and never tells the provider. Kept on the interface because it is the right home for that missing propagation — see D-18. |
| `listInvoices(customerRef)` | **never called** | The tenant panel reads local `Invoice` rows. |

Implement the three required members first and stop. That alone is a paid
signup reaching ACTIVE with nobody clicking anything, which is the only
milestone worth measuring. Throw from the rest rather than returning something
plausible — a `getCheckoutStatus` that always answers `pending` disables the
fallback silently, and a `cancelSubscription` that does nothing lets the local
row read CANCELED while the provider keeps charging.

### The one thing that is easy to get wrong

`verifyWebhook` must set `kind`, not just `type`.

`type` is your provider's own name for the event and is kept only for the audit
trail. `kind` is what `billing.service.ts` actually dispatches on:

```ts
type PaymentEventKind =
  | 'subscription_activated'   // → activates the plan AND provisions the gateway
  | 'payment_failed'           // → marks past due
  | 'subscription_canceled'    // → cancels
  | 'unknown';                 // → logged and ignored
```

Return `kind: 'unknown'` and the event is recorded and then **silently does
nothing**. That was the original shape of this code — the service branched on
literal `manual.*` strings, so any real provider would have logged
"Unhandled payment event type" and never activated anybody. Mapping now lives in
the provider, where the vocabulary is known.

The Stripe mapping, as shipped in `stripe.provider.ts` — and note what is
**deliberately absent**, because an earlier version of this table mapped all
four and two of them are traps:

| Stripe event | `kind` | Why |
|---|---|---|
| `checkout.session.completed` | `subscription_activated` | The one that activates. |
| `invoice.payment_succeeded` | *(unmapped → `unknown`)* | This is the **renewal** event. Mapping it to `subscription_activated` calls `activateManualSubscription` every month, which runs `applyPlanLimits` and **overwrites `OrganizationConfig`** — silently resetting any negotiated per-subscriber quota, once a month, for as long as they keep paying. See D-14 and D-20. Stripe still takes the money; we take no action. |
| `invoice.payment_failed` | *(unmapped → `unknown`)* | Routes to `markPaymentFailed`, which suspends the organization **immediately, with no grace**, while Stripe retries a failed invoice over several days. Reacting to the first failure suspends a customer whose card succeeds on the retry. If mapped at all, only the terminal failure (`next_payment_attempt === null`) — and that is a product decision about grace. |
| `customer.subscription.deleted` | `subscription_canceled` | Stage 2. Note `cancelCurrentSubscription` calls **back** into `provider.cancelSubscription`, so a cancellation arriving from the provider makes us ask the provider to cancel. |

### Metadata: both fields, or nothing activates

Set **`organizationId` and `planCode`** on the returned event, read back out of
the provider's metadata.

Without `organizationId` the handler logs *"Payment event carried no
organization"* and stops — deliberately, since guessing which subscriber to
upgrade is worse than failing.

Without `planCode`, or with one that does not equal the plan recorded on the
subscription, the event **parks in `MANUAL_REVIEW`** with a
`PAYMENT_EVENT_NEEDS_REVIEW` alert and activates nothing. It must be *our* code,
never the provider's price or product id: translating `price_1abc` into `GROWTH`
is the provider's job, inside `verifyWebhook`, exactly as `type → kind` is.

**Write the metadata in both places the provider offers.** With Stripe, session
metadata reaches `checkout.session.completed` and *subscription* metadata
reaches every later `invoice.*` and `customer.subscription.*` event. Set only
the first and activation works while every subsequent event parks — which
presents as an intermittent fault rather than a missing field, and is the single
most likely way to get this integration wrong.

### Raw body

`/api/billing/webhook` is mounted with `express.raw()` **before** the JSON body
parser (`index.ts`). Signature verification needs the exact bytes; parsing and
re-serialising breaks every provider's HMAC.

---

## Environment

Already plumbed through `docker-compose.yml`:

```
PAYMENT_PROVIDER=manual          # your identifier string
PAYMENT_WEBHOOK_SECRET=<secret>  # without this EVERY webhook is rejected as unsigned
APP_BASE_URL=http://localhost:8080
FRONTEND_PUBLIC_URL=http://localhost:8080
```

`APP_BASE_URL` is what success/cancel redirects are built from, so it must be the
customer-facing origin, not localhost, in production.

---

## Replay safety

Handled for you. `PaymentEvent` has a unique constraint on
`(provider, eventId)`, and the handler returns `{duplicate:true}` on a repeat.
Providers retry aggressively; a subscriber will not be double-upgraded.

---

## Before going live

- Point the provider's webhook at `https://<your-domain>/api/billing/webhook` —
  needs TLS, which is still outstanding.
- Set `APP_BASE_URL` / `FRONTEND_PUBLIC_URL` to the real origin.
- Business entity and VAT registration. If that is the blocker, a
  merchant-of-record (Paddle, Lemon Squeezy) sells on your behalf and handles
  tax; a direct gateway (Stripe, or an Israeli processor) does not.
- Replace the copy on `/contact-us-to-activate`, which currently tells the
  customer a person will contact them.
