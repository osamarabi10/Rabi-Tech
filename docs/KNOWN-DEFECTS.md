# Known defects

Defects that are understood, reproducible and **not yet fixed**. Each entry
says what is wrong, what it costs, and what fixing it would take. A defect
recorded here is a decision to accept it for now — not a discovery waiting to
be made again by the next person.

---

## A pattern · Gates that report on their environment, not on the code

Three entries below are one defect wearing different clothes. It is worth
naming, because the fourth instance will not look like the first three.

- **D-5** — `verify-finance.js` chose its subject with an unordered `findFirst`,
  so which organization it tested changed between runs, and it failed only on
  the draws that happened to pick a seeded id.
- **D-10** — a gate's exit code was replaced by a trailing `echo`, so a harness
  that exited 1 at 122/123 was reported as having passed.
- **D-12** — gate scripts read `DATABASE_URL` from whatever was already in the
  shell, so identical code fails in a clean terminal and passes in a warmed one.
- **D-16** — a usage fixture spanned the last 23 hours while the metric it was
  checked against sums the calendar month, so the gate failed on the first of
  the month and passed on every other day.

In each case the gate answered a question about its own surroundings — which row
it drew, which command exited last, which variables were already exported — and
the answer was read as a statement about the code. A green of that kind is not
weak evidence; it is *no* evidence, and it is worse than a red, because a red
gets investigated and a green stops anyone looking.

**All three were found by running the gates in a clean state rather than in the
state they happened to work in.** None would have surfaced by reading the code,
and none had surfaced through ordinary use — ordinary use kept reproducing the
very conditions that made them pass.

Hence the standing rule this repository works by: **a gate is green only when it
was watched to run.** Not because it was green last time, not because an exit
code was zero, and not because a summary from a previous session said so. Read
the summary line the gate itself prints, prefer a clean shell to a convenient
one, and treat any gate whose result you did not watch being produced as
unknown rather than as passing.

---

## D-1 · The manual fetch pattern has no unmount or stale-response guard

**Where:** the 29 files using the manual `loading` / `loadError` pattern
described in [FETCH-STATE-PATTERN.md](FETCH-STATE-PATTERN.md).

**What is wrong:** two things, both invisible until they are not.

1. **Post-unmount `setState`.** Nothing tracks whether the component is still
   mounted when a response lands. Navigate away from a page whose request is
   still in flight and the resolution writes into a dead tree.
2. **No request sequencing.** Nothing correlates a response with the request
   that asked for it. Two loads in flight — a retry, a fast filter change —
   resolve in whatever order the network returns them, so a slow *earlier*
   request can overwrite a fast *later* one. The user sees stale data with no
   indication anything is wrong.

**Cost:** (2) is the one that shows. It is a wrong-data bug, not a crash, so it
does not announce itself; it is most likely on the filter-heavy pages
(contacts, campaigns, reports) where loads are triggered in quick succession.

**Fix:** `useResource` in
[`lib/async-resource.ts`](../apps/frontend/lib/async-resource.ts) already solves
both — a sequence ticket and an `alive` ref. The fix is migrating the 29 call
sites to it. That is a deliberate refactor to be scheduled and approved, not
folded into unrelated work.

---

## D-2 · Two empty-state components with divergent APIs

**Where:** [`components/empty-state.tsx`](../apps/frontend/components/empty-state.tsx)
(legacy) and `EmptyState` in
[`components/ui/operational-state.tsx`](../apps/frontend/components/ui/operational-state.tsx)
(current).

**What is wrong:** same component name, same purpose, **different props**. The
legacy one takes `hint`; the current one takes `description`. They also render
at different type scales — legacy uses raw `text-sm` / `text-xs`, current uses
the `text-body` / `text-small` tokens.

The legacy file's own header comment says it exists to end exactly this
problem: *"There were ten variants across the app at three different type
scales."* It then became one of two.

**Cost:** an import from the wrong path silently produces a component that
ignores the prop you passed — `description` on the legacy one is dropped, and
the empty state renders with no explanatory text at all.

**Fix:** migrate remaining legacy importers to `ui/operational-state` and
delete `components/empty-state.tsx`. Check importers before deleting.

---

## D-3 · A second checkout shares this project's compose identity and volumes

**Where:** `C:\Desktop\RabiTech` (an older checkout) versus this repository.
Operational, not in the code — which is why it is written down here.

**What is wrong:** both `docker-compose.yml` files declare `name: rabitech`,
**and** both pin the same volume names:

```yaml
volumes:
  pgdata:      { name: rabitech_pgdata }
  openwa_data: { name: rabitech_openwa_data }
```

Identical project name plus identical container names means Compose treats the
other tree's containers as its own. Two consequences:

1. **`docker compose up` from either directory recreates the other's
   containers.** This is not theoretical: on 2026-08-31 it took the database
   off `localhost:15432` and replaced it with a container bound to `5432`,
   which read as "the database is gone." Nothing was lost, but the stack was
   down until the correct compose file was reapplied.
2. **`docker compose down -v` from *either* directory deletes
   `rabitech_pgdata`.** That is this project's database. There is no prompt and
   no second chance.

The older checkout's `.env` also holds a **stale** `POSTGRES_PASSWORD` that
fails scram auth against the live volume, so its backend cannot connect even
when its containers are the ones running.

**Cost:** one command in the wrong directory destroys the development database.

**Working rule until fixed:** never run `down -v` in either tree, and target
this repository explicitly:

```
docker compose --project-directory "<this repo>" -f "<this repo>/docker-compose.yml" ...
```

To see which file owns a running container:

```
docker inspect rabitech-postgres-1 --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

**Fix:** give the old checkout a distinct `name:` and drop its pinned volume
names, so the two stacks can never address each other's data.

---

## D-4 · The console sidebar fails open on absent permissions

**Where:** `canSee()` in
[`components/platform/platform-shell.tsx`](../apps/frontend/components/platform/platform-shell.tsx).

**What is wrong:** absent `platformPermissions` is treated as *show all
non-owner items* rather than failing closed.

This is deliberate and temporary. `platformPermissions` only started reaching
the client alongside the shell, so a SUPPORT session stored in `localStorage`
before that change carries no array. Failing closed would give those users an
empty sidebar — a console that looks broken — until they happened to sign out
and back in.

**Why it is safe right now:** only because the server fails closed
independently. `requirePlatformOwner` and `hasPlatformPermission` in
`platform.routes.ts` re-read permissions from the database on every request and
deny on anything they do not recognise. The sidebar decides what is *shown*; it
has never been what is *allowed*. The e2e gate in
[`tests/e2e/platform-console.spec.ts`](../apps/frontend/tests/e2e/platform-console.spec.ts)
asserts that a support token still gets 403 from the owner-only staff endpoint.

**Cost:** a SUPPORT user on a pre-change session is shown destinations that
will refuse them — the exact thing app-sidebar.tsx argues against
(*"a menu is a list of places you can go, and one that leads nowhere is a worse
answer than its absence"*).

**Fix (D-4):** once existing SUPPORT sessions have cycled, flip this to fail closed —
drop the `Array.isArray(...)` escape hatch in `canSee()` so a missing
permissions array denies rather than permits. **This default must not outlive
the reason for it.** JWTs expire on `JWT_EXPIRES_IN` (7d by default), so the
window is short and knowable; there is no reason for this to still be here a
month from now.

---

## D-5 · The finance gate picked its fixture non-deterministically — RESOLVED

**Resolved in `889096e6`.** Kept as a short record because the failure mode is
easy to reintroduce.

`verify-finance.js` chose its subject with an unordered `findFirst`, so which
of three organizations it tested changed between runs, and it failed whenever
it drew the seeded `org_rabitech_0` — id tail `CH_0`, rejected by a format
assertion of `[A-Z0-9]{4}`. CLAUDE.md recorded the gate as 16/16 while it was
15/16 under those draws.

Selection is now ordered and the assertion accepts the underscore a slug id
legitimately produces. The suite also gained a check that the issued reference
equals the `invoiceRef` high-water mark, because format alone could never have
caught a numbering regression. Now 17/17, deterministic.

---

## D-6 · A written migration was unapplied — RESOLVED

**Resolved 2026-08-31.** `20260920090000_meta_template_lifecycle` is applied.
`prisma migrate status` reports the database up to date with zero pending
migrations, so `migrate deploy` behaves normally again and no phase after this
one needs the direct-SQL-plus-`migrate resolve` workaround.

Kept as a record because the *shape* of the problem recurs: a migration written
ahead of the code that needs it leaves the generated Prisma client describing a
database that does not exist yet, and every read or write of the new fields
fails with `P2022` until someone notices.

**The drift was wider than originally recorded.** The checkpoint documented
`Campaign.metaTemplateId`. Three more existed:

| Declared in `schema.prisma` | Was missing from the database |
|---|---|
| `MetaChannelCredential.businessPortfolioId` | yes — **and written by live code** |
| `MetaMessageTemplate` (whole model) | yes |
| `MetaTemplateSend` (whole model) | yes |
| `Campaign.metaTemplateId` / `metaTemplateBindings` | yes |

The `businessPortfolioId` one was not latent: `meta.service.ts` writes it in the
channel-connect `persist()` path, so connecting a Meta channel failed. The
campaigns route had been repaired with an explicit pre-migration column list;
nothing had repaired this one, because nothing had looked.

**Lesson worth keeping:** when a migration is found unapplied, enumerate the
*whole* diff between `schema.prisma` and the live database rather than fixing
the symptom that was reported. One `P2022` being visible does not mean it is
the only one.

Pre-flight checks run before applying: `MetaChannelCredential` held zero rows,
so the globally-unique `wabaId` and `businessPortfolioId` indexes could not
collide. The campaigns pre-migration select has been removed.

---

## D-7 · `MetaTemplateSend` will start refusing deletes, and nothing handles it

**Where:** the FK constraints added by
`20260920090000_meta_template_lifecycle` on `MetaTemplateSend`.

**What is wrong — not yet, but as soon as rows exist.** Four of its foreign
keys are `ON DELETE RESTRICT`:

```
MetaTemplateSend.templateId          -> MetaMessageTemplate   RESTRICT
MetaTemplateSend.campaignId          -> Campaign              RESTRICT
MetaTemplateSend.campaignRecipientId -> CampaignRecipient     RESTRICT
MetaTemplateSend.contactId           -> Contact               RESTRICT
```

`RESTRICT` is the correct choice — a send record is evidence that a message was
dispatched, and it must not vanish because someone tidied a contact list. The
problem is the error path, not the constraint.

**The table is empty today** because no send path is enabled, so nothing can
fail yet. That is exactly why this is written down now rather than discovered
later.

**What happens once send rows exist:**

1. **Contact and campaign deletion.** The application currently has **no**
   contact-delete or campaign-delete path at all — the only deletes under
   `contacts.routes.ts` are tags, custom fields and tag unlinks. So the first
   person to add one inherits a refusal they did not design for.
2. **Subscriber deletion — the live exposure.** `DELETE /subscribers/:id`
   exists and cascades from `Organization`. Both `Contact` and
   `MetaTemplateSend` cascade from `Organization`, and there is a `RESTRICT`
   between them. Whether the cascade succeeds depends on the order PostgreSQL
   processes the two, which is not specified. **This is unverified and cannot
   be verified while the table is empty.** It may be fine; it may make
   subscriber deletion fail once a single send row exists.
3. **There is no `P2003` handling anywhere in the backend.** A grep for
   `P2003`, `ForeignKeyConstraint` or foreign-key error handling returns
   nothing. A refusal therefore surfaces as an unhandled 500 with a Prisma
   error string, not as a message explaining that the record cannot be deleted
   because messages were sent against it.

**Cost:** an operator deleting a subscriber sees a 500 and cannot tell whether
the deletion partly happened. That is the worst version of this failure.

**Fix — do it before the Meta send path ships, not after:**
1. Decide the product answer. Is a contact with send history undeletable, or
   soft-deletable, or does deleting it null the `contactId` on the send record?
   All three are defensible; none is implied by the schema.
2. Catch `P2003` and return a 409 that names what is blocking the delete.
3. Verify the subscriber-delete cascade with at least one send row present,
   which is only possible once the send path exists.

---

## D-8 · Three pre-tenancy shadow schemas are still in the database

**Where:** the `rabitech` database holds four non-system schemas —
`public`, plus `rabitech_diff_shadow`, `rabitech_p1b_shadow` and
`rabitech_p1d_debug`.

**What they are.** Snapshots of the schema *as it was before multi-tenancy*,
left behind by the P1-B and P1-D phase work — the names match
[P1-B-COMPOSITE-FOREIGN-KEYS.md](P1-B-COMPOSITE-FOREIGN-KEYS.md) and
[P1-D-ORGANIZATION-CONFIGURATION.md](P1-D-ORGANIZATION-CONFIGURATION.md).

Each holds 22 tables against `public`'s 63, and the difference dates them
precisely. They still carry models this product no longer has:

| Present in the shadows | Status in `public` |
|---|---|
| `Zone`, and `Campaign.zoneId` | removed |
| `GroupMessage` | dropped — groups are not supported |
| `Sequence` | dropped by `20260820000000_add_organization_configuration`, replaced by `OrgSequence` |
| `Ticket`, `TicketNote`, `Lead` | legacy, gone |

Each contains a single `Organization` row of pre-tenancy demo data.

**They already caused one wrong answer.** A schema-drift check during the
Editions phase queried `information_schema.columns` filtered by `table_name`
without `table_schema='public'`. Every column came back three or four times
over, and `Campaign.zoneId` appeared as a live column that `schema.prisma` did
not declare — a drift finding that did not exist. The correct query is scoped:

```sql
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'Campaign';
```

**Two existing documents disagree about these**, which is worth knowing before
trusting either:

- The header comment in `scripts/tenancy-bleed-harness.js` lists them beside
  `rabitech_bleed_*` as evidence the isolation gate had hung unnoticed.
- [RESPONDIO-PARITY-CHECKPOINT.md](RESPONDIO-PARITY-CHECKPOINT.md) says they do
  **not** match the harness's `rabitech_bleed_<pid>_<timestamp>` naming and
  come from other tooling.

The checkpoint is right, and the table above is why: harness corpses would
carry the current schema, and these carry a schema that predates tenancy by
dozens of migrations. The harness comment has been corrected.

**Are they safe to drop?** On the evidence, yes — but this is recorded rather
than acted on:

- No code, migration, `prisma` config or compose file references them. There is
  no `shadowDatabaseUrl` configured, so Prisma is not using them for migration
  diffing.
- They describe a schema no migration can reach any more.
- They are small, and cost nothing but confusion.

The argument against dropping them is that they are the only surviving record
on this machine of what the schema looked like before tenancy, which has some
value while P1-B and P1-D are still being referenced. **Left in place
deliberately.** If they are dropped, `DROP SCHEMA ... CASCADE` on all three is
the whole operation, and it should be its own change with its own dump — not
folded into unrelated work.

---

## D-9 · `FREE` is reserved only because `isPaidPlan` decides by name

**Where:** `isPaidPlan` in
[`modules/billing/plans.ts`](../apps/backend/src/modules/billing/plans.ts).

```ts
export function isPaidPlan(code: PlanCode): boolean {
  return code !== 'FREE';
}
```

**What is wrong:** whether an edition is billable is decided by its *name*
rather than its *price*. That was unremarkable while the five codes were fixed
in a union. Since E4 opened the code space it is the one thing still holding it
half-closed: `FREE` has to be listed in `RESERVED_PLAN_CODES` and cannot be
redefined or reused, purely to stop this function changing its answer.

It is also already slightly wrong. `ENTERPRISE` is stored at
`monthlyPriceCents: 0` because its price is negotiated, so by price it looks
free while `isPaidPlan` correctly calls it paid. Any price-derived replacement
has to keep that distinction rather than assume zero means free.

**Cost:** small today, and entirely a constraint on what comes next. An owner
cannot create an edition named `FREE_TRIAL` without thinking about it, and
cannot make the free tier an ordinary catalogue row.

**Fix:** derive it from the catalogue instead of the code — a `Plan` column
saying whether an edition is billable is the honest version, because "priced at
zero" and "not sold" are different facts and the schema currently cannot tell
them apart. Once that exists, `FREE` leaves `RESERVED_PLAN_CODES` and becomes
an ordinary row.

Deliberately not folded into E4: it is a schema change with its own migration,
and E4's job was to open the code space, not to redefine what a paid plan is.

---

## D-10 · A gate's exit code can be masked by whatever runs after it

**Where:** any invocation of the form `npm run <gate> ; <anything>`, and every
report derived from one.

**What is wrong:** a command list exits with the status of its *last* command.
Appending anything after a gate — an `echo`, a `tail`, a cleanup — replaces the
gate's exit code with that command's. The gate can fail while the invocation
reports success.

Observed 2026-08-31 running the tenancy harness as
`npm run test:tenancy > log 2>&1; echo "EXIT=$?"`. The harness exited 1 at
122/123; the `echo` exited 0; the run was reported as passing. The failure was
caught only by reading the log, and only because the log was read at all.

This is the same class as D-5, from the other side: D-5 was a gate that passed
while testing the wrong subject, this is a gate that failed while reporting the
right one. Both produce a green that is not evidence.

**Cost:** every green downstream of a masked run is meaningless, and the cost is
paid later — a masked failure is indistinguishable from a pass in any summary
derived from it, including the gate numbers in CLAUDE.md.

**Fix:** put nothing after a gate in the same invocation. Redirect its output
and let its own exit code stand, then read the log separately. Where a trailing
command is unavoidable, capture the status first (`rc=$?`) and exit on it. And
where the harness prints a summary line, read the summary rather than inferring
the result from an exit code at all.

**The rule, short enough to remember: a task's exit code is not the harness's
exit code unless nothing runs after it.**

---

## D-11 · Deactivating an edition can block invoicing the subscribers on it

**Where:** `sellableCurrencies()` in
[`currency-policy.ts`](../apps/backend/src/modules/billing/currency-policy.ts),
and the `billing-summary:plan-currency` read in
[`billing.service.ts`](../apps/backend/src/modules/billing/billing.service.ts).
Both filter `isActive: true`.

**What is wrong:** the same failure shape as the archival invariant, one layer
up — and unlike that one, this is in the code today.

`sellableCurrencies` derives the currencies the platform may write onto a
finance document from the *active* plans, so deactivating an edition removes its
currency from the allowlist. If no other live edition is priced in that
currency, `assertSellableCurrency` — which fails closed by design — refuses it,
and the owner cannot issue an invoice to a subscriber who is still on that
edition and still being billed for it. Retiring an edition from the price list
is not supposed to be a billing action.

The billing-summary read carries the same filter and the milder version of the
consequence: a subscriber on a deactivated edition is shown `planCurrency: null`
rather than the currency they are actually charged in.

E5f-1 settled the *archived* case deliberately — `sellableCurrencies` is not
filtered by `archivedAt`, because archiving stops the selling and not the
billing — and left `isActive` exactly as it was, because narrowing it further
would have been the same mistake and widening it is a separate change. Measured
against the rule in
[RESPONDIO-PARITY-CHECKPOINT.md](RESPONDIO-PARITY-CHECKPOINT.md), **these two
reads are resolution questions wearing an offer question's filter.**

**Cost:** nothing today, and entirely conditional. All five editions are priced
in USD, so removing one edition's currency removes nothing — the allowlist is
`['USD']` either way. The defect arms the moment a second currency exists *and*
the edition carrying it is deactivated, and it presents as a 400 about currency
on an owner's invoice for a subscriber whose plan is perfectly valid.

**Fix:** drop the `isActive` filter from both reads so they answer over every
edition, the way `getEdition` does. Deliberately not fixed alongside archiving:
it widens what may be written onto a finance document, which deserves its own
change and its own assertion rather than riding along with an unrelated one.

---

## D-12 · Gate scripts read `DATABASE_URL` from the ambient shell — PARTLY FIXED

**Fixed in `verify-finance.js` (2026-09-01).** Five sibling gates still carry
it. See [the pattern above](#a-pattern--gates-that-report-on-their-environment-not-on-the-code).

**Where:** `apps/backend/scripts/` — `inbox-views-check.js`,
`verify-snooze-wake.js`, `verify-campaign-replies.js`, `verify-dunning.js`,
`verify-media-url.js`. None of them calls `dotenv.config()`.

**What is wrong:** the tenancy harness loads the repository-root `.env`
explicitly before requiring anything that reaches Prisma. These do not, so they
inherit `DATABASE_URL` from whichever shell invoked them. In a clean terminal
the run dies with `Environment variable not found: DATABASE_URL`, raised from
inside `auditPlatformScope` — which reads like a code fault rather than a
missing variable, and sends the reader into the audit path looking for a bug
that is not there. In a terminal where something exported it earlier, the same
code passes.

Observed 2026-09-01: `npm run test:finance` failed in a clean shell and passed
17/17, entirely unchanged, with the variable exported.

**Cost:** the gate reports on the environment in both directions — a spurious
red that invites debugging code that is fine, and a green that only means
someone's shell happened to be warm. The harness's own loader comment records
the worse case: a stray `apps/backend/.env` once pointed a gate at
`localhost:5432`, a different Postgres entirely, where it "would have created
its disposable schema and proved nothing about isolation." Ambient resolution
can aim a gate at the wrong database as easily as at none, and that failure is
silent.

**Fix:** the one-line loader, before any require that reaches Prisma:

```js
require('dotenv').config({ path: path.join(__dirname, '..', '..', '..', '.env') });
```

Applied to `verify-finance.js` and verified by running that gate in a shell with
`DATABASE_URL` explicitly unset. Deliberately not applied to the other five in
the same change: they were not among this phase's gates, so the edit would be
unverified, and an unverified change to a gate is how a working gate quietly
becomes a broken one.

---

## D-13 · Upgrading off OpenWA takes the customer's channel away

**Where:** the interaction between `allowedChannels` enforcement in
[`channels.routes.ts`](../apps/backend/src/modules/channels/channels.routes.ts)
and any path that moves an organization onto an edition not allowing `OPENWA`.

**What is wrong:** a FREE or STANDARD customer connected through OpenWA who
upgrades to GROWTH loses their channel. Their number stops working. The more
expensive tier takes something away, which is the one thing an upgrade must
never do.

**Cost — now measured, not predicted.** The channel narrowing landed on
2026-09-01, so there are Meta-only tiers and this is live. It is milder than the
description above, and the difference matters:

Enforcement is at the connect paths only — `POST /channels/meta/connect` and
`POST /channels/active`. **Nothing on the send path reads `allowedChannels`.**
So an organization already sending on OpenWA when its edition stops allowing it
keeps sending: the `OrganizationChannel` row is untouched, status stays `ACTIVE`,
no message is refused, nothing disconnects. What it loses is the ability to
*select* OPENWA again once it has switched away.

**It is a one-way exit, not an outage.** Verified directly against `ostudio`
(ENTERPRISE, test data): still holding `OPENWA` at `ACTIVE`, still able to send,
now unable to re-select that channel.

That is materially gentler than "their number stops working" — but it is also
quieter, which cuts both ways. Nothing tells the customer they have crossed a
line until they try to cross back, and the failure lands at a moment
disconnected from the upgrade that caused it.

The remaining sharp edge is a subscriber who upgrades and *has not yet
connected* OpenWA, or who disconnects for any reason: for them the channel is
simply unavailable, with no path back short of a downgrade.

**Three options, none chosen here:**

1. **Block the upgrade** until a Meta channel is connected. Safest, and the most
   obstructive — it makes the customer do work before they can give you money.
2. **Warn loudly at upgrade time**, naming the channel that will stop working.
   Cheapest, and depends entirely on someone reading it.
3. **Grandfather existing OpenWA connections** — the edition forbids new ones
   while an existing one keeps working. Kindest to the customer and the most
   state to carry, because "allowed" stops being a function of the edition
   alone and becomes a fact about each connection.

This is precisely what E7's consequence preview exists for. The general problem
is that an edition change silently alters what a subscriber can do; a
disconnected channel is only its loudest instance.

**Fix:** deliberately not built. Recording it before the narrowing lands is the
point — the narrowing is what makes it real.

---

## D-14 · A catalogue edit does not reach existing subscribers' metered limits

**Where:** `applyPlanLimits` in
[`billing.service.ts`](../apps/backend/src/modules/billing/billing.service.ts)
and `effectiveLimits` in
[`entitlements.resolver.ts`](../apps/backend/src/modules/billing/entitlements.resolver.ts).

**What is wrong:** editing an edition in the console reaches existing
subscribers for most of what it grants, and does not reach them for the five
metered usage limits.

`applyPlanLimits` copies an edition's numbers into `OrganizationConfig` when a
tier is set. `effectiveLimits` then reads those config columns — it consults a
plan only when a live `planOverride` exists. So for an ordinary subscriber the
enforced quota is a **snapshot taken at their last activation**, not the current
catalogue. Raise GROWTH's contact allowance and every organization already on
GROWTH keeps the old number, indefinitely, until something activates them again.

The split is worth stating exactly, because it is not intuitive:

| Reaches existing subscribers on refresh | Frozen until next activation |
|---|---|
| name, `monthlyPriceCents`, `usersLimit` (seats) | `monthlyActiveContactsLimit` |
| `allowedChannels`, `autoProvisionGateway` | `monthlyOutboundMessagesLimit` |
| `customDomain`, `whiteLabel`, `maskContactDetails` | `monthlyCampaignSendsLimit` |
| campaign pacing | `monthlyAiTokensInLimit`, `monthlyAiTokensOutLimit` |

Seats are live and quotas are not, which is the asymmetry most likely to
surprise: both look like limits on the editions screen.

**This is detected, and deliberately suppressed.** `detectQuotaDrift` compares
config against the plan of record and would fire here — but it treats an edition
edit as a *new baseline* rather than drift, suppressing divergence whose config
predates the edition's `updatedAt`. That suppression is correct on its own
terms: without it, raising GROWTH's allowance would report every organization on
GROWTH as drifted, and "a detector that always fires is a detector nobody
reads." Re-applying limits on edit was considered and rejected, because it would
stomp per-subscriber overrides.

So the honest statement is not "nothing detects it" — it is that the one thing
which sees it is required to stay quiet about it, and there is no other signal.

**Cost:** an owner changes a published limit, sees the pricing page update, and
reasonably concludes the change took effect. For anyone already subscribed it
did not. Nothing in the console distinguishes "this edition grants 5,000" from
"this edition grants 5,000 to people who subscribe from now on."

**Fix:** this is the gap E6 is for. Effective dates and revision history make
the question answerable — which numbers applied to whom, from when — where
today there is one mutable row and an `updatedAt`. A narrower stopgap would be
to surface the pre-baseline set in the console: not drift, but "N subscribers
are still on the previous numbers," which at least makes the snapshot visible.

---

## D-15 · A channel refusal can tell an Enterprise customer to upgrade to Free

**Where:** `channelRefusal` in
[`channels.routes.ts`](../apps/backend/src/modules/channels/channels.routes.ts):

```ts
const granting = getEditions().find((edition) => edition.allowedChannels.includes(kind));
```

**What is wrong:** the refusal names the **first edition in ladder order** that
allows the kind, on the reasoning that it is the cheapest one to buy. That
reasoning holds for a capability the ladder grants *upward* — bigger quotas,
more seats — and inverts for one granted *downward*.

Channels are granted downward. After the 2026-09-01 narrowing, `OPENWA` is
allowed by FREE and STANDARD only, so the first edition in ladder order allowing
it is FREE. An ENTERPRISE subscriber who tries to select OpenWA is refused, and
told: *"باقة Enterprise لا تشمل هذه القناة. رقّي إلى Free لتفعيلها"* — upgrade to
Free to enable it.

Measured, not inferred: with the narrowing applied, `getEditions()` returns
`FREE → STANDARD → GROWTH → BUSINESS → ENTERPRISE` and the `find` returns
`Free`.

The refusal itself is correct. Only the advice is nonsense.

**Cost:** a user-facing message that reads as a bug, on a path a Meta-only
subscriber reaches by doing something reasonable. It cannot mislead anyone into
a *purchase* — nobody upgrades to Free — but it destroys confidence in every
other upgrade prompt the product shows, which are generated by the same
mechanism.

Latent before the narrowing: while every edition allowed both kinds, this branch
never executed. It is one of the two things the narrowing armed, the other being
D-13.

**Fix:** deliberately not applied, because the right message is a product
decision rather than a code correction. The shape of it is that "cheapest
edition that grants X" is the wrong question when the asking edition already
outranks every edition that grants it. The options are to say nothing beyond the
refusal (`requiredPlan: null`, which the caller already renders), to name the
nearest granting edition by ladder *distance* rather than by position, or to
route these cases to support — an Enterprise customer wanting OpenWA is a
conversation, not a self-service upgrade. `editionGranting` in
[`usage/entitlements.ts`](../apps/backend/src/modules/usage/entitlements.ts)
carries the identical assumption and will need the same answer.

---

## D-16 · A usage gate failed on the first of the month — RESOLVED

**Fixed 2026-09-01.** Kept as a record because it is the clearest specimen of
[the pattern above](#a-pattern--gates-that-report-on-their-environment-not-on-the-code)
and because the fixture shape that caused it is easy to write again.

`usage: 24h synthetic counters reconcile with Message rows within 1%` built 500
messages spread across 24 hours starting at `now - 23h`, then compared
`getMetricUsage('messages_inbound')` — which sums the **calendar month**, with
bounds built by `Date.UTC` — against `message.count({ timestamp: { gte: syntheticStart } })`,
which counts the whole 24-hour window.

On any day but the first these agree, because the window sits inside one month.
On 2026-09-01 at 05:53 UTC, 17.1 of the 24 hours lay in August: the metric
returned only the September events while the row count returned all 500, and the
check failed at **71.4%** against a 1% tolerance. The code under test had not
changed and had passed five consecutive runs the day before.

It is a two-sided defect. The upper bound was latent and never observed: the
fixture's `+1h` tail would fall into the following month if the gate ran late on
a month's last day.

**Cost while it existed:** one day in thirty, the isolation gate reported a
failure that had nothing to do with isolation — and a red on a gate that usually
passes is read as "the change broke something." It cost the session it appeared
in, and would have cost every first-of-month session after.

**Fix:** clamp the synthetic window to the UTC month at both ends, so the
fixture stays inside the window the metric sums, and spread the 500 rows across
whatever span remains. In UTC deliberately, matching `monthRange` — clamping at
local midnight would have left the same defect displaced by the host's offset,
which is worse, because it would then reproduce only on some machines.

**The general lesson, which is the reason to keep this entry:** a fixture
expressed as a rolling window and an assertion expressed over a calendar period
will agree almost always and disagree on the boundary. If a check compares a
metric to rows, both sides must be scoped the same way, and the cheap way to
find out is to ask what the check does on the first of the month.

---

## D-17 · `pricingModel` decides whether an edition collects money, and nothing says so

**Where:** `isPaidPlan` in
[`plans.ts`](../apps/backend/src/modules/billing/plans.ts), consulted at
`billing.service.ts:237` (the trial fork), `:357` (checkout) and `:421`
(`maybeProvisionGateway`). Settable from `/platform/editions` since `5febfd75`.

**What is wrong:** setting a paid edition's `pricingModel` to `FREE` does far
more than skip checkout. `isPaidPlan` returns false, so `createSignup` treats
the signup as a **trial** — of a *different* plan, `getTrialPlanCode()` — writes
the subscription as `TRIALING` rather than `MANUAL_REVIEW`, email verification
takes the organization to `ACTIVE` because `TRIALING` is access-granting, and
`maybeProvisionGateway` starts a WhatsApp gateway. **The customer receives the
product, free, immediately, and no error is raised anywhere.**

The E5b invariants constrain price against model — `FIXED` must be priced above
zero, `FREE` at zero — and say nothing about what the model *does*. They make the
row internally consistent while the consequence goes unmentioned.

**Cost:** none today, because a human activates every paid signup and would
notice a workspace that went live without being activated. That is exactly the
guardrail that disappears when a real provider is integrated: after that, this is
an owner changing one dropdown and silently making an edition free for everyone
who signs up on it.

**Fix:** not a validation problem — the row is legitimate, the consequence is
just invisible. What is missing is the consequence being *stated* at the point of
the edit, which is E7's consequence preview. A narrower stopgap would be to
refuse `FREE` on an edition that any live subscription references.

---

## D-18 · Two of the seven `PaymentProvider` methods are never called

**Where:** `changeSubscription` and `listInvoices` in
[`payment-provider.ts`](../apps/backend/src/modules/billing/payment-provider.ts).
Documented as part of the contract in
[BILLING-PROVIDER-GUIDE.md](BILLING-PROVIDER-GUIDE.md).

**What is wrong:** nothing in the codebase calls either. `changeSubscription`
exists for upgrade and downgrade, and every plan change goes through
`activateManualSubscription` instead, which rewrites the subscription row
directly and never tells the provider. `listInvoices` exists for the tenant
billing panel, which reads local `Invoice` rows.

**Cost:** a provider author follows the guide's seven-method table and writes two
methods that do nothing — wasted work, and worse, a false expectation that
changing a plan propagates to the provider. With a real provider that gap means
the local subscription and the provider's subscription silently diverge on every
upgrade: the customer is charged the old amount indefinitely.

**Fix:** either call them or delete them from the interface, and correct the
guide either way. The decision is which side of the divergence is authoritative,
which is a design question rather than a cleanup.

---

## D-19 · Provider identifiers are discarded and overwritten

**Where:** `activateManualSubscription` in
[`billing.service.ts`](../apps/backend/src/modules/billing/billing.service.ts).

**What is wrong:** it hardcodes `customerRef = manual_customer_${organizationId}`
and `subscriptionRef = manual_subscription_${organizationId}` and writes them
onto the subscription regardless of what the provider supplied.
`CheckoutStatusResult.subscriptionRef` and `.customerRef` are part of the
contract, are returned by `getCheckoutStatus`, and **are never read by anything**.

**Cost:** none with the manual provider, which invents those strings anyway. With
a real provider it is severe: `cancelSubscription(subscriptionRef)` would be
called with a fabricated `manual_subscription_*` string that means nothing to the
provider, so cancellation would fail or cancel nothing while the local row says
`CANCELED` — a customer who cancels and keeps being charged.

**Fix:** persist what the provider returns, and fall back to the synthetic refs
only when it returns none. The synthetic form is load-bearing for the manual
provider's own `getCheckoutStatus` lookups, so it cannot simply be removed.

---

## D-20 · Idempotency covers webhooks only

**Where:** `PaymentEvent`'s unique `(provider, eventId)` guards
`handlePaymentWebhook`. `reconcileBilling` has no equivalent.

**What is wrong:** `activateManualSubscription` has three callers — the webhook,
the scheduled reconciliation, and the platform console — and only the first is
deduplicated. A webhook and a reconciliation pass can each activate the same
subscription independently, and nothing records that the other did.

**Cost:** currently benign because activation is idempotent in effect: it writes
the same row to the same values. What is not idempotent is what it triggers —
`applyPlanLimits` overwrites `OrganizationConfig` (including any deliberate
manual adjustment, per D-14), and `downgradeGraceEndsAt` is recomputed from
current usage, so two activations minutes apart can produce different grace
windows for the same event.

**Fix:** the shape of it is that activation should be a function of a recorded
event rather than a bare call, so every path names the evidence it acted on.
That is close to E6's revision history, and is likely the same work.

---

## D-21 · A subscription in MANUAL_REVIEW is invisible to the person waiting on it

**Where:** the interaction between `createSignup` writing `MANUAL_REVIEW`
(`billing.service.ts:336`), `verifyEmail` leaving the organization `PENDING`
because `MANUAL_REVIEW` is not in `ACCESS_GRANTING_SUBSCRIPTION_STATUSES`, and
the login gate at `auth.routes.ts:114`.

**What is wrong:** a paid signup verifies their email and then cannot log in. The
refusal is `403 {error: 'Organization is not active'}` — a generic message that
names no cause, no expected wait and no next step. `getServiceState` models
suspended, overdue and trial-expired and has **no state for this one**, and
`decideAccess` would allow the request; both are unreachable anyway, because the
customer never gets a session in which to call them.

**Cost:** today a human is activating the account and presumably also emailing
the customer, so the gap is covered by the same person the flow depends on. Once
payment is automatic the gap becomes the failure mode: a payment that succeeds
but produces no webhook leaves a paying customer at a generic 403, with nothing
telling them to wait, nothing telling them to make contact, and no alert asking
anyone to look. They are indistinguishable from a suspended account.

**Fix:** the state needs a name the tenant can be shown. `getServiceState`
already exists as the place that answers "is something about to go wrong", and
this is the one live state it does not model.

---

## D-22 · Nothing charges a subscription a second time

**Where:** absent, which is the defect. `Subscription.currentPeriodEnd` in
[`schema.prisma`](../apps/backend/prisma/schema.prisma), and the lack of any
reader for it.

**What is wrong:** there is no renewal, expiry or recurring billing logic in
this codebase at all.

`currentPeriodStart` and `currentPeriodEnd` are written by
`activateManualSubscription` (`now`, and `now + 1` UTC month) and read in
**exactly one place** — `platform.routes.ts:278`, a `select` that feeds the
console's "time left" display. **Nothing compares `currentPeriodEnd` to the
present.** `cancelAtPeriodEnd` is written `false` on cancellation and never read
by anything.

So a subscription activated today remains `ACTIVE` indefinitely. The period end
passes in silence. The only exits from `ACTIVE` are a `payment_failed` webhook,
a `subscription_canceled` webhook, the tenant's `/cancel`, an owner action, or
dunning.

**And dunning does not close the loop either.** It reacts to overdue local
`Invoice` rows — and `createInvoice` has exactly one caller, the owner-only
`POST /subscribers/:id/invoices`. Nothing creates an invoice automatically, so
the arrears path depends on a person having raised the debt by hand.

Note the asymmetry with trials, which makes the gap easy to miss: a *trial* has
`trialEndsAt` and its expiry **is** enforced, at the access gate. A paid
subscription has no equivalent.

**Cost:** nothing while payment is manual, because a human is the renewal
process. It becomes the defining gap the moment payment is automatic, and the
shape it takes depends entirely on a choice made outside this codebase:

- With provider-side **subscriptions**, the provider performs the recurring
  charge and this gap stays a gap — the money arrives, and the system simply
  does not react to renewals. Survivable.
- With **one-off charges**, this gap becomes a standing revenue loss: the
  customer pays once and keeps the product forever, because neither the
  provider nor this code will ever charge again.

That difference is why `StripeProvider` creates `mode: 'subscription'` sessions
even though nothing in the code requires a subscription object.

**Fix:** deliberately not built, and deliberately not part of provider
integration — it is a separate missing capability, and conflating the two is how
"we integrated Stripe" gets mistaken for "renewals work". The real fix is close
to E6's effective dates and revision history: a subscription needs a period that
something enforces, and an invoice that something raises.

---

## D-23 · A failed Stripe payment is invisible to this system

**Where:** `STRIPE_EVENT_KINDS` in
[`stripe.provider.ts`](../apps/backend/src/modules/billing/stripe.provider.ts).
`invoice.payment_failed` is deliberately unmapped, so it resolves to `unknown`,
is recorded in `PaymentEvent`, and acts on nothing.

**What is wrong:** when a subscriber's card is declined, Stripe knows and this
system does not. The subscription stays `ACTIVE`, the organization stays
`ACTIVE`, the gateway keeps running, and nothing anywhere says a payment failed.

**Why it is unmapped rather than wired, which is the part worth keeping:** the
only handler available is `markPaymentFailed`, and it **suspends the
organization immediately, with no grace period** — while Stripe retries a failed
invoice over several days. Mapping the first failure would suspend a customer
whose card succeeds on the retry, taking a working service away from someone who
has paid.

Mapping only the *terminal* failure (`next_payment_attempt === null`) was
considered and rejected for a sharper reason: it would give the subscriber full
service through Stripe's entire retry window and then suspend them abruptly with
no warning, because `markPaymentFailed` has no grace of its own. That looks fine
right up until it doesn't, which is worse than a gap somebody knows about.

So the gap is deliberate and visible rather than surprising, and it is honest
about the real state: **there is no dunning policy for provider-reported
failures yet.** The existing dunning machinery has a grace period, a warning
and a `suspendAt` deadline, but it is driven entirely by overdue local `Invoice`
rows raised by hand (D-22) and knows nothing about the provider.

**Cost:** none today — `PAYMENT_PROVIDER` is unset, so no Stripe payment can
fail. It becomes real the moment Stripe is switched on: a subscriber whose card
expires keeps full service indefinitely, and the only signal is a `PaymentEvent`
row of type `invoice.payment_failed` that nothing reads.

**Fix, in order:** write the grace policy first — how long a failed payment has
before it costs access, what the subscriber is told and when — then map the
event to that policy. Mapping first and deciding grace afterwards means choosing
a policy by accident, in an adapter, which is exactly the decision an adapter
should not be making.
