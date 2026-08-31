# Known defects

Defects that are understood, reproducible and **not yet fixed**. Each entry
says what is wrong, what it costs, and what fixing it would take. A defect
recorded here is a decision to accept it for now — not a discovery waiting to
be made again by the next person.

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
