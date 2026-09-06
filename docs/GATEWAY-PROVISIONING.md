# Gateway Provisioning

Implemented: 2026-08-19

## Runtime boundary

The backend API is a queue producer only. `gateway-provisioning.worker.ts` is the only application
process that invokes Docker Compose, and since 2026-09-06 it runs as the **`gateway-worker` compose
service** with `restart: always`:

```bash
docker compose up -d gateway-worker
docker compose logs -f gateway-worker
```

It is the only process that records a pairing, so an unsupervised one fails silently and totally:
the customer scans, their phone says *device linked*, and the product says Disconnected forever.
It mounts `/var/run/docker.sock` — root-equivalent host access, on this service only, accepted
deliberately in D-13.

The Windows scheduled-task installer this section used to document was deleted on 2026-09-06. It
started a competing worker on the same queue through `npm run gateway:worker`, which is ts-node at
~390 MB and the configuration the OOM killer took twice. Never run two: they race for jobs.

For foreground diagnostics, stop the service first and run the compiled entry point, inverting the
one value that differs on a host (see `GATEWAY_HOST_ACCESS` below):

```bash
docker compose stop gateway-worker
cd apps/backend && GATEWAY_HOST_ACCESS=127.0.0.1 \
  node -r ./scripts/load-env dist/workers/gateway-provisioning.worker.js
```

## Persisted machine

Each managed `OrganizationChannel` stores its provisioning state, current/failure step, deployment
name, port pair, and volume names. The worker persists the next step before invoking its guarded
side effect. Compose project names, volumes, session creation, and webhook registration are stable
or checked before creation, so jobs resume after interruption without duplicating resources.

The lifecycle is:

`PENDING -> PROVISIONING -> AWAITING_QR -> ACTIVE -> SUSPENDED`

Terminal retries move the channel to `FAILED`, preserve the failed step/reason, and create a
`PlatformAlert`. The platform owner can retry, suspend, resume, restart, or destroy the gateway.
Suspension stops containers without removing volumes.

**Do not call `destroy`.** It runs Compose `down --volumes` and then deletes the Organization row
and its identities — the tenant, not just the gateway. That is a defect, recorded as D-15, and it
is unfixed. Retire a gateway by tearing down its Compose project directly and marking the channel
`FAILED`.

## Configuration

- `GATEWAY_PORT_START` / `GATEWAY_PORT_END`: host allocation range, default `3100..3999`.
- `GATEWAY_BACKEND_HOST`: hostname the backend container uses for a host gateway, default
  `host.docker.internal`.
- `GATEWAY_HOST_ACCESS`: hostname the worker uses to reach a tenant gateway's published port,
  default `host.docker.internal`. It was `127.0.0.1`, correct only while the worker ran on the
  host; inside a container that is the container, and every readiness probe dials itself. Set it
  back to `127.0.0.1` when running the worker on the host. See D-14.
- `BACKEND_INTERNAL_URL`: webhook base reachable from subscriber containers, default
  `http://host.docker.internal:4000`.
- `GATEWAY_COMPOSE_FILE`: optional absolute Compose template path.
- `GATEWAY_WORKER_CONCURRENCY`: concurrent organizations, default `4`.

Generated OpenWA API keys remain AES-GCM encrypted in `OrganizationChannel.apiKeyEnc`. API keys and
webhook tokens are never returned by platform list/action responses or written to worker logs.

## Verification

`npm run test:tenancy` is green at 35/35. Provisioning cases cover concurrent isolated allocation,
resume after a simulated mid-create interruption, suspend/resume volume preservation, terminal
failure alerts, destructive cleanup, and no state change in another organization.
