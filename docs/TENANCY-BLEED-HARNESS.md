# RabiTech Tenant Isolation and Usage Harness

The P1-A release gate runs from `apps/backend`:

```bash
npm run test:tenancy
```

The runner creates a uniquely named PostgreSQL schema, applies the complete migration chain, seeds organization A and an overlapping organization B with ten times the data, runs the checks, and drops the schema. It never writes fixtures into the configured schema.

## Coverage

- Backend typecheck and Prisma-constructor lint.
- Static audits for unreviewed Prisma clients, mutable tenant caches, flat socket rooms, and global `WorkingHours`.
- All three BullMQ job processors invoked without `organizationId`.
- Byte-identical Prisma and authenticated GET snapshots before and after organization B is seeded.
- Bare aggregate isolation and overlapping phone/session-name behavior.
- Cross-organization conversation and media requests.
- Cross-organization socket join rejection and live event delivery isolation.
- Fail-closed query behavior without tenant context.
- A cross-organization child write that must eventually be rejected by a composite database foreign key.
- Usage-event and daily-rollup isolation under asymmetric organization volume.
- Exact MAC semantics against total-contact, conversation, and message-count shortcuts.
- Idempotent daily rollups and append-only usage-event guards.
- Outbound quota rejection while inbound usage remains accepted.
- User profile, onboarding-progress, and notification-preference mutations
  remain scoped to the authenticated subscriber user and reject invalid values.
- Identity-owned TOTP setup/login/disable, encrypted seed storage, challenge
  replay rejection, session revocation, and single-use recovery codes.
- Tenant-scoped, expiring, single-use workspace invitations with role and seat
  enforcement at issuance and acceptance.
- Contact visibility, contact-detail masking, and workflow restrictions enforced
  by the backend even when a caller bypasses the frontend controls.
- Atomic team membership replacement, foreign-user/team rejection, and live
  Socket.io room revocation without disconnecting the affected user.
- Lifecycle rename propagation, atomic default switching, protected terminal
  stages, and deletion with explicit contact reassignment remain tenant-scoped.
- Snippet topics, canned replies, attachments, signed provider-facing asset
  reads, mutation denial, and composite topic assignments remain
  organization-scoped. Dynamic standard, custom, and system variables resolve
  at the final send boundary while unknown variables remain literal.
- Contact Tags and Contact Fields remain organization-scoped across settings,
  Inbox assignment, imports, and custom value writes. The gate covers
  Owner/Manager/Agent permissions, assignment provenance, exact-count Tag
  deletion, immutable field IDs/types, strict typed values, workspace field
  order/visibility, and cross-organization `404` behavior.

The analytics summary response includes a generated response timestamp. The runner replaces only that response-time field with a fixed marker before comparison; persisted timestamps remain byte-compared.

## Current Result — 2026-08-26

`91/91` checks pass as of 2026-08-26. The tenant isolation, provisioning,
billing, analytics, workflow, and usage-metering release gate is green.

The suite proves composite database ownership, organization-prefixed sockets, organization-owned
configuration and provider caches, concurrent per-organization sequence allocation, durable
platform-scope auditing, authenticated API snapshots, cross-organization `404` behavior, worker
fail-closed behavior, and overlapping phone/session-name isolation. Do not weaken or skip an
assertion in future changes.
