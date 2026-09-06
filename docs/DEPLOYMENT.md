# Putting RabiTech on a domain

One machine, the compose stack you already run, and a reverse proxy in front.
About an hour, most of it waiting for DNS.

---

## Why not Vercel

Worth stating once, because it is the obvious question and the answer is not
"we prefer Docker".

Vercel is serverless: a function starts, responds, and dies. Four things in this
codebase need a process that stays alive, and one of them is the product.

| | Needs a live process |
|---|---|
| 13 BullMQ workers | inbound routing, campaigns, dunning, mail outbox, backups, gateway health |
| Socket.io | the live inbox holds a WebSocket open |
| `spawn('docker', …)` in `gateway-runtime.ts` | the provisioner launches containers per subscriber |
| `execFile('pg_dump')` | backups need a filesystem that survives the request |

And the one that settles it regardless: **OpenWA cannot be serverless.** It is a
persistent container holding an authenticated WhatsApp session in a browser. If
it stops, the session drops and every subscriber re-scans a QR code.

The Next.js frontend *could* live on Vercel — it is a pure client with no
`route.ts` handlers. But the backend needs a VPS either way, so splitting it
buys a CDN in exchange for two deployments, a CORS configuration and a socket
origin to keep in sync. Put both on the one machine until there is a reason not
to.

---

## The port you develop on is not the port compose serves

Worth stating before anything else, because it is the mistake that wastes a
day and leaves no trace.

**Both app containers** -- `rabitech-frontend-1` and `rabitech-backend-1` --
serve **Docker images built at some point in the past**. Neither reads the
working tree, neither rebuilds when you edit a file, and each will happily
keep serving months-old source while your editor, your gates and your test
suite all agree the code has changed. There is no warning, because from the
browser's point of view nothing is wrong -- the app loads and looks correct.

Both happened here. The frontend image predated the UI vocabulary rename, so
the settings rail still said "Workspace information" long after the rename
shipped and a full Playwright suite had gone green on it. The backend image
then returned `{"error":"Not found"}` for three dashboard endpoints that were
written, typechecked and sitting on disk.

**For local development, use the dev servers:**

```bash
docker compose stop frontend        # release the port; leave the rest running
cd apps/frontend && npm run dev     # http://localhost:8080

docker compose stop backend
cd apps/backend && npm run dev      # http://localhost:4000
```

Keep `postgres`, `redis` and `openwa` up. The frontend dev server proxies
`/api/*`, `/health` and `/socket.io` to whatever is answering on `:4000` via
the rewrites in `next.config.js`, so nothing else needs changing.

The backend is the easier one to be fooled by, because it has no second port:
`:4000` is served from source or from an image depending only on which is
running. The URL cannot tell you which; `docker compose ps` can.

`localhost:3000` serves nothing in this repository -- it is the Next default,
and this project does not use it.

| Where | What it serves | Reflects your edits |
|---|---|---|
| `localhost:8080` | `next dev`, compiled per request | **yes** |
| `localhost:18080` | compose `frontend`, a built image | no, until rebuilt |
| `localhost:8081` | `next start` during `test:e2e` | only after `npm run build` |
| `localhost:4000`, container stopped | `npm run dev` in `apps/backend` | **yes** |
| `localhost:4000`, container running | compose `backend`, a built image | no, until rebuilt |
| `openwa:2785` | the shared gateway, on the compose network | n/a -- reachable from compose services, never from the host |
| `127.0.0.1:13000` | the host mapping of the shared gateway | n/a -- unreliable; closes connections. Do not build on it |

### The provisioning worker is a service, not a shell command

Bring the whole stack up, worker included:

```bash
docker compose up -d --build
docker compose logs -f gateway-worker
```

`gateway-worker` runs `dist/workers/gateway-provisioning.worker.js` from the
backend image with `restart: always`. It is the only process that records a
pairing — `monitorConnection` marks the channel ACTIVE, and nothing in the
request path notices a scan. If it is not running, a customer can scan the QR,
see *device linked* on their phone, and be shown **Disconnected** by the product
indefinitely. That happened on 2026-09-05, to a worker started by hand in a
shell and killed by the OOM killer; the restart policy is the whole point of the
service.

Two things about it are load-bearing and easy to undo by accident:

- **It mounts `/var/run/docker.sock`**, because it builds per-tenant gateways by
  shelling out to `docker compose`. That is root-equivalent access to the host.
  It is mounted on this service **only** — never on `backend`, which runs from
  the same image — so the blast radius stays one container. D-13 records the
  acceptance in full and names the two mitigations.
- **`GATEWAY_HOST_ACCESS=host.docker.internal`.** The code default is
  `127.0.0.1`, which was right while the worker ran on the host and is the
  container itself once it does not. Left unset in a container, every gateway
  readiness probe dials itself and times out.

To run the worker on the host again — debugging, or a machine without a socket
to spare — stop the service and invert that one value:

```bash
docker compose stop gateway-worker
cd apps/backend
GATEWAY_HOST_ACCESS=127.0.0.1 node -r ./scripts/load-env \
  dist/workers/gateway-provisioning.worker.js
```

Never run both. They consume the same BullMQ queue and will race for jobs.

#### Stop the worker before running the gates

```bash
docker compose stop gateway-worker
# ... run gates ...
docker compose start gateway-worker
```

This is not tidiness. `verify-lazy-provisioning` asserts that a connect request
*queues* a build, which means it puts a real job on the real queue and deletes it
again during cleanup. With a worker running, the worker wins the race: it claims
the job, **builds actual tenant containers for the throwaway organizations**, and
the gate then fails its own cleanup with `could not be removed because it is
locked by another worker`. Observed on 2026-09-06 — two orphaned gateway projects,
`lazy-free-…` and `lazy-paid-…`, from a single gate run.

The gate is not wrong; it was written when nothing consumed the queue. Until it
is given its own queue prefix, stopping the worker is the contract.

### The backend must run inside compose when a gateway is involved

The dev-server advice above stops being safe the moment the work touches
pairing, sending or webhooks. The seeded organizations' channel rows point at
`http://openwa:2785` -- the compose-network name, correct for the deployed
topology and **unresolvable from a process started on the host**. The host
port mapping that was meant to bridge that (`127.0.0.1:13000 -> openwa:2785`)
is not reliable: on 2026-09-05 it closed every connection (`curl: (52) Empty
reply from server`) while `:4000`, `:18080` and `:6379` on the same host
answered normally. So a host-run backend either cannot reach the gateway at
all, or reaches it through a proxy that can stop working without logging
anything.

For anything that talks to a gateway, run the backend as the compose service,
rebuilt from the current tree first:

```bash
docker compose up -d --build backend     # rebuild, then serve :4000 from inside the network
docker compose logs -f backend
```

The provisioning worker is the one exception and stays on the host by design
(`docs/GATEWAY-PROVISIONING.md`): it starts containers, reaches each tenant
gateway at `127.0.0.1:<apiPort>`, and tells that gateway to call back at
`host.docker.internal:4000` -- which lands on whichever process holds `:4000`.

This is the fourth instance of the same mistake -- **the thing serving you is
not the thing you think** -- after `:18080` (a stale frontend image), `:4000`
(a stale backend image) and `ts-node-dev`, and the first where the wrong thing
was the network rather than the artifact. The URL looked right; the process
behind it had no route to what the URL named.

---

## Before you point a domain at anything

**Rotate the secrets first.** This repository is public and shipped known
defaults; the database password and `OPENWA_API_KEY` are still those defaults
unless you have changed them. Publishing a domain in front of a known password
is the specific mistake this ordering avoids.

See [`SECURITY-ROTATION.md`](SECURITY-ROTATION.md). Do it before DNS, not after.

---

## 1. A machine

Any VPS with Docker and Docker Compose. Realistic minimum:

- **2 vCPU, 4 GB RAM, 40 GB disk** for the platform itself
- **plus roughly 400 MB of RAM per subscriber gateway** — OpenWA runs a headless
  browser per WhatsApp number, and that is the number that grows

Open only 80 and 443. Postgres and Redis stay on the internal network; the
compose file exposes them on the host for local development and those port
mappings should be removed on a server.

---

## 2. DNS

Two records at your registrar, both pointing at the VPS:

```
A    app.yourdomain.com      →  <server ip>
A    api.yourdomain.com      →  <server ip>
```

One host is possible with path routing, but two is simpler and keeps the socket
origin unambiguous.

---

## 3. TLS, with Caddy

Caddy obtains and renews certificates without being asked. Create `Caddyfile`
beside `docker-compose.yml`:

```caddyfile
app.yourdomain.com {
	reverse_proxy frontend:8080
}

api.yourdomain.com {
	# Socket.io upgrades this connection; Caddy passes it through unchanged.
	reverse_proxy backend:4000
}
```

Add the service to `docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: always
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on:
      - frontend
      - backend
```

…and `caddy_data:` under `volumes:`. **That volume holds your certificates** —
losing it means re-issuing, and Let's Encrypt rate-limits that.

---

## 4. The environment

In `.env`:

```bash
FRONTEND_URL=https://app.yourdomain.com
APP_BASE_URL=https://app.yourdomain.com
FRONTEND_PUBLIC_URL=https://app.yourdomain.com

# Read by the browser. See the warning below.
NEXT_PUBLIC_API_URL=https://api.yourdomain.com
NEXT_PUBLIC_SOCKET_URL=https://api.yourdomain.com

TRUST_PROXY=1
ALLOW_INSECURE_SECRETS=0
```

> **`NEXT_PUBLIC_*` are compiled in, not read at runtime.**
>
> Next.js inlines them into the JavaScript bundle when `next build` runs.
> Setting them in `.env` and restarting does nothing — the value in the bundle
> is whatever was present at build time. They were previously absent, so the
> browser fell back to `http://localhost:4000`: correct on a laptop, and a
> browser talking to itself on a real domain.
>
> They are build arguments now. **Changing the domain means rebuilding the
> frontend image**, not restarting it.

---

## 5. Go

```bash
docker compose build
docker compose up -d
docker compose exec backend npx prisma migrate deploy
```

### What a migration will and will not do to a live database

**`CREATE INDEX CONCURRENTLY` is unavailable here, and index creation therefore
takes a brief write lock.** Prisma Migrate wraps each migration in a
transaction, and PostgreSQL refuses concurrent index builds inside one. So an
index added by a migration blocks writes to that table for as long as the build
takes — seconds on the tables in this product today, longer as they grow.

If a future index is large enough for that to matter, it has to be created
outside the migration: apply the migration without it, then run
`CREATE INDEX CONCURRENTLY` by hand against the live database and record it as
applied. Nothing automates that today, and nothing should pretend to.

**Adding a column is cheap; making it `NOT NULL` need not be expensive.** A
nullable `ADD COLUMN` with no default is metadata-only and instant regardless of
table size. `ALTER COLUMN ... SET NOT NULL` normally scans the whole table under
`ACCESS EXCLUSIVE`, which blocks readers as well as writers — but PostgreSQL
will skip that scan if an equivalent `CHECK (col IS NOT NULL)` has already been
validated, and validating a `NOT VALID` check takes only `SHARE UPDATE
EXCLUSIVE`, which concurrent reads and writes do not block on.

Measured on this server (15.19) against a two-million-row table:

| Statement | Time | Lock |
|---|---|---|
| `SET NOT NULL`, bare | 122.5 ms | `ACCESS EXCLUSIVE` — full scan |
| `ADD CONSTRAINT … CHECK … NOT VALID` | 15.1 ms | brief |
| `VALIDATE CONSTRAINT` | 219.6 ms | `SHARE UPDATE EXCLUSIVE` |
| `SET NOT NULL`, with the validated check | 4.2 ms | `ACCESS EXCLUSIVE` |

More total work, roughly thirty times less of it under the lock that blocks the
application. `20261014090000_workspaces_scope_enforcement` is written that way
and is the worked example.

### How much a guarded `down.sql` actually promises

Every migration in this repository that ships a `down.sql` ships a **guarded**
one, and each has been proved to parse and to **refuse** when live data depends
on it. That is the claim that can be made about all of them.

**It is weaker than it sounds.** Only the Workspaces migrations have been proved
to *reverse*: run for real against a populated database, then re-applied, with
row counts checked identical on both sides. For every other `down.sql` here,
what is known is that the guards fire — not that the reversal leaves a working
database.

Do not read "we have guarded down migrations" as "we can roll back". Before
relying on one that has not been exercised, take the backup first
(`pg_dump -Fc`, confirmed with `pg_restore -l`), and expect to need it.

```bash
# TLS is real, not self-signed
curl -sI https://app.yourdomain.com | head -1

# the API answers on its own host
curl -s https://api.yourdomain.com/api/billing/plans | head -c 80

# the boot log is clean — no insecure secrets, mail is configured
docker compose logs backend --tail 40 | grep -iE "insecure|smtp|backup worker"
```

Then in a browser, signed in: open the inbox and confirm a new message appears
**without a refresh**. That is the socket working through Caddy, and it is the
one thing that silently fails if the origin is wrong.

---

## Known gap: automatic gateway provisioning

> **Superseded 2026-09-06.** Provisioning is no longer a gap and no longer runs
> from a shell. It is the `gateway-worker` compose service, described under
> *The provisioning worker is a service, not a shell command* above, and it
> mounts the Docker socket deliberately — see D-13 for the price and the two
> named mitigations. The text below is kept for the reasoning that led here.
**Superseded 2026-08-19; the reasoning below is kept.** Provisioning no longer
runs in the backend container: `gateway-provisioning.worker.ts` runs on the
Docker host and is the only process that invokes Docker Compose
(`docs/GATEWAY-PROVISIONING.md`). That is option 2 below, taken. The socket is
not mounted and must not be. What is still open is *where* that worker runs in
production and who keeps it running: on 2026-09-05 it was running nowhere, and
every Connect queued a build that nothing consumed (D-5).

`gateway-runtime.ts` provisions a subscriber's WhatsApp gateway by running
`docker compose` as a child process. **The backend container has neither the
Docker CLI nor a mounted Docker socket**, so that call fails as currently
deployed. Existing gateways were configured by hand.

It is not a problem until the first self-serve subscriber needs a number of
their own, at which point it is a blocker. Two ways out:

1. **Give the backend the socket.** Mount `/var/run/docker.sock` and install the
   Docker CLI in the image. Simple, and worth understanding clearly: a container
   with the Docker socket can start any container on the host. It is root on the
   machine by another name.
2. **Move provisioning out of the backend** into a small privileged agent that
   accepts a narrow set of commands. More work, and the boundary is real.

Do not mount the socket casually because option one is shorter. Decide it
deliberately.

---

## Backups on a server

The nightly job writes to `./.tools/backups` on the host, and that directory is
on the same disk as everything else — which is not a backup, it is a copy.

Add off-machine sync once the domain is live: `rclone`, `restic`, or the
provider's own snapshots, on a schedule of its own. The verification step
already proves each dump restores; getting it off the box is the part still
missing.
