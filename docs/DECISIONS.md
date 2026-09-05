# Decisions

Choices that are deliberate, that someone may later mistake for an oversight, and
that carry a consequence worth naming before it is discovered.

A decision belongs here when removing the thing it describes would look like a bug
report. **Every entry carries an owner, a trigger that says what unblocks it, and the
named place the resolution lands.** An entry missing any of the three is a note, not a
decision.

---

## D-1 · A paid signup has full product access before its payment is verified

**Decided 2026-09-04, with the removal of manual activation.**

### What changed

`Organization.status = 'PENDING'` was the manual-activation queue: a new organization
could not be logged into until a staff member pressed a button. That state is gone —
organizations are `ACTIVE` from creation, self-serve and staff-created alike.

The gate that actually stopped people was not where anyone would look for it. Email
verification read the **subscription** status and left the organization `PENDING`
unless it was `ACTIVE` or `TRIALING`:

```ts
status: ACCESS_GRANTING_SUBSCRIPTION_STATUSES.includes(
  row.organization.subscriptions[0]?.status ?? '',
) ? 'ACTIVE' : row.organization.status,
```

So `MANUAL_REVIEW` — a billing state, downstream of a payment-provider decision —
silently became the gate on logging in, from inside an email-verification side effect.
That ternary is deleted. Verification records that an address is real and decides
nothing about access.

### The consequence, stated plainly

**A subscriber who signs up on a paid plan, whose payment has not been verified, now
has full access to the product.** Their subscription still lands `MANUAL_REVIEW` and
that status is untouched — it simply no longer gates anything.

This is accepted, not overlooked. The alternative was keeping a login-time 403 that
told the customer nothing, offered no next step, and blocked the route to the payment
page — a paywall that locks the customer out of paying you.

- **Owner:** UnKnowan
- **Trigger:** the payment-provider decision.
- **Lands in:** `apps/backend/src/middleware/access-gate.middleware.ts`, as an
  allow-listed check with a reason code — **never a login 403.**

That file already answers "is this subscriber entitled to be here" for suspensions and
expired trials, runs on every authenticated tenant request inside tenant context, and
carries `ALLOWED_WHEN_GATED` so a gated organization can still reach `/billing`. When
this change was investigated it checked **neither** `PENDING` nor `MANUAL_REVIEW` — the
component named for the decision was not making it, which is the condition this entry
exists to stop recurring.

---

## D-2 · No email is delivered, by anything

The only mail provider is `LogMailProvider`, whose `delivers: false` is deliberate and
surfaced. A real SMTP provider is installed at boot **only** when the environment
supplies one, and no SMTP key is set.

### What this actually costs

- **Support layer two ships undeliverable.** Tickets can be raised and queued; the
  reply channel is email, and email does not leave the building.
- **Password resets are undeliverable.**
- **Dunning notices and suspension warnings are undeliverable** — a customer's service
  can stop without the warning that was supposed to precede it.
- **Email verification is not currently verifying an address.** Signup works only
  because the verification link is rendered on screen (`signup/page.tsx:121`), which
  means anyone can verify an address they do not control.

The code is honest about all of this; the gap is configuration, not correctness.

- **Owner:** UnKnowan
- **Trigger:** the domain and provider decision — they move together, because
  deliverability needs DNS (SPF/DKIM) on a domain that is chosen at the same time.
- **Lands in:** the mail provider configuration — `smtpProviderFromEnv()` in
  `apps/backend/src/workers/mail-outbox.worker.ts` and the corresponding `.env` keys.

---

## D-3 · Usage limits are sold but almost never enforced

Plans are priced on Monthly Active Contacts. **MAC is never enforced anywhere.**

`assertMetricAvailable` is called in exactly one place — campaigns
(`campaigns.routes.ts:377-378`, for `messages_outbound` and `campaign_sends`).
`assertSeatAvailable` is called once, when adding a user
(`system.routes.ts:623`). The one-to-one reply path checks nothing.

Worse than the absence: `downgradeGraceReason` tells the customer *"Outbound is blocked
until usage is reduced or plan is upgraded"* (`billing.service.ts:713`). Nothing blocks
outbound. The product states a restriction it does not apply.

**The MAC definition, verbatim, so it stops being re-derived:**

> MAC is the count of distinct contacts with at least one inbound or outbound message
> in the billing month, per organization.

Not total contacts, conversations, or messages. Source: `usage.service.ts:73`.

**Binding on the metering work:** a limit must not be displayed as enforced when
nothing enforces it, and `downgradeGraceReason`'s "blocked until reduced" text must not
be shown where it is untrue. Show what is true, or show nothing. **Enforcement is not
to be added as part of that work** — it is a pricing decision.

- **Owner:** UnKnowan
- **Trigger:** the pricing decision — what a plan limit means when it is exceeded
  (hard block, grace, overage billing, or upsell prompt).
- **Lands in:** `apps/backend/src/modules/usage/entitlements.ts`
  (`assertMetricAvailable` call sites), and the customer-facing usage screen for how
  the limit is described.

---

## D-4 · Credentials are in public git history and are not yet rotated

`OPENWA_API_KEY` and the database password appear in the history of a repository that
is public by deliberate choice. Untracking does not undo a disclosure; the values have
to be rotated at the provider.

**The backend must not be exposed publicly until this is done.** Everything else in the
control-panel work assumes a platform a stranger will attach their business WhatsApp
number to, and that assumption is false while these values stand.

Not to be touched from inside this repository: not read, not printed, not rotated by
tooling. It is owner work at the provider consoles.

- **Owner:** UnKnowan — in progress, this week.
- **Trigger:** before the first external customer, or any public exposure of the
  backend, whichever comes first.
- **Lands in:** the provider consoles (OpenWA, the database host) and `.env`.

---

## D-5 · A real paid account can reach CHANNEL_NOT_PROVISIONED

The pairing endpoint now reports three distinct faults instead of claiming
`pending` for all of them. Proving that surfaced a defect underneath it: an
account created through the real signup path has an `OrganizationChannel` row
with `status = PENDING` and an **empty `baseUrl`**, so `provider()` throws
before any network call and the customer is told, correctly, that no gateway
has been set up for them.

The message is now honest. The situation is not acceptable: a paying customer
reaching "contact support so a gateway can be provisioned" as the first thing
they do is a provisioning failure, not a messaging one.

Deliberately **not** fixed in the honesty commit. Making the screen tell the
truth and changing what the truth is are two changes, and merging them would
have meant neither could be proved on its own.

- **Owner:** UnKnowan
- **Trigger:** the next commit.
- **Lands in:** the provisioning path — `gateway-provisioning.service.ts` and
  the `OrganizationChannel` row written at signup in `billing.service.ts`.

---

## D-6 · The OpenWA gateway rejects every key the platform holds

The running `openwa` container answers `401` to both the encrypted key stored
on `OrganizationChannel` and to `OPENWA_API_KEY` from `.env`. So OpenWA pairing
cannot reach a real QR code in this environment at all, for any organization.

This is independent of the honesty change and predates it — the endpoint now
reports `GATEWAY_REFUSED` with the 401 instead of hiding it, which is how it
was found. It also means the pairing path could not be demonstrated end to end:
the three fault states are proved against the running gateway, a successful QR
is not.

Related, and possibly the same cause: both seeded organizations point at
`http://openwa:2785`, the docker-internal hostname, which a backend running
from source on the host cannot resolve.

- **Owner:** UnKnowan
- **Trigger:** the credential rotation in D-4 — the gateway key is one of the
  values being rotated, and reconciling it belongs with that work rather than
  before it.
- **Lands in:** the gateway container environment and the `apiKeyEnc` written
  by `PATCH /api/platform/subscribers/:id/openwa-channel`.
