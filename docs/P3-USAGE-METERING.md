# RabiTech P3 Usage Metering and Quotas

Status: complete on 2026-08-19.

## Data model

`UsageEvent` is the tenant-scoped, append-only source ledger. Application-level Prisma guards reject
update, upsert, and delete operations. Each event carries `organizationId`, `metric`, `quantity`,
optional `subjectId`, and `occurredAt`.

`PlatformDailyMetric` is the replaceable rollup keyed by `(organizationId, date, metric)`. It is the
only usage source used by platform-owner views. Normal message, campaign, and token values are daily
totals. `active_contacts` is a month-to-date distinct-contact snapshot as of that date.

Supported metrics:

- `messages_inbound`
- `messages_outbound`
- `active_contacts`
- `ai_tokens_in`
- `ai_tokens_out`
- `campaign_sends`

AI token metrics are reserved but dormant. P5 is deferred and they remain at zero until the product
owner explicitly resumes that phase.

## MAC contract

Monthly Active Contacts is the count of distinct contacts with at least one inbound or outbound
message in the UTC calendar month for one organization. It is not total contacts, conversations, or
messages.

The automated definition fixture has 500 contacts, 4 conversations, and 7 messages across 3
messaged contacts. The asserted MAC is 3, so each incorrect interpretation fails. A separate
24-hour fixture reconciles 500 messages across 50 contacts with 0% message and MAC error.

## Capture and enforcement

Inbound usage is recorded after the inbound `Message` row is durable. A metering failure is logged
but cannot reject or retry the customer message.

Outbound and campaign quotas are checked immediately before the OpenWA provider call. Successful
provider calls append message, active-contact, and optional campaign usage. Quota errors return HTTP
`429` with `code`, `metric`, `current`, `limit`, and `resetsAt`. Campaign jobs blocked by quota remain
pending, and failed BullMQ jobs are retained for operational retry.

Limits currently live on `OrganizationConfig`. Null means unlimited. P6 can map paid plans onto the
same declarative entitlement fields without changing send paths.

## Rollups

BullMQ scheduler `platform:usage-rollup-nightly` runs at 00:15 UTC and queues one organization-owned
job per subscriber for the previous UTC day. Organization job IDs use
`<organizationId>:usage-rollup:<YYYY-MM-DD>`.

Every rollup recomputes and upserts exact values, so rerunning a date does not add to prior results.
Backfill an inclusive UTC date range with:

```powershell
cd apps/backend
npm run usage:backfill -- 2026-08-01 2026-08-19
```

Organization discovery uses audited `runAsPlatform`; aggregation runs separately under each
organization scope.

## Visibility

- Subscriber: `GET /api/usage/current` and the monthly meters in `/settings`.
- Platform owner: `GET /api/platform/subscribers/:id/usage` and usage columns in
  `/platform/subscribers`. These values come only from `PlatformDailyMetric`.
- Warning states begin at 80%; the limit state begins at 100%.

## Verification

- Backend production build: pass.
- Frontend production build: pass.
- Disposable full migration chain: pass.
- `npm run test:tenancy`: `30/30` pass.
- P3 migration: `20260820020000_add_usage_metering`.
- Pre-migration backup: `.tools/backups/rabitech-before-p3-20260819.dump`.
