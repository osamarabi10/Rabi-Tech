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

## D-5 · Self-serve signup produces a channel belonging to neither topology

This entry replaces two that were filed separately -- "a real paid account can
reach CHANNEL_NOT_PROVISIONED" and "the gateway rejects every key the platform
holds". They are one defect seen from two layers.

### The two topologies

**Per-tenant.** `gateway-provisioning.service.ts:123` mints a fresh key with
`crypto.randomBytes(32).toString('base64url')`, stores it encrypted on
`OrganizationChannel.apiKeyEnc`, and `gateway-runtime.ts:33` starts that
tenant's own container with the same value. The two agree by construction --
one generator, one store, one container.

**Shared.** `docker-compose.yml:42` gives the single `openwa` service
`API_KEY=${OPENWA_API_KEY}` from `.env`. An organization pointed at it must
hold that same value, which only `scripts/bootstrap-openwa-channel.ts` writes --
the one path that reads `OPENWA_API_KEY` and seeds a channel from it.

### Signup belongs to neither

`billing.service.ts` creates an `OrganizationChannel` with `status: PENDING`,
`provisioningState: PENDING`, an empty `baseUrl` and an empty `apiKeyEnc`. It
does not provision a per-tenant gateway, and it does not seed against the
shared one. The row exists and points at nothing.

**So the 401 is not a wrong key. It is a channel that was never given one.**
Whether the customer sees `CHANNEL_NOT_PROVISIONED` or `GATEWAY_REFUSED`
depends only on which layer notices first -- `provider()` refusing a non-ACTIVE
row, or the gateway refusing an empty credential. Both are the same absence.

That is why the earlier ruling that this was a key to be recovered was wrong:
there is no key to recover.

### The cause, established by a run rather than assumed

Two earlier readings of this entry were wrong and are corrected here. The first
said "there is a provisioning step that never runs". The second replaced it with
a hypothesis -- no mail transport (D-2) -> the customer cannot verify ->
`maybeProvisionGateway` never fires. **Neither is what happens.**

A paid signup on 2026-09-05, run against the real stack, settled it:

    POST /api/billing/signup, plan STANDARD, address never confirmed
    -> Organization.status            PROVISIONING
    -> maybeProvisionGateway          fired, reason "signup", returned true
    -> bull:gateway-provisioning      job queued for that organization
    -> OrganizationChannel            still PENDING, blank baseUrl, no key

So the producer works. What is missing is the **consumer**:
`startGatewayProvisioningWorker` is exported from
`workers/gateway-provisioning.worker.ts` and is called from exactly one place --
that file's own `require.main === module` block. It is a separate process,
`npm run gateway:worker`, and `docs/GATEWAY-PROVISIONING.md` says so on its
first line: the API is a queue producer only, and the worker runs on the Docker
host because it starts containers.

That process is not running in this environment, and has not been for some time:
Redis holds **236 waiting jobs** on `bull:gateway-provisioning`, one per
organization ever created here. Every one of them is a customer who was told
their gateway was being prepared.

**This is a deployment gap, not a code defect.** Nothing in the queueing path
needs changing. What is missing is that the provisioning host worker is not run
anywhere -- not by compose, not by a supervisor, not by any documented start
sequence beyond a manual `npm run gateway:worker`. Until it is, the channel row
stays exactly as this entry describes it, and `CHANNEL_NOT_PROVISIONED` is the
honest answer the pairing screen now gives.

### What is true today

- A signup-created channel is `PENDING` with a blank `baseUrl` and no key.
- The two seeded organizations point at `http://openwa:2785`, the
  docker-internal hostname, which a backend running from source on the host
  cannot resolve -- a second reason the same rows cannot authenticate.
- Consequently **no organization in this environment can complete pairing**,
  and the successful-QR half of the pairing evidence could not be produced.

### Owner and trigger

- **Owner:** UnKnowan, for the topology choice -- per-tenant or shared is a
  cost and operations decision, not an implementation detail. The wiring that
  follows from it is not owner work.
- **Trigger:** the next commit, which must make signup either provision a
  working gateway or not complete at all.
- **Lands in:** the signup path in `apps/backend/src/modules/billing/billing.service.ts`
  and `apps/backend/src/modules/provisioning/gateway-provisioning.service.ts`.

### Not to be confused with D-4

D-4 rotates `OPENWA_API_KEY` because it is exposed in public history. That is a
real and separate obligation. Rotating it does not fix this entry, and this
entry does not wait on it: a channel with no key is unaffected by which key the
shared container holds.

---

## D-6 · Gateway topology is per-tenant; shared is development-only

**Settled 2026-09-05.**

Each subscriber gets its own OpenWA container, its own randomly generated key,
and its own data volume. The shared `openwa` service in `docker-compose.yml` is
a development convenience and is not a deployment model.

### Why, in one line

A shared gateway holds many businesses' live WhatsApp sessions in one process,
so one crash or one leaked key is *everyone's*. That is disqualifying for a
product whose pitch is "attach your business number to us". Blast radius
outweighs the cost.

### What it costs, stated plainly

Roughly one container, one data volume and one Redis volume **per paying
customer**. Host demand scales linearly with customers rather than staying flat.
The machine this was developed on cannot run a single full stack, which is not
an argument against the choice but is a hard precondition on where it runs.

It is already implemented end to end: `gateway-provisioning.service.ts:123`
mints the key when `apiKeyEnc` is empty, `:156` decrypts it, and
`gateway-runtime.ts:33` starts the container with the same value. Nothing has
to be kept in sync by hand.

- **Owner:** UnKnowan — for the hosting decision this bundles with. The
  topology is settled; where N containers run is not.
- **Trigger:** the hosting decision, before the first paying customer.
- **Lands in:** the deployment target, and `docs/DEPLOYMENT.md` once the host
  is chosen.

---

## D-7 · FREE never provisions a gateway, so FREE cannot evaluate the product

`maybeProvisionGateway` returns early for any non-paid plan
(`billing.service.ts:565`, `isPaidPlan`). A FREE signup therefore never gets a
gateway, never pairs a number, and never sends or receives a message.

This is **an open product decision, not a defect**, and it is recorded rather
than changed. But the consequence should be said out loud: if FREE gets no
gateway, FREE is a signup form rather than a trial, and nobody can evaluate the
product without paying first.

Note the interaction with the editions actually on sale here: FREE and STANDARD
are the only plans that can be signed up for at all, because GROWTH, BUSINESS
and ENTERPRISE permit only `WHATSAPP_CLOUD`, whose required environment is
unset, so `editionOfferability` withdraws them. That leaves exactly one
sellable plan that provisions anything.

- **Owner:** UnKnowan
- **Trigger:** the pricing decision — whether FREE is a trial, a demo with a
  shared sandbox number, or a form that collects an email.
- **Lands in:** the edition definitions (`Plan.allowedChannels` and the
  `autoProvisionGateway` entitlement), and `isPaidPlan` if FREE is to provision.

---

## D-8 · Provisioning is decoupled from email verification (transitional)

**Transitional. It ships with an expiry condition, per AGENTS.md.**

`maybeProvisionGateway` used to require `Organization.emailVerifiedAt`. That
condition is removed, and provisioning is triggered at signup instead of at
verification.

### Why

There is no mail transport (D-2). The only route to verification is the link
rendered on the signup screen itself, so a customer who closes that tab has no
way back to it -- and under the old rule, no way to ever be given a gateway.
The gate was not protecting anything. It was making a paid product unreachable
for anybody who blinked.

### What did not change

Every other guard is untouched, deliberately:

- `isPaidPlan` -- a FREE plan still never provisions (D-7).
- `channelGrantRefusal` -- the edition must permit OPENWA.
- the `provisioningState` check -- a channel already ACTIVE, AWAITING_QR or
  PROVISIONING is left alone.

Verification itself is untouched. The token, the link, the `/verify-email`
endpoint and `emailVerifiedAt` all still work and still record a real
confirmation. What changed is that not having done it yet stops something
invisible and starts something visible: an unverified organization now carries
a persistent banner on every dashboard page, with a resend that shows the link
when no provider delivered it.

### The abuse surface, stated honestly

An unconfirmed address can now reach a provisioned gateway. Two things bound
that, and neither is verification:

- **Provisioning still requires a paid plan.** `isPaidPlan` runs before
  anything is queued, so the floor on abuse is the price of a subscription --
  not a confirmed mailbox.
- **Signup is rate limited to 3 per hour per IP** (`LIMITS.signup`,
  `rate-limit.middleware.ts:155`), with a second in-service throttle of 10 per
  hour per IP and 50 per hour per email domain (`SIGNUP_IP_LIMIT` /
  `SIGNUP_DOMAIN_LIMIT`, unset in `.env`, so both defaults apply). The binding
  limit is 3.

The honest reading: verification was never the thing stopping abuse here,
because an attacker who can pay can also confirm an address. What it did stop
was the legitimate customer.

### The expiry condition

- **Owner:** UnKnowan
- **Trigger:** a working mail provider (Resend, or whichever is chosen).
- **On that trigger:** decide *deliberately* whether to restore the gate. It
  must not be restored automatically as a side effect of configuring mail. The
  question to answer then is whether an unconfirmed address should be able to
  attach a business WhatsApp number -- which is a product decision, not a
  cleanup.
- **Lands in:** `apps/backend/src/modules/billing/billing.service.ts`, at the
  guard in `maybeProvisionGateway` and the trigger at the end of
  `createSignup`.

### Also corrected here

The signup screen said the email had to be verified "before any WhatsApp number
is linked to the account". That sentence described the gate this entry removes,
so it was replaced rather than left standing. A screen describing a rule the
code no longer has is worse than a screen saying nothing: it tells the customer
to wait for something that is not going to happen.

---

## D-9 · The Cloud API lane has no connect screen, and Growth sells both

C1 made the gateway a property of the number, so one organization can run
OpenWA on one number and Meta's Cloud API on another. The ladder sells that at
Growth. **The customer cannot reach half of it.**

### What exists on each lane

OpenWA has a complete self-serve path: a channel row at signup, provisioning,
a QR dialog that reports three distinct faults honestly (D-8 era work), and a
per-number gateway control. A customer connects a number without talking to
anybody.

Cloud API has `POST /api/channels/meta/connect`, which takes a phone number id,
a WABA id and an access token, and a card that collects those three fields. That
is not a connect screen — it is a form for values the customer has to obtain
from Meta first, through Business Manager, business verification and a System
User token. Nothing in the product explains or assists any of it.

### Why it is recorded rather than built

The work is not a screen. It is an embedded-signup flow against Meta's
JavaScript SDK, which requires a Meta app with `whatsapp_business_management`
and `whatsapp_business_messaging`, App Review for both, and a verified
business. None of those are code, and two of them take weeks of somebody
else's time.

Also true and worth saying plainly: `META_APP_SECRET` and
`META_WEBHOOK_VERIFY_TOKEN` are unset, so `editionOfferability` withdraws every
Cloud-API-only edition from sale. GROWTH, BUSINESS and ENTERPRISE are
unsellable today for that reason alone. The missing connect screen is the
defect that outlives fixing the environment.

- **Owner:** UnKnowan
- **Trigger:** the Meta keys and business verification — the point at which a
  Cloud API number can be connected at all.
- **Lands in:** the channels screen, beside the QR flow, so the two lanes are
  one surface rather than a self-serve path and a form.
