# P1.5 / Task 5 Session Report

Date: 2026-08-19

## Pre-change Gate

- `cd apps/backend && npm run test:tenancy` passed before edits: `38/38 checks passed`.

## Task 5 CRM Foundation

- Backup created before migration: `.tools/backups/rabitech-before-crm-20260819-200401.dump`.
- Added additive migration `20260820060000_crm_foundation`.
- Expanded `Contact` with nullable CRM columns only: `firstName`, `lastName`, `email`,
  `language`, `profilePic`, `countryCode`, `lifecycleStage`, `assigneeId`.
- Added `Tag` and `ContactTag`; tags are addressed by `(organizationId, name)`.
- Added `CustomFieldDefinition` and `CustomFieldValue`; field definitions use `text | number |
  date | list`.
- Added composite parent-child FKs on new CRM tables so cross-org tag/custom-field writes are
  rejected by the database.
- Added reusable backend contact filter DSL compiler in `apps/backend/src/lib/contact-filter-dsl.ts`.
- Expanded `/api/contacts` with paginated filtering, `id:` / `email:` / `phone:` contact refs, tag
  APIs, custom-field definition APIs, bulk tag/assign, and contact merge.
- Built reusable frontend `ContactFilterBuilder` and replaced the contacts page with CRM table,
  column chooser, filter builder, bulk tag/assign, cursor pagination, and contact detail dialog.

## Explicit Non-changes

- Did not rename `WhatsappSession`.
- Did not create `ContactChannel`.
- Did not change conversation identity.
- Did not drop or migrate away from `Conversation.labels`.
- Did not restructure `app/(dashboard)/inbox/page.tsx`.
- Did not alter inbound message flow.
- Kept `utils/conversation-session.ts` and `consolidateContactThreads()` unchanged.

## Verification

- `cd apps/backend && npx prisma generate` passed.
- `cd apps/backend && npx prisma migrate deploy` passed.
- `cd apps/backend && npx tsc --noEmit -p .` passed.
- `cd apps/backend && npm run test:tenancy` passed after CRM cases: `40/40 checks passed`.
- `cd apps/frontend && npm run build` passed.
- Gateway provisioner was restarted and is running at the end of the session.

## P6 Provider-Agnostic Billing Foundation

Date: 2026-08-19

- Scope changed before implementation: no Stripe SDK or provider SDK was installed.
- Backup created before provider-agnostic billing migration:
  `.tools/backups/rabitech-before-p6-provider-agnostic-20260819-204029.dump`.
- Added additive migration `20260820070000_provider_agnostic_billing`.
- Added provider-agnostic billing schema: `Plan`, `Subscription`, `Invoice`, `PaymentEvent`,
  `EmailVerificationToken`, and `SignupThrottleEvent`.
- Added opaque organization payment references: `paymentProvider` and `paymentCustomerRef`.
  No provider-specific column names were introduced.
- Added `PaymentProvider` interface in `apps/backend/src/modules/billing/payment-provider.ts`.
- Added `ManualProvider` as the active production path for early manual/bank-transfer onboarding.
- Added `PAYMENT_PROVIDER=manual` default. Unknown provider values fail loudly at startup.
- Added unauthenticated signup, email verification, checkout-status polling, and webhook endpoint.
  The webhook endpoint delegates signature verification to the active provider adapter and stores
  processed events in `PaymentEvent` with `@@unique([provider, eventId])`.
- Added signup throttling by IP address and email domain.
- Free tier signup now creates a verified-dashboard onboarding path with no automatic gateway
  provisioning. Free organizations can request a gateway only after email verification and admin
  action; paid manual activation queues provisioning after verification.
- Added platform owner manual activation, payment-failure, cancel, billing summary, and subscriber
  billing visibility/actions.
- Updated platform subscriber creation so it no longer queues gateway provisioning before email
  verification. Owner activation/request paths now enforce the same verification gate.
- Added billing reconciliation worker that reconciles local subscriptions against the active
  provider via the provider interface.
- Mapped plan entitlements into the existing P3 quota path using `OrganizationConfig` limits.
- Added downgrade policy: downgrades below current MAC do not delete data. The organization receives
  a 30-day grace deadline and outbound remains blocked by the lower P3 quota while inbound metering
  and readable data continue.
- Added frontend pricing, signup, verification, manual activation, checkout-success polling, and
  dashboard billing pages. Pricing copy states that Free does not auto-provision a WhatsApp gateway.
- Added dashboard downgrade/overage banner and platform subscriber billing actions.

## Future Provider Adapter Contract

A real payment provider requires only a new adapter file plus environment variables. The adapter must
implement `PaymentProvider`:

- `createCheckout(organizationId, planCode)` returns `{ checkoutUrl, externalRef }`.
- `getCheckoutStatus(externalRef)` returns provider-reconciled checkout status plus opaque
  subscription/customer refs.
- `changeSubscription(subscriptionRef, newPlanCode)` updates the external subscription.
- `cancelSubscription(subscriptionRef)` cancels the external subscription.
- `verifyWebhook(rawBody, headers)` performs all provider-specific signature validation and returns
  `{ valid, eventId, type, payload }`.
- `listInvoices(customerRef)` returns invoices using the provider-neutral invoice shape.

The rest of the codebase stores only opaque refs and uses the interface for checkout polling,
webhooks, reconciliation, subscription changes, invoices, and provisioning decisions.

## P6 Verification

- `cd apps/backend && npx prisma generate` passed.
- `cd apps/backend && npx prisma migrate deploy` passed.
- `cd apps/backend && npx tsc --noEmit -p .` passed.
- `cd apps/backend && npm run test:tenancy` passed with billing cases: `45/45 checks passed`.
- `cd apps/frontend && npm run build` passed.
- Gateway provisioner was restarted and is running at the end of the session.

## P1.5 De-verticalize Session

Date: 2026-08-19

- Critical pre-check completed before edits. `Zone` had 5 global rows, `Alert` had 0 rows,
  and `Lead` had 0 rows per active organization. No active zone broadcast usage was found.
- Backup created before changes:
  `.tools/backups/rabitech-before-deverticalize-20260819-215503.dump`.
- Added additive migration `20260820080000_add_teams`.
- Added `Team` and `UserTeam`, plus nullable team links on users, sessions, conversations,
  and templates. Existing `IT`, `MARKETING`, and `ADMIN` department data was preserved and
  backfilled into organization-scoped teams.
- Added `/api/system/teams` management endpoints and Settings UI for team creation,
  default-team selection, and safe deletion of unused teams.
- Confirmed Settings -> Keywords UI exists and cleaned its visible category labels away from
  ISP/IT wording. Default keyword vocabulary was changed to a small industry-neutral set while
  preserving the per-organization `Keyword` table for custom vocabulary.
- Fixed the legacy leads page user lookup from `/api/auth/users` to `/api/system/users` to remove
  a stale 404 while the page remains in the app during transition.
- Updated inbound conversation creation and socket emission paths to prefer team rooms:
  `org:{organizationId}:team:{teamId}`. Legacy department fallback remains during transition
  so current live routing is not broken.
- Fixed Socket.IO serving through the same-origin frontend path. `/socket.io` returns 200
  through both backend `:4000` and frontend/LAN `:8080`.
- Ran `scripts\allow-lan.cmd`.
- Fixed the `ostudio` development subscriber channel that was stuck at
  `PENDING / PROVISIONING` on `http://host.docker.internal:3100`. The channel now points at the
  running local OpenWA gateway (`http://openwa:2785`) with the initialized dev API key and
  `ostudio-primary` returns a scannable QR through the frontend proxy.

## P1.5 Verification

- `docker compose build backend` passed.
- `docker compose exec -T backend npx tsc --noEmit -p .` passed.
- `docker compose exec -T backend npm run test:tenancy` passed: `45/45 checks passed`.
- `docker compose build frontend` passed.
- `GET http://192.168.1.38:8080/health` returned healthy.
- `GET http://192.168.1.38:8080/socket.io?EIO=4&transport=polling` returned 200.
- `GET /api/system/sessions/ostudio-primary/qr` through `http://192.168.1.38:8080` returned
  `{ connected: false, qrCode: "data:image/png;base64,..." }`.
- `GET /api/system/teams` returned 4 teams for `admin@rabitech.co.il`.
- `GET /api/system/keywords` returned 8 categories.
- Backend, frontend, Redis, Postgres, and OpenWA containers are running. OpenWA is healthy.

## P1.5 Remaining Gaps

- The large Respond.io-style inbox rebuild is not complete in this session.
- `Department` still exists as a compatibility column/enum and legacy fallback. It should be
  removed only after all UI filters, user forms, session routing, and old `/it`/`/marketing`
  surfaces are converted.
- Zone/Alert models and legacy routes were not dropped. Pre-check shows no live use, so they can
  be hidden/deprecated first and removed in a later destructive migration if still unused.
- Shared-line helpers still need a dedicated cleanup pass after team/channel assignment fully
  replaces route-by-department behavior.
