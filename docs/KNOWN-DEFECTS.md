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
