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

## D-5 · Pairing works end to end; the two seeded organizations cannot pair on the shared gateway

**Rewritten 2026-09-05, after a real pairing.** Three earlier readings of this
entry were wrong in three different ways, and the correction dictated for this
rewrite -- "the network, not the key" -- turned out to be half right. What
follows is what a scan and a probe established, in the order they were found.

### The four readings before this one

1. "There is a provisioning step that never runs." Wrong: it runs.
2. "No mail transport (D-2), so the customer cannot verify, so
   `maybeProvisionGateway` never fires." Wrong: it fired at signup, and since
   C2 it fires on Connect.
3. "The producer works; the consumer -- `npm run gateway:worker` -- is not
   running, and the 401 is not a wrong key but a channel that was never given
   one." Right about the worker. Wrong about the key: see below.
4. "The seeded organizations' credentials and topology are correct; what
   stopped them was the network." Right about the topology and the network.
   Wrong about the credentials: the probe below returns 401 from inside the
   network.

### What stood between Connect and a QR, for a self-serve organization

A fresh STANDARD trial, `c2-lazy-proof-1788633943`, clicked Connect on
2026-09-05 with the backend running **inside compose** and the worker running
on the host. Five things had to be true before a QR rendered. Each was found
by the run refusing at that step, not by reading.

| # | What was in the way | Seen as | Where it was fixed |
|---|---|---|---|
| 1 | A backend started from source on the host cannot resolve `openwa:2785`, and the host port mapping `127.0.0.1:13000` now closes every connection (`curl: (52) Empty reply`) while `:4000` and `:18080` answer | connection errors, or nothing at all | not code: the backend runs inside compose -- `docs/DEPLOYMENT.md`, "The backend must run inside compose" |
| 2 | The provisioning worker was not running anywhere | Connect returned `queued: true` and the dialog said "about a minute" forever | not code: `npm run gateway:worker` on the host, per `docs/GATEWAY-PROVISIONING.md` |
| 3 | `ghcr.io/rmyndharis/openwa:latest` was unpinned until 2026-09-06; both compose files now pin the 0.23.2 digest. The image on this host is **0.23.2**, built 2026-08-23, and it **never reads `API_KEY`**. It seeds a key store once, on first boot with an empty data volume, from `API_MASTER_KEY` if set and from a random key it writes to `/app/data/.api-key` if not, and authenticates only against that store. Every per-tenant gateway the provisioner built therefore held a key the provisioner had never seen | readiness probe 401 on every tenant gateway; provision `FAILED` at `WAIT_FOR_PROVIDER` | `deploy/openwa-organization.compose.yml`: `API_MASTER_KEY: "${OPENWA_API_KEY}"`. Effective for **fresh volumes only** -- a container that already booted keeps the key it minted |
| 4 | The gateway's SSRF guard refuses a webhook whose host resolves to a private address, which is where the backend lives | webhook registration 400; provision `FAILED` at the webhook step | same file: `SSRF_ALLOWED_HOSTS: "host.docker.internal"` -- the shared compose file already had it, the tenant one did not |
| 5 | `OpenWAGatewayProvider.ensureSession` knew `starting` and `authenticating` as "already running" but not 0.23.2's `initializing` and `qr_ready`, so it told a session that had reached the QR to start again and was refused with 400 "Session is already started" | provision `FAILED` one step short of `AWAITING_QR` | `gateway-provider.ts`: the gateway's own status vocabulary, and 400-already-started treated like 409 |

With all five: QR rendered in the product, scanned from a phone, gateway
session `ready` with the phone number at 20:34:04Z, `session.authenticated`
and `message.received` webhooks delivered to `host.docker.internal:4000`,
inbound events reaching the incoming-message worker. **The earlier sentence
"no organization in this environment can complete pairing" is withdrawn. One
did.**

Two more things the run showed, neither fixed:

- **The product records a pairing only in the worker's `monitorConnection`
  step.** Nothing in the request path notices a scan. When the worker died
  (ts-node, ~390 MB, killed twice for memory on this host), the channel stayed
  `AWAITING_QR`, and the channels list -- which refuses to probe a channel that
  is not `ACTIVE` -- showed "Disconnected" to a person whose phone had just
  said "device linked". Running the monitor step once by hand flipped it to
  `ACTIVE` at 20:38:41Z. The list should probe an `AWAITING_QR` channel too, or
  the pairing endpoint should record what it just saw.
- **The worker's reconcile loop queues `provision` for every `PENDING` managed
  channel every 30 seconds.** That is a fourth trigger, undocumented, and it
  contradicts C2's "the only trigger is Connect": it built five containers for
  stale test organizations nobody clicked, which is what exhausted the host.
  Since C2 a click writes `PROVISIONING` before queueing, so the loop should
  reconcile channels that are in flight, not channels that are merely unbuilt.

### The shared gateway: the two seeded organizations

`rabitech-demo` and `ostudio` point at `http://openwa:2785` and hold the
`OPENWA_API_KEY` from `.env` -- which is what `scripts/bootstrap-openwa-channel.ts`
writes and what `docker-compose.yml:42` hands the shared container as
`API_KEY`. Topology correct, and reachable: from inside compose the probe
reached the gateway. But the shared container is the same 0.23.2 image, its
data volume was first booted on 2026-08-23 (`/app/data/.api-key` is dated
16:05 that day) with no `API_MASTER_KEY`, so it minted its own key and ignores
the one in `.env`. Probed from inside compose on 2026-09-05 with each
organization's own stored key, printing status only: **401, 401.**

So the 401 seen earlier through the host proxy, while that proxy still
worked, was a real 401 and reproduces from inside the network. **The two
seeded organizations cannot pair on the shared gateway from anywhere, and the
reason is the key**, not the row and not the route. Re-running the bootstrap
would not help: it writes the `.env` value, which is the value the container
does not hold.

### What is true today

- Self-serve: Connect -> per-tenant container -> QR -> scan -> `ACTIVE` works,
  with the backend inside compose and the worker on the host.
- The two seeded organizations are `ACTIVE` rows against a gateway that answers
  them 401, which the pairing screen reports as `GATEWAY_REFUSED`.
- `gateway-provisioning`: 246 failed jobs, 1 waiting -- the backlog the worker
  consumed once it ran, almost all for test organizations whose containers no
  longer exist. A `FAILED` retry resumes at the failed step and cannot recover
  from a missing container; `resume` (`up -d`) can.
- `docker-compose.yml:42` still passes `API_KEY`, a variable the running image
  does not read. Changing it to `API_MASTER_KEY` takes effect only on a fresh
  volume.

### Owner and trigger

- **Owner:** UnKnowan. The shared gateway has three ways out and each costs
  something different: (1) recreate the shared data volume with
  `API_MASTER_KEY` set -- the container will then hold the `.env` key by
  construction, at the price of every session that volume holds, which per D-6
  is development data; (2) copy the key the container minted into the two rows
  -- a credential copy out of a container, which this session did not perform;
  (3) leave the two rows as they are and accept that the shared lane is dead.
  Independently of that choice the image is now **pinned by digest** in both
  compose files (2026-09-06): `:latest` had moved the authentication model
  under a running system and nothing noticed until a scan.
- **Trigger:** before anything is demonstrated on the seeded organizations,
  and before the next `docker pull`.
- **Lands in:** `docker-compose.yml` (the `openwa` service: `API_MASTER_KEY`;
  the pin is already there) and `docs/DEPLOYMENT.md`.

### Not to be confused with D-4

D-4 rotates `OPENWA_API_KEY` because it is exposed in public history. That is a
real and separate obligation, and this entry changes how it is done: on
0.23.x a gateway's key store is written once, so a rotation is a new volume or
the gateway's own key management, never an env change alone.

---

## D-6 · Gateway topology is per-tenant; shared is development-only

**Settled 2026-09-05. Corrected the same day, after the first real pairing.**

Each subscriber gets its own OpenWA container, its own randomly generated key,
and its own data volume. The shared `openwa` service in `docker-compose.yml` is
a development convenience and is not a deployment model.

### Why, in one line

A shared gateway holds many businesses' live WhatsApp sessions in one process,
so one crash or one leaked key is *everyone's*. That is disqualifying for a
product whose pitch is "attach your business number to us". Blast radius
outweighs the cost.

### What the first version of this entry got wrong

It said the per-tenant lane was "already implemented end to end" and that
"nothing has to be kept in sync by hand", because the provisioner mints the
key, stores it encrypted, and starts the container with the same value. That
was true of the image the code was written against. It stopped being true
when `ghcr.io/rmyndharis/openwa:latest` moved to 0.23.x, which does not read
`API_KEY` at all (D-5, row 3): every tenant gateway built since then minted a
key of its own and answered 401 to the one the provisioner held. The agreement
was never by construction -- it rested on an unpinned tag and an environment
variable name, and both changed without a line of this repository changing.

The tenant compose file now passes `API_MASTER_KEY`, which 0.23.x reads once,
on first boot with an empty volume. So the agreement holds again -- for
containers built from now on. It holds only as long as the tag is pinned.

### What it costs, stated plainly

Roughly one container, one data volume and one Redis volume **per paying
customer**. Host demand scales linearly with customers rather than staying flat.
Measured on 2026-09-05: with six tenant gateways and the main stack up, this
development host killed the provisioning worker twice for memory; five of the
six were test organizations the reconcile loop had built unasked (D-5). The
machine this was developed on cannot run a single full stack, which is not an
argument against the choice but is a hard precondition on where it runs.

Two consequences for operations that follow from the key store being written
once:

- **Rotation (D-4) on a per-tenant gateway is a new volume or the gateway's own
  key management, not an env change.** Restarting a container with a different
  `API_MASTER_KEY` changes nothing.
- **A tenant gateway whose container is gone cannot be recovered by retrying
  the failed provision step.** `resume` runs `up -d` on the same volumes and can.

- **Owner:** UnKnowan -- for the hosting decision this bundles with. The
  topology is settled; where N containers run is not.
- **Trigger:** the hosting decision, before the first paying customer. The
  image pin did not wait for it: both compose files carry the digest since
  2026-09-06.
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
