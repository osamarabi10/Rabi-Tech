# Gateway Provisioning

Implemented: 2026-08-19

## Runtime boundary

The backend API is a queue producer only. `gateway-provisioning.worker.ts` runs on the Docker host
and is the only application process that invokes Docker Compose. Install it once on the Windows
host with:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\install-gateway-provisioner-task.ps1
```

For foreground diagnostics, run `npm run gateway:worker` from `apps/backend`. Runtime logs and the
PID file are stored under `.runtime/gateway-provisioner/`.

## Persisted machine

Each managed `OrganizationChannel` stores its provisioning state, current/failure step, deployment
name, port pair, and volume names. The worker persists the next step before invoking its guarded
side effect. Compose project names, volumes, session creation, and webhook registration are stable
or checked before creation, so jobs resume after interruption without duplicating resources.

The lifecycle is:

`PENDING -> PROVISIONING -> AWAITING_QR -> ACTIVE -> SUSPENDED`

Terminal retries move the channel to `FAILED`, preserve the failed step/reason, and create a
`PlatformAlert`. The platform owner can retry, suspend, resume, restart, or destroy the gateway.
Suspension stops containers without removing volumes; destruction runs Compose `down --volumes`
before deleting the organization.

## Configuration

- `GATEWAY_PORT_START` / `GATEWAY_PORT_END`: host allocation range, default `3100..3999`.
- `GATEWAY_BACKEND_HOST`: hostname the backend container uses for a host gateway, default
  `host.docker.internal`.
- `GATEWAY_HOST_ACCESS`: hostname the host worker uses for health calls, default `127.0.0.1`.
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
