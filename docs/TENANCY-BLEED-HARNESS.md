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

The analytics summary response includes a generated response timestamp. The runner replaces only that response-time field with a fixed marker before comparison; persisted timestamps remain byte-compared.

## Current Result — 2026-08-19

`30/30` checks pass after P3. The tenant isolation and metering release gate is green.

The suite proves composite database ownership, organization-prefixed sockets, organization-owned
configuration and provider caches, concurrent per-organization sequence allocation, durable
platform-scope auditing, authenticated API snapshots, cross-organization `404` behavior, worker
fail-closed behavior, and overlapping phone/session-name isolation. Do not weaken or skip an
assertion in future changes.
