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

Seven methods. `ManualProvider` is a complete worked example of all of them.

| Method | Purpose |
|---|---|
| `createCheckout(orgId, planCode)` | Return a hosted payment URL + your `externalRef`. **Put `organizationId` in the provider's metadata** — the webhook has to carry it back. |
| `getCheckoutStatus(externalRef)` | Poll fallback for when a webhook is missed. |
| `changeSubscription(ref, planCode)` | Upgrade / downgrade. |
| `cancelSubscription(ref)` | Cancel. |
| `verifyWebhook(rawBody, headers)` | Verify the signature, then **map the event to a canonical `kind`** (below). |
| `listInvoices(customerRef)` | Billing history for the tenant panel. |
| `provider` | Identifier string, also stored on `Subscription.provider`. |

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

A Stripe mapping would be:

| Stripe event | `kind` |
|---|---|
| `checkout.session.completed` | `subscription_activated` |
| `invoice.payment_succeeded` | `subscription_activated` |
| `invoice.payment_failed` | `payment_failed` |
| `customer.subscription.deleted` | `subscription_canceled` |

Also set `organizationId` on the returned event (read it back out of the
provider's metadata). Without it the handler logs *"Payment event carried no
organization"* and stops — deliberately, since guessing which subscriber to
upgrade is worse than failing.

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
