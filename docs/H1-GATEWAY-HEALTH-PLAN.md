# H1 — Gateway health monitor · implementation plan

Kill the "customer discovers the outage" mode. The runbook's note is the whole
motivation: inbound-broken and outbound-broken are **separate faults with
separate causes**, and that shapes the design below more than anything else.

Status: **plan only, nothing implemented.** Verified against the tree on
2026-08-21. Gate is currently **52/52**.

---

## 0. Three problems with the spec as written

The first would break every tenant it is meant to protect.

### 0.1 A metered self-send exhausts a Free tenant's entire month in 25 hours

`OpenWAService.sendText` is not a raw send — it is wrapped in `meteredSend`
(`openwa.service.ts:223`), which calls `prepareOutboundSend` →
`assertMetricAvailable('messages_outbound')`.

Every 15 minutes is **96 messages/day, ~2,880/month**. Against the plan
allowances in `plans.ts`:

| Plan | Monthly outbound | Health checks consume | Time to exhaust |
|---|---|---|---|
| FREE | 100 | **2,880%** | **~25 hours** |
| GROWTH | 10,000 | 29% of what they paid for | — |
| BUSINESS | 50,000 | 5.8% | — |

Worse than the consumption: `assertMetricAvailable` **throws** at quota. So the
health monitor stops running exactly when a tenant is at their limit — it goes
blind at the moment the system is most stressed, and a quota block would be
recorded as a gateway failure, producing a CRITICAL alert about the wrong thing.

There is a second meter in the same path: `prepareOutboundSend` resolves the
address to a Contact and can charge `active_contacts` — which is **MAC, the
billing unit**. Health checks would inflate the number customers are billed on.

**Fix:** the health send must bypass metering entirely. See §2.2.

### 0.2 Sending to a configurable third-party number is a ban risk

The spec has `healthCheckPhoneNumber` as a per-org setting — an arbitrary
destination. 96 identical `🔍` messages a day to a human is textbook bot
behaviour on an **unofficial** gateway, and the number that gets banned is the
one the platform runs on. The monitor would destroy the thing it monitors.

The runbook calls this a *self*-send, and that is the right reading: send to the
gateway's **own** number, which WhatsApp supports (message-yourself) and which no
one can report as spam. `OrganizationChannel.phoneNumber` already holds it.

**Consequence:** requirement 7's `healthCheckPhoneNumber` disappears — the
destination is derived, so there is nothing to misconfigure — and with it
requirement 4's "silent failure if the number is invalid".

### 0.3 A status poll alone would have missed the outage that actually happened

The real incident was **outbound 500s while the session reported healthy**. A
status check would have said "fine". That is why a send test has to exist at all.

But a send test is expensive and risky (§0.1, §0.2), and a status poll is free.
So: **two tiers, at different frequencies**, which is the core of this plan.

---

## 1. Design: two signals, not one

| Tier | Signal | Cost | Frequency | Catches |
|---|---|---|---|---|
| **1** | `OpenWAService.getStatus(sessionName)` | one HTTP call, no message | every **5 min** | session dead, disconnected, gateway container down |
| **2** | self-send to the channel's own number | one WhatsApp message | every **6 hours** (configurable) | outbound broken while the session looks healthy — the fault that actually happened |

Tier 2 at 6-hourly is **4 messages/day, ~120/month** — still above a Free
tenant's whole allowance, which is why §2.2's metering bypass is not optional
even after cutting the frequency.

Tier 1 does the real work. Tier 2 exists solely to catch the failure mode Tier 1
is blind to, so it runs as rarely as the detection target allows.

**Orgs that must be skipped, and why alerting on them would be wrong:**

- `OrganizationChannel.provisioningState` is `SUSPENDED` — a deliberately
  suspended gateway is not unhealthy. Without this every suspended tenant emits
  CRITICAL alerts forever.
- `provisioningState` is `PENDING` / `PROVISIONING` / `AWAITING_QR` — not yet
  connected is not a fault.
- `Organization.status !== 'ACTIVE'`.
- No channel row at all.

---

## 2. Backend

### 2.1 New module — `apps/backend/src/modules/gateway/health-monitor.ts`

```ts
export type HealthProbe = 'status' | 'selfSend';
export type HealthResult = { ok: boolean; probe: HealthProbe; error?: string; latencyMs: number };

/** One organization, one probe. Runs inside runAsOrganization. */
export async function probeOrganization(organizationId: string, probe: HealthProbe): Promise<HealthResult>;

/** Every eligible organization. Called by the repeatable job. */
export async function runHealthChecks(probe: HealthProbe): Promise<{ checked: number; failed: number }>;
```

Each org's probe runs inside `runAsOrganization(org.id, …)` — the worker itself
is cross-org, and an unscoped Prisma call throws by design.

### 2.2 Unmetered internal send

`OutboundUsageOptions` (`entitlements.ts:157`) gains one field:

```ts
export type OutboundUsageOptions = {
  campaign?: boolean;
  campaignSubjectId?: string | null;
  /**
   * Platform-originated traffic that must not touch tenant meters — today only
   * the gateway health probe. It is neither charged to the tenant nor blocked
   * when they are at quota: a monitor that stops at the quota ceiling goes
   * blind exactly when the system is most stressed.
   */
  internal?: boolean;
};
```

`meteredSend` skips `prepareOutboundSend` and `recordSuccessfulOutboundSend`
when `internal` is set. Add a tenancy-gate assertion that an internal send
records **no** `UsageEvent` — otherwise this flag silently becomes a way to
under-bill.

### 2.3 Storing the failure window

Requirement: alert when **2 of the last 3** attempts failed.

New table, because "2 of last 3" needs history and a counter on the channel
cannot express it — and the same rows give the stretch dashboard (§4) its data
for free:

```prisma
/// Append-only probe results. Retention is short: this answers "is it up right
/// now", not "what happened last quarter".
model GatewayHealthCheck {
  id             String   @id @default(cuid())
  organizationId String
  probe          String   // 'status' | 'selfSend'
  ok             Boolean
  error          String?
  latencyMs      Int
  createdAt      DateTime @default(now())

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([id, organizationId])
  @@index([organizationId, probe, createdAt])
}
```

Composite unique + `organizationId` per the project rule for tenant tables. A
sweep in the same job deletes rows older than 7 days; without it this table grows
by ~300 rows per org per day and nothing ever reads the old ones.

Consecutive-failure logic reads the last 3 rows **for the same probe** — mixing
a failed self-send with two healthy status polls would mask exactly the fault
Tier 2 exists to find.

### 2.4 Alerting

`PlatformAlert` needs **no migration**. The spec asks for a `resolved` boolean,
but the model uses `resolvedAt: null` as the unresolved marker and there is an
existing resolve pattern at `gateway-provisioning.service.ts:203`
(`updateMany … resolvedAt: null → resolvedAt: new Date()`). Adding a boolean
creates two sources of truth that can disagree; a `resolved` getter in the API
response gives the same ergonomics with one.

Rules:

- **Never create a second open alert.** Before creating, check for an unresolved
  `GATEWAY_UNHEALTHY` for that org. A three-day outage at 5-minute polling would
  otherwise produce ~860 alerts. Update `metadata` (failure count, last error)
  on the existing row instead.
- `type: 'GATEWAY_UNHEALTHY'`, `severity: 'CRITICAL'`, message naming the org and
  probe, `metadata` carrying the last error and the window.
- **Recovery**: the first `ok` result resolves every open `GATEWAY_UNHEALTHY` for
  that org via the existing `updateMany` pattern. Row kept, never deleted.
- **Notify**: `logger.error` with a distinctive marker, plus the alert row. The
  `notifications` module is tenant-facing bell notifications and is the wrong
  channel for platform-owner alerts, so it is deliberately not used. Slack/email
  is a later, separate piece of work.

### 2.5 Worker

`apps/backend/src/workers/gateway-health.worker.ts`, modelled on
`billing-reconciliation.worker.ts` — same queue connection, same
`repeat: { pattern }` shape, same `startX/scheduleX` split.

```
jobId: 'platform--gateway-health-status'      GATEWAY_HEALTH_STATUS_CRON   */5 * * * *
jobId: 'platform--gateway-health-selfsend'    GATEWAY_HEALTH_SELFSEND_CRON 0 */6 * * *
```

Job ids use `--`, never `:` — the queue's own key separator, and colons here
have silently broken both inbound and campaign sends before.

`DISABLE_GATEWAY_HEALTH_WORKER=1` skips it, matching the other workers. Both
cron vars **and** that flag must be added to `docker-compose.yml` explicitly —
the backend service lists env vars one by one, so anything missing silently
falls back to its default inside the container.

### 2.6 Timeout

30 seconds, per the spec — but as an **HTTP timeout on the probe call**, not a
delivery-receipt wait. Waiting for a `message.ack` webhook would mean holding a
job open for 30s per org and correlating an async callback; the ack path already
has its own monotonic-status handling and reusing it here would couple two
unrelated mechanisms. A send that returns a message id is the signal.

### 2.7 Manual trigger

```
POST /api/platform/gateway/health-check/:orgId   requirePlatformOwner
body: { probe?: 'status' | 'selfSend' }   // default 'status'
→ { result: 'ok' | 'failed' | 'skipped', reason?, error?, latencyMs }
```

`'skipped'` is a distinct outcome from `'failed'` — a suspended gateway is not a
failure, and collapsing them would train the owner to ignore the endpoint.

Lives in `platform.routes.ts` beside the other `requirePlatformOwner` gateway
actions. `selfSend` is deliberately available manually: verifying the outbound
path after a fix is exactly when you want it on demand.

---

## 3. Console UI

Platform console, so **English only, no `t()`** — matching
`app/platform/subscribers/page.tsx`.

- A health column on the subscribers row: green / red / grey (skipped), from the
  most recent `GatewayHealthCheck`.
- A "Check now" action running the `status` probe.
- Open `GATEWAY_UNHEALTHY` alerts listed with age and last error.

No per-org configuration screen is needed: §0.2 removes the phone number, and
enablement follows the channel's own state. That is the whole of requirement 7,
deleted rather than built.

---

## 4. Optional (stretch, only if 1–3 land cleanly)

Recent alert history with resolution times, and per-org uptime over 7 days from
`GatewayHealthCheck`. Cheap once the table exists; skip if time is short.

---

## 5. Tenancy — gate 52 → 54

**`gateway health: probe results are organization-scoped`**
Org A's `GatewayHealthCheck` rows are invisible to org B; the alert created for
org A carries org A's id and does not resolve on org B's recovery.

**`usage: an internal send records no UsageEvent`**
The `internal` flag is a bypass around billing. Assert that a probe send leaves
`messages_outbound` and `active_contacts` untouched, and that a normal send still
records both. Without this the flag is one careless `internal: true` away from
silently under-billing every tenant.

---

## 6. Build order

1. `GatewayHealthCheck` migration + `prisma generate` + apply.
2. `internal` flag on `OutboundUsageOptions` + `meteredSend`, with the gate
   assertion. **Verify a normal send still meters** before anything uses it.
3. `health-monitor.ts` — probes and eligibility, no scheduling yet.
4. Manual endpoint. Exercise both probes by hand against the live gateway.
5. Failure window + alert create/resolve.
6. Worker + cron + `docker-compose.yml` env vars.
7. Console column and alert list.

Steps 1–2 touch the billing path and are the only risky ones; 3–7 are additive.

---

## 7. Verification

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/backend && npm run test:tenancy      # 52/52 → 54/54
cd apps/frontend && npm run build
docker compose build backend frontend && docker compose up -d
```

1. **Metering regression first** — a normal send still records `messages_outbound`
   and still blocks at quota. This is the step that can break real sending.
2. Internal send records **no** usage event and is **not** blocked when the org is
   over quota (set a MAC/outbound override to force the condition, then clear it).
3. `status` probe against a healthy gateway → ok, latency recorded.
4. Stop the gateway container → `status` probe fails; **one** failure creates **no**
   alert; the second creates exactly **one** CRITICAL `GATEWAY_UNHEALTHY`; a third
   failure does **not** create a second alert.
5. Restart the gateway → next probe resolves the alert, `resolvedAt` set, row kept.
6. Suspend a channel → probe returns `skipped`, no alert, no row churn.
7. `selfSend` probe delivers to the channel's own number and returns a message id.
   **This sends one real WhatsApp message** — the only step in this project that
   deliberately does, and it goes to the platform's own number, never a customer.
8. Cross-tenant: org B cannot see org A's probe rows or alerts.
9. Retention sweep removes rows older than 7 days.
10. **All test data removed** — probe rows, alerts, and any override used in
    step 2.

---

## 8. Out of scope

Slack/email delivery of alerts, uptime SLA reporting, inbound-path health
(a synthetic inbound message cannot be produced without a second WhatsApp
account), and auto-remediation — restarting a gateway automatically on a failed
probe is a much bigger decision than detecting the failure, and it belongs in its
own phase with its own guard rails.
