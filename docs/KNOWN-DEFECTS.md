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
