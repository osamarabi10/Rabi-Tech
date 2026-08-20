# P1-D Organization-Scoped Configuration

Completed: 2026-08-19

## Bootstrap Finding

The running backend container supplied `IT_SESSION_NAME=it-support` and
`MARKETING_SESSION_NAME=marketing`, but supplied neither phone-number variable. The old
`isSharedWhatsAppLine()` therefore returned `true` only because `MARKETING_NUMBER` was missing.

The live database contains separate IT and marketing session rows with distinct phone numbers:
`972524141422` and `972524426212`. The migration therefore backfilled the bootstrap subscriber with
`sharedLine = false`. No real shared-line behavior depended on the missing-environment accident.

## Changes

- `OrganizationConfig` owns IT/marketing session names and numbers, alert group, and `sharedLine`.
- New one-session subscribers are provisioned explicitly with `sharedLine = true`.
- `WorkingHours` has one row per organization and compound template foreign keys.
- Keywords load into the current organization request cache and writes invalidate that cache.
- `OrgSequence` allocates ticket labels and conversation display IDs by `(organizationId, kind)`.
- `Conversation.displayId` is unique per organization and no longer uses a global database sequence.
- `runAsPlatform` writes `PlatformAuditLog` before executing the platform operation.
- The process-global group cache was removed. OpenWA's provider cache remains isolated to P1-E.

## Verification

- `npm run build` and `prisma validate` pass.
- The full migration chain applies to a disposable schema and the live database is up to date.
- `npm run test:tenancy` reports `20/24` with both new P1-D assertions passing.
- Forty simultaneous allocations across two organizations independently return `1..20`.
- The running health endpoint writes durable platform audit rows.
- Live backend status is healthy; Redis retains its pre-existing non-critical warning.
