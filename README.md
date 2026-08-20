# RabiTech — WhatsApp Operations Platform

RabiTech is the platform, infrastructure, and active organization brand.

## Stack
- Backend: Node.js + Express + TypeScript + Prisma + Socket.io + BullMQ
- Frontend: Next.js 14 + Tailwind CSS
- DB: PostgreSQL + Redis
- WhatsApp: OpenWA (self-hosted)

## Quick Start

1. Copy env file:
   cp .env.example .env
   # Fill in OPENWA_API_KEY, JWT_SECRET, phone numbers

2. Start all services:
   docker-compose up -d

3. Run migrations + seed:
   docker compose exec backend npm run db:migrate
   docker compose exec backend npm run db:seed

4. Scan WhatsApp QR codes:
   http://localhost:3000/api/it-support/qr
   http://localhost:3000/api/marketing/qr

5. Open dashboard:
   http://localhost:8080

## Default Login
admin@rabitech.co.il / admin123

This is the seeded administrator for the RabiTech Demo subscriber.

## Platform Owner Login
owner@rabitech.co.il / owner12345

Set `PLATFORM_OWNER_EMAIL` and `PLATFORM_OWNER_PASSWORD` before seeding any non-development environment.

## Service Zones
- Kfar Qasim (HQ) كفر قاسم
- Kfar Bara كفر برا
- Jaljulia جلجولية
- Tayibe الطيبة
- Tira الطيرة

## WhatsApp Sessions
- it-support  → IT helpdesk + monitoring alerts
- marketing   → Campaigns + broadcasts + leads

## Monitoring Alerts (Zabbix/Grafana/Uptime Kuma)
POST http://localhost:4000/api/alerts/incoming
{ "source": "zabbix", "severity": "critical", "title": "...", "body": "..." }

## Multi-Tenancy Implementation Status

Source: `docs/ARCHITECTURE-MULTITENANCY.md`.

### Done / Started
- Read the architecture proposal and started implementing the Phase 0 / Phase 1 foundation.
- Added base tenancy schema models and columns: `Organization`, `Identity`, `organizationId` on tenant data, compound tenant uniques, `tokenVersion`, and `Sequence`.
- Added AsyncLocalStorage tenant context helpers in `apps/backend/src/lib/tenant-context.ts`.
- Added Prisma tenant extension in `apps/backend/src/prisma/extensions.ts` with fail-closed behavior when tenant context is missing.
- Fixed aggregate scoping so bare `count()`, `aggregate()`, and `groupBy()` calls get a tenant `where` even when Prisma args are omitted.
- Migrated login to `Identity` plus org membership lookup and JWT `organizationId` claim.
- Added token revocation support via `tokenVersion` and `/api/auth/logout-all`.
- Protected `/api/network` with JWT auth.
- Protected media proxy endpoints with Bearer auth or short-lived signed URL tokens.
- Resolve OpenWA callbacks through a unique organization-channel token before entering tenant scope.
- Made OpenWA webhook processing resolve the org from the session and run message writes/dedupe checks in tenant context.
- Namespaced incoming-message and escalation BullMQ job ids by `organizationId`.
- Wrapped incoming-message, campaign, and escalation workers in tenant context from job payloads.
- Added explicit `organizationId` writes where TypeScript requires it.
- Added custom lint script banning bare `new PrismaClient()` outside the centralized Prisma module.
- Authorized socket `join_conversation` and `join_group` before joining rooms.
- Fixed `nextTicketLabel()` to use an atomic database sequence instead of `ticket.count()`.

### Verified
- `apps/backend`: `npm.cmd run build` passes.
- Backend TypeScript compilation passes.
- Prisma-client lint passes with zero bare `new PrismaClient()` violations under `apps/backend/src`.

### Still Not Done
- Full composite foreign keys are not complete across all tenant child relations.
- Full per-org OpenWA client factory and `OrganizationChannel` provisioning are not complete.
- Socket room namespacing to `org:{id}:...` is not complete.
- Per-org `WorkingHours` de-singleton is not complete.
- Per-org keyword cache is not complete; current custom keyword cache is still process-global.
- Per-org conversation display id counter is not complete; `Conversation.displayId` still uses global autoincrement.
- Two-tenant bleed-test harness is not built yet.
- Frontend same-origin `/api` rewrite and removal of host-derived API base are not complete.
- Phase 1.5 branding / white-label work is not implemented.
