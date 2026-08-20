# P1-E OpenWA Isolation

Isolation implementation completed: 2026-08-19

## Provider Boundary

- `OrganizationChannel` stores one organization/kind record with base URL, encrypted API key,
  unguessable webhook token, and status.
- API keys use AES-256-GCM under `CHANNEL_ENCRYPTION_KEY`; platform responses never return them.
- `openwa.service.ts` creates its Axios client inside organization scope.
- Session name/UUID entries live inside that provider with a 60-second TTL and cannot collide with
  another organization's identically named session.
- Message delivery and QR/pairing are exposed separately through `OpenWAService` and
  `OpenWAPairingProvider`.

The inventory covered 36 provider operations across workers, webhooks, media proxies, conversation,
campaign, alert, system, out-of-hours, welcome, ticket automation, and feedback paths.

## Webhooks

Inbound callbacks use `POST /webhooks/openwa/:webhookToken`. The token resolves an active channel in
platform scope, then the request enters that organization scope before resolving provider session
IDs or writing data. Unknown or inactive tokens return `404`.

`scripts/configure-openwa-webhooks.ts` registers every provider session and is idempotent. The live
bootstrap run created two registrations; the immediate second run created zero.

## Provisioning

New subscribers receive a managed `PENDING` channel and an organization-namespaced BullMQ job. The
host-side worker drives the persisted, resumable
`PENDING -> PROVISIONING -> AWAITING_QR -> ACTIVE -> SUSPENDED` lifecycle through the isolated
Compose template. Port pairs, project names, volumes, API keys, and webhook tokens are allocated
per organization. See `docs/GATEWAY-PROVISIONING.md`.

QR pairing remains subscriber-admin-only. Session status webhooks and scheduled checks transition
the channel to `ACTIVE` automatically. Suspension preserves volumes; destroy-on-organization-delete
removes containers and volumes before deleting tenant data. This removes the manual gateway step
that previously blocked P6.

## Verification

- Full backend build and clean 22-migration chain pass.
- The tenancy and provisioning harness is green at `35/35`.
- The live encrypted channel reaches the provider and sees both bootstrap sessions.
- Invalid webhook tokens return `404`; the stored token returns `200` in organization scope.
- Backend health is green except for the pre-existing non-critical Redis warning.
