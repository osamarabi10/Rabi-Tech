---
name: rabitech-guide
description: Architecture and conventions guide for RabiTech, a multi-tenant white-label WhatsApp conversation platform (Express + Prisma backend, Next.js frontend). Use this whenever working on this codebase — tenant isolation, conversation flows, auto-replies, campaigns, the WhatsApp gateway, or billing. Also consult before running Prisma migrations or typechecking the backend.
---

# RabiTech guide

A **multi-tenant, white-label WhatsApp customer-conversation platform** — many
independent businesses ("subscribers") each get their own branded workspace,
team inbox, contacts, and broadcasts on their own WhatsApp number. A separate
platform-owner console manages subscribers, plans, and billing.

Backend: Express + Prisma (Postgres) in `apps/backend/src`. Frontend: Next.js in
`apps/frontend`. WhatsApp connectivity runs through a self-hosted OpenWA gateway
driven by webhooks.

> **Read [`docs/PROJECT-SPEC.md`](../../../docs/PROJECT-SPEC.md) first** for verified
> current state, and [`CLAUDE.md`](../../../CLAUDE.md) for the full conventions
> reference. This file is the short orientation.

## The two rules that override everything

1. **Fail-closed tenancy.** Every tenant query runs inside an AsyncLocalStorage
   scope; a query with no scope *throws* rather than reading across tenants.
   Every tenant table carries `organizationId` and a composite FK
   `[id, organizationId]`, so the database rejects a cross-tenant write —
   app-level checks are not the boundary. Never add a tenant table without both.
2. **Nothing customer-facing is hardcoded.** Every message a subscriber's
   customer can receive resolves from that subscriber's own row. If unconfigured,
   **send nothing** — never fall back to placeholder or platform-branded text.
   Defaults live in `constants/default-auto-replies.ts` as *provisioning seed
   data*, never as runtime fallbacks. A subscriber's customers must never see
   "RabiTech".

## Architecture map

| Concern | File |
|---|---|
| Inbound WhatsApp webhook (messages, acks, session status) | `src/webhooks/openwa.webhook.ts` |
| Tenant scope helpers (`runAsOrganization`, `runAsPlatform`) | `src/lib/tenant-context.ts` |
| One-thread-per-contact, reopen-preserving | `src/utils/conversation-session.ts` |
| Auto-reply resolution (resolve-or-send-nothing) | `src/utils/auto-reply.ts` |
| Keyword detection | `src/constants/keywords.ts` |
| Auto-assignment (round-robin / least-open + caps) | `src/modules/routing/assignment.service.ts` |
| Gateway webhook self-healing | `src/utils/webhook-reconcile.ts` |
| RBAC permission matrix | `src/middleware/rbac.middleware.ts` |
| Plan entitlements / seat limits | `src/modules/billing/plans.ts`, `src/modules/usage/entitlements.ts` |
| Frontend API calls + types (single source) | `apps/frontend/lib/data.ts` |

## Hard-won invariants — do not relearn these

- **BullMQ job ids cannot contain `:`** — it is the queue's own key separator.
  Use `--`. Colons here silently broke all inbound *and* all campaign sends.
- **Persist before sending.** Create the `Message` row, then call the gateway.
  Otherwise a gateway failure loses the message while the customer received it.
- **Delivery acks are monotonic** (`sent → delivered → read`). WhatsApp
  redelivers out of order; never let a late duplicate walk status backwards.
- **New env vars must be added to `docker-compose.yml` explicitly** — the
  backend service lists them one by one, so anything missing silently falls back
  to its default inside the container.
- **WhatsApp groups are not supported.** Inbound `@g.us` messages are ignored by
  design; this is a 1:1 platform.

## Arabic dialect convention

Customer-facing text is **Palestinian / Arab48 colloquial**, not MSA — it should
read like a local person texting: "أهلين" not "مرحباً", "بدي/بدك" not
"أريد/تريد", "شو" not "ماذا", "فيني/فيك" for "I/you can". Match the tone in
`constants/default-auto-replies.ts`.

Keep seed copy deliberately minimal and free of business specifics (no phone
numbers, prices, or addresses) — a subscriber should feel they need to
personalise it, not that the platform already spoke for them.

## Required commands after backend changes

```bash
cd apps/backend && npx tsc --noEmit -p .   # typecheck
cd apps/backend && npm run test:tenancy    # isolation gate — must stay green
```

Schema changes: hand-write the SQL migration under
`prisma/migrations/<timestamp>_<name>/`, then `npx prisma generate`, then
`docker compose exec backend npx prisma migrate deploy`.

When WhatsApp "isn't working", read
[`docs/WHATSAPP-GATEWAY-RUNBOOK.md`](../../../docs/WHATSAPP-GATEWAY-RUNBOOK.md) —
inbound-broken and outbound-broken are separate faults with separate causes.
