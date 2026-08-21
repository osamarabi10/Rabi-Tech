# P9 — Platform owner pricing control · implementation plan

Unblocks P10-b (payments) and makes enterprise deals manageable without SQL.

Status: **plan only, nothing implemented.** Every file path below was verified
against the tree on 2026-08-21.

---

## 0. Corrections to the brief

Nine things in the original requirements do not match the code. They change the
design, so they come first.

| # | Brief says | Reality | Consequence |
|---|---|---|---|
| 1 | `apps/backend/src/features/organization/` | No `features/` directory exists; the convention is `src/modules/<domain>/` | Paths below use `modules/` |
| 2 | `apps/frontend/src/app/platform/subscribers/` | No `src/` under the frontend; it is `apps/frontend/app/platform/subscribers/page.tsx` | Path corrected |
| 3 | "create `PlatformAuditLog` table" | **It already exists** (`schema.prisma:311`) as `{id, reason, timestamp}`, written by `auditPlatformScope()` in `src/lib/audit.ts:18`. It is also **already listed** in the tenancy extension's `PLATFORM_MODELS` | Extend it; do not create it. Every new column must be nullable so the existing writer keeps working |
| 4 | `planOverride` enum `FREE\|GROWTH\|ENTERPRISE` | `Organization.tier` is a **`String`**, not an enum, and `PlanCode` has **four** values — `BUSINESS` is missing from the brief | See §2. Omitting BUSINESS means an owner cannot grant the £199 tier |
| 5 | `overrideSetBy (uuid)` | The platform actor is an **`Identity`** (`Identity.id` is a **cuid**, not a uuid). A platform owner has **no `User` row** in the target org | Column is `TEXT`. This is also why `AuditLog` cannot be reused — its `user` relation is a composite FK `[userId, organizationId]` that a platform owner cannot satisfy |
| 6 | `macQuotaOverride` "overrides all usage meters" | There are six metrics with wildly different scales (`active_contacts` ~2 500 vs `ai_tokens_in` ~millions). One integer cannot sensibly mean all six | See §2.3 — recommend MAC-only, with a documented extension path |
| 7 | — | `detectQuotaDrift()` (`billing.service.ts:563`) compares plan defaults against enforced config. A deliberate override would register as **drift on every overridden org** | See §3.3 — this is the single biggest interaction in P9 |
| 8 | — | There are **two independent** entitlement paths today: metered quotas read `OrganizationConfig` columns (`entitlements.ts:61`), seats read `Organization.tier` (`entitlements.ts:110`) | The resolver must unify both or overrides will apply to quotas but not seats |
| 9 | "Frontend i18n: en/he/ar" | The platform console is **deliberately English-only** (`app/platform/subscribers/page.tsx` has zero `t()` calls); the tenant `subscription-card.tsx` uses `t()` 13 times | i18n applies to requirement 5 (tenant), not requirement 4 (console) |

---

## 1. The architectural decision that shapes everything

**Overrides are resolved at read time. They are never written into
`OrganizationConfig`.**

The tempting alternative is write-through: when an owner sets a MAC override,
push the number into `OrganizationConfig.monthlyActiveContactsLimit` so the
existing enforcement path picks it up with no code change. Reject it, for three
reasons:

1. **Expiry stops working.** `overrideExpiresAt` requires that the override
   simply *stops applying*. A written-through number has no memory of where it
   came from, so expiry would need a sweeper job — and if that job fails, the
   tenant silently keeps quota they no longer have. Read-time expiry cannot fail.
2. **Drift detection breaks permanently.** `OrganizationConfig` currently means
   "the numbers this plan grants". Writing overrides into it destroys that
   meaning, and `detectQuotaDrift` — built precisely because tier and config
   drifted once — would fire on every overridden org until someone disabled it.
3. **The audit trail stops being the truth.** With write-through, the state that
   is enforced and the state that was approved live in different tables and can
   disagree. Resolving at read time makes `Organization` the single record of
   what was granted.

The cost is real and worth naming: **every enforcement site must call the
resolver instead of reading config directly.** There are two
(`assertMetricAvailable`, `assertSeatAvailable`) plus the billing summary. §3.4
lists them.

Layering after this change:

```
plans.ts                 static catalogue, no DB          (unchanged)
        ↑
entitlements.resolver.ts NEW — override → subscription → tier
        ↑                                    ↑
entitlements.ts                     billing.service.ts
(enforcement)                       (summary, activation)
        ↑                                    ↑
  routes / workers              platform.routes.ts
```

No cycle: `billing.service.ts` does not import `entitlements.ts` today, and the
resolver imports only `prisma`, `plans.ts` and `tenant-context`.

---

## 2. Migration

`apps/backend/prisma/migrations/20260822090000_platform_pricing_control/migration.sql`

### 2.1 Why `planOverride` is `TEXT`, not an enum

`Organization.tier` is a `String` with a comment listing the allowed values.
Adding `planOverride` as a Postgres enum would put two different types on the
same concept in the same row, and every resolver comparison would need a cast.
Worse, a Prisma enum would have to be kept in sync with `PlanCode` in
`plans.ts`, which is already the single source of truth and already rejects
unknown codes via `normalizePlanCode()`.

`TEXT` plus a `CHECK` constraint gets database-level integrity without the type
mismatch — and unlike a Prisma enum, `CHECK` also documents the values where a
DBA will actually see them.

**Note the value list includes `BUSINESS`.** Omitting it, as the brief does,
would mean the owner can grant Free, Growth and Enterprise but not the tier
between Growth and Enterprise — the one most likely to be hand-negotiated.

### 2.2 SQL

```sql
-- P9: platform-owner commercial control.
--
-- These columns are read at request time by entitlements.resolver.ts and are
-- deliberately NOT mirrored into OrganizationConfig: that table means "what this
-- plan grants", and overriding it in place would break both override expiry and
-- the quota-drift detector that exists because tier and config drifted once.

ALTER TABLE "Organization"
  ADD COLUMN IF NOT EXISTS "planOverride"      TEXT,
  ADD COLUMN IF NOT EXISTS "macQuotaOverride"  INTEGER,
  ADD COLUMN IF NOT EXISTS "discountPercent"   INTEGER,
  ADD COLUMN IF NOT EXISTS "creditCents"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "overrideReason"    TEXT,
  ADD COLUMN IF NOT EXISTS "overrideExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "overrideSetBy"     TEXT,
  ADD COLUMN IF NOT EXISTS "overrideSetAt"     TIMESTAMP(3);

-- Value integrity at the database, not only in the route handler. Mirrors the
-- PlanCode union in modules/billing/plans.ts — BUSINESS included.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_planOverride_check"
    CHECK ("planOverride" IS NULL
           OR "planOverride" IN ('FREE','GROWTH','BUSINESS','ENTERPRISE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_discountPercent_check"
    CHECK ("discountPercent" IS NULL
           OR ("discountPercent" >= 0 AND "discountPercent" <= 100));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Negative credit would be a debt, which this column does not model. If debt is
-- ever needed it belongs on Invoice, not here.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_creditCents_check"
    CHECK ("creditCents" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_macQuotaOverride_check"
    CHECK ("macQuotaOverride" IS NULL OR "macQuotaOverride" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- A reason is mandatory whenever anything is overridden. Enforced in the route
-- for a friendly message AND here, so a future writer cannot bypass it.
DO $$ BEGIN
  ALTER TABLE "Organization" ADD CONSTRAINT "Organization_override_reason_required"
    CHECK (
      ("planOverride" IS NULL AND "macQuotaOverride" IS NULL
        AND "discountPercent" IS NULL AND "overrideExpiresAt" IS NULL)
      OR ("overrideReason" IS NOT NULL AND length(btrim("overrideReason")) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The console lists overrides that are live or expiring; without this it is a
-- full scan of every subscriber on every console load.
CREATE INDEX IF NOT EXISTS "Organization_overrideExpiresAt_idx"
  ON "Organization" ("overrideExpiresAt")
  WHERE "overrideExpiresAt" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- PlatformAuditLog already exists as {id, reason, timestamp}, written by
-- auditPlatformScope(). Every column added here is NULLABLE so that writer
-- keeps compiling and its existing rows stay valid.
-- ---------------------------------------------------------------------------

ALTER TABLE "PlatformAuditLog"
  ADD COLUMN IF NOT EXISTS "action"          TEXT,
  ADD COLUMN IF NOT EXISTS "actorIdentityId" TEXT,
  ADD COLUMN IF NOT EXISTS "actorEmail"      TEXT,
  ADD COLUMN IF NOT EXISTS "targetOrgId"     TEXT,
  ADD COLUMN IF NOT EXISTS "targetOrgName"   TEXT,
  ADD COLUMN IF NOT EXISTS "beforeState"     JSONB,
  ADD COLUMN IF NOT EXISTS "afterState"      JSONB,
  ADD COLUMN IF NOT EXISTS "ipAddress"       TEXT;

CREATE INDEX IF NOT EXISTS "PlatformAuditLog_targetOrgId_timestamp_idx"
  ON "PlatformAuditLog" ("targetOrgId", "timestamp");
CREATE INDEX IF NOT EXISTS "PlatformAuditLog_action_timestamp_idx"
  ON "PlatformAuditLog" ("action", "timestamp");
```

**`targetOrgId` and `actorIdentityId` carry no foreign key, deliberately.**
`PlatformAlert` uses `onDelete: SetNull`, which is right for an alert and wrong
for an audit log: deleting a subscriber would blank out which subscriber the
record was about, destroying exactly the evidence the log exists to keep.
`targetOrgName` is a denormalised snapshot for the same reason — the log must
stay readable after the org is gone.

### 2.3 `macQuotaOverride` scope — decide before building

The brief says it "overrides all usage meters", but one integer cannot mean
`active_contacts` (~2 500) and `ai_tokens_in` (~millions) at once.

**Recommendation: MAC only.** MAC is the commercial billing unit, it is what
requirement 4's UI describes ("MAC quota: number input"), and it is the number
enterprise deals are actually negotiated on. The other five meters follow the
effective plan.

If per-metric overrides are wanted later, add `quotaOverrides JSONB` keyed by
`UsageMetric` and have the resolver check it *before* `macQuotaOverride`. That
is additive and needs no migration of existing rows — which is why it is safe to
defer rather than over-build now.

### 2.4 Prisma schema additions

`apps/backend/prisma/schema.prisma` — `model Organization`, after
`downgradeGraceReason`:

```prisma
  /// Platform-owner commercial overrides. Resolved at read time by
  /// entitlements.resolver.ts; never mirrored into OrganizationConfig.
  /// planOverride mirrors PlanCode in modules/billing/plans.ts and is
  /// constrained in SQL — keep the two in step.
  planOverride      String?
  macQuotaOverride  Int?
  discountPercent   Int?
  creditCents       Int       @default(0)
  overrideReason    String?
  overrideExpiresAt DateTime?
  /// Identity.id of the platform owner who set it. No FK: an audit trail must
  /// outlive the actor.
  overrideSetBy     String?
  overrideSetAt     DateTime?

  @@index([overrideExpiresAt])
```

`model PlatformAuditLog`:

```prisma
model PlatformAuditLog {
  id        String   @id @default(cuid())
  reason    String
  timestamp DateTime @default(now())

  /// Everything below is nullable: auditPlatformScope() writes reason-only rows
  /// and predates these columns.
  action          String?
  actorIdentityId String?
  actorEmail      String?
  /// Plain strings, not relations — see the migration comment.
  targetOrgId     String?
  targetOrgName   String?
  beforeState     Json?
  afterState      Json?
  ipAddress       String?

  @@index([timestamp])
  @@index([targetOrgId, timestamp])
  @@index([action, timestamp])
}
```

Then: `cd apps/backend && npx prisma generate`, and apply per CLAUDE.md.

---

## 3. Entitlement resolution

### 3.1 New file

`apps/backend/src/modules/billing/entitlements.resolver.ts`

```ts
import { UsageMetric } from '@prisma/client';
import { prisma } from '../../prisma';
import { PLAN_ENTITLEMENTS, PlanCode, normalizePlanCode } from './plans';

export type EffectiveEntitlements = {
  /** The plan actually in force, after overrides. */
  plan: PlanCode;
  planName: string;
  /** Where `plan` came from — drives the "عرض خاص" badge and the console. */
  source: 'override' | 'subscription' | 'tier';
  limits: Record<UsageMetric, number | null>;
  seatLimit: number | null;
  /** True when any override is live right now. */
  isOverridden: boolean;
  override: {
    plan: PlanCode | null;
    macQuota: number | null;
    discountPercent: number | null;
    creditCents: number;
    reason: string | null;
    expiresAt: Date | null;
    /** Set when an override exists on the row but has passed its expiry. */
    expired: boolean;
  };
  /** Plan price after discount — display only until P10-b. */
  listPriceCents: number;
  effectivePriceCents: number;
};
```

### 3.2 Resolution order

```
planOverride (live)  →  Subscription.planCode (status ACTIVE|TRIALING)  →  Organization.tier
```

Rules that are easy to get wrong:

- **Expiry is `<=` on a timestamp compared once per call.** Compute `now` a
  single time and pass it down; comparing `new Date()` at three different points
  in one resolution can straddle the boundary and produce a self-inconsistent
  answer.
- **An expired override is ignored but not erased.** The columns stay so the
  console can show "expired 3 days ago" and the owner can see what the deal was.
  `expired: true` drives that. Never auto-clear the columns — that would delete
  the record of a commercial agreement.
- **`macQuotaOverride` survives an expired `planOverride` only if it has its own
  life.** Simplest correct rule, and the one to implement: `overrideExpiresAt`
  governs *all* override fields together. One deal, one expiry. Document it in
  the dialog so the owner is not surprised.
- **`creditCents` never expires.** Credit is money already granted; expiring it
  silently would be taking it back. It sits outside `overrideExpiresAt`.
- **Subscription must be filtered by status.** A `CANCELED` subscription row
  still carries a `planCode`; using it would resurrect a plan the tenant left.
  Accept `ACTIVE` and `TRIALING` only.
- **`normalizePlanCode` throws on unknown input.** Wrap the override read in a
  try/catch and fall through to the next source rather than 500-ing the whole
  request. A bad value in one column must not take down billing for everyone.

```ts
export async function resolveEntitlements(
  organizationId: string,
  now = new Date(),
): Promise<EffectiveEntitlements> { /* … */ }

/** Convenience for the enforcement path. */
export async function resolveMetricLimit(
  organizationId: string,
  metric: UsageMetric,
  now = new Date(),
): Promise<number | null>;
```

`resolveEntitlements` reads `Organization` (with its `subscriptions` filtered to
active) in **one** query. It must not read `OrganizationConfig` — that table is
now strictly "what the plan granted", and mixing it back in would re-couple the
two stores this design separates.

Because `Organization` is in `PLATFORM_MODELS`, the extension does **not** inject
`organizationId`. The resolver therefore takes `organizationId` explicitly and
must always pass it in `where` — see §6 for the gate check that enforces this.

### 3.3 Quota drift after P9 — the interaction to get right

`detectQuotaDrift` (`billing.service.ts:563`) compares `PLAN_ENTITLEMENTS[tier]`
against the enforced number. Once overrides exist and are resolved at read time,
the *enforced* number is no longer `OrganizationConfig` — it is the resolver's
output. Without a change, every overridden org reports drift, and a detector
that always fires is a detector nobody reads.

Change it to compare **three** values and classify:

| Plan default | Effective (resolver) | Config (enforced by legacy path) | Verdict |
|---|---|---|---|
| 2 500 | 2 500 | 2 500 | clean |
| 2 500 | 10 000 | 2 500 | **intentional override** — not drift |
| 2 500 | 2 500 | 10 000 | **drift** — config diverged out of band |
| 2 500 | 10 000 | 10 000 | drift *and* override — flag: someone wrote through |

The fourth row is the one that matters: it means a previous mechanism wrote the
override into config, which is exactly what §1 forbids. Detecting it catches a
regression of this design.

Rename the field on the summary from `quotaDrift` to keep its meaning, or keep
the name and add `overrides` alongside. Keeping `quotaDrift` is preferable —
`subscription-card.tsx` already renders it and the frontend type in
`lib/data.ts:906` already declares it.

### 3.4 Call sites that must switch to the resolver

| File:line | Today | Change |
|---|---|---|
| `modules/usage/entitlements.ts:61` | `configuredLimit(config, metric)` | `resolveMetricLimit(getTenantId(), metric)` |
| `modules/usage/entitlements.ts:110` | `PLAN_ENTITLEMENTS[normalizePlanCode(org.tier)]` | `resolveEntitlements(getTenantId()).seatLimit` |
| `modules/billing/billing.service.ts:592` | `PLAN_ENTITLEMENTS[normalizePlanCode(detail.organization.tier)]` | `resolveEntitlements(organizationId)` |
| `modules/usage/usage.service.ts:142` (`getCurrentUsage`) | `configuredLimit(config, metric)` | resolver, so the usage bars show real limits |

`getCurrentUsage` is easy to miss and is the one the tenant actually looks at:
if enforcement uses the override but the usage bar uses the plan default, a
tenant on a 10 000 MAC override sees "2 500 / 2 500 — exceeded" while everything
keeps working. Confusing in a way that generates support tickets.

`applyPlanLimits` (`billing.service.ts:73`) stays exactly as it is. It writes
plan numbers into config on plan change; overrides sit above it.

---

## 4. API endpoint

`apps/backend/src/modules/platform/platform.routes.ts` — add beside the other
`requirePlatformOwner` routes (near line 259).

```
PATCH /api/platform/subscribers/:id/commercials
```

Accepts `planOverride`, `macQuotaOverride`, `discountPercent`, `creditCents`,
`overrideReason`, `overrideExpiresAt`. All optional; **only supplied keys are
touched** — a `PATCH` that omits `creditCents` must not zero it.

Handler order, and why:

1. **Load the org first** and 404 if absent — matching the existing convention
   in this file ("existence is itself information", `campaigns.routes.ts:113`).
   This snapshot is also `beforeState`; taking it after the write is useless.
2. **Validate.** `planOverride` through `normalizePlanCode` (or explicit `null`
   to clear); `discountPercent` an integer 0–100; `macQuotaOverride` a
   non-negative integer or `null`; `creditCents` a non-negative integer;
   `overrideExpiresAt` a valid future date or `null`. Reject a past expiry with
   a clear message rather than accepting an override that is dead on arrival.
3. **Require a reason** if the resulting row would have any override set — note
   "resulting", not "supplied": clearing `planOverride` while `macQuotaOverride`
   stays set still leaves an overridden org, so a reason is still required. The
   SQL `CHECK` is the backstop; the route gives the readable error.
4. **Write inside a transaction** with the audit row, so an override can never
   exist without its audit record. This is the whole point of the feature.
5. **Stamp `overrideSetBy` / `overrideSetAt`** from `req.platformUser.id` and
   the server clock — never from the request body.
6. **Return** the updated org plus `resolveEntitlements()` output, so the console
   renders effective values without a second round trip.

Sketch:

```ts
router.patch('/subscribers/:id/commercials', requirePlatformOwner, async (req, res) => {
  try {
    const before = await prisma.organization.findUnique({
      where: { id: req.params.id },
      select: COMMERCIAL_FIELDS,
    });
    if (!before) return res.status(404).json({ error: 'Not found' });

    const patch = parseCommercialPatch(req.body, before); // throws CommercialError
    const after = await prisma.$transaction(async (tx) => {
      const updated = await tx.organization.update({
        where: { id: req.params.id },
        data: { ...patch, overrideSetBy: req.platformUser!.id, overrideSetAt: new Date() },
        select: COMMERCIAL_FIELDS,
      });
      await tx.platformAuditLog.create({
        data: {
          action: 'platform.commercials.updated',
          reason: patch.overrideReason ?? before.overrideReason ?? 'cleared',
          actorIdentityId: req.platformUser!.id,
          actorEmail: req.platformUser!.email,
          targetOrgId: updated.id,
          targetOrgName: updated.name,
          beforeState: before as object,
          afterState: updated as object,
          ipAddress: req.ip,
        },
      });
      return updated;
    });

    res.json({ organization: after, effective: await resolveEntitlements(after.id) });
  } catch (err) {
    if (isCommercialError(err)) return res.status(400).json({ error: err.message });
    logger.error('Commercials update failed', { error: String(err) });
    res.status(500).json({ error: 'Server error' });
  }
});
```

`parseCommercialPatch` belongs in the resolver's module, not inline — the
console needs the same value rules to disable its save button, and the tenancy
harness needs to call it directly.

**Do not** trigger `applyPlanLimits` from this endpoint. A `planOverride` must
not rewrite `OrganizationConfig`; that is the write-through path §1 rejects.

---

## 5. UI

### 5.1 Platform console (English, no i18n)

New component: `apps/frontend/components/platform/commercial-terms-dialog.tsx`
(the `components/platform/` directory does not exist yet — create it; the 350-line
`page.tsx` should not absorb this).

Wired from `apps/frontend/app/platform/subscribers/page.tsx`, following the
existing `destroyTarget` dialog pattern at line 334.

Fields: plan override select (None / FREE / GROWTH / **BUSINESS** / ENTERPRISE),
MAC quota number input with an explicit "use plan default" clear, discount
number input 0–100, credit input in **whole currency with cents conversion at
the edge** — an owner typing "50" meaning £50 into a field labelled cents is a
100× error waiting to happen; label it "Credit (£)" and multiply by 100 on
submit. Reason textarea, required, save disabled without it. Expiry date picker,
optional, with a note that it clears **all** overrides at once (§3.2).

Each row shows *plan default → effective* so the owner sees what they are
changing from. A live override renders the `عرض خاص` badge — the one Arabic
string in an English console, because it is the same badge the tenant sees and
it should be recognisable across both.

Add `updateSubscriberCommercials()` and the `CommercialTerms` type to
`apps/frontend/lib/data.ts` beside the existing platform calls.

### 5.2 Tenant billing summary (i18n: ar/he/en)

`apps/backend/src/modules/billing/billing.service.ts` → `getBillingSummary`
gains, from the resolver: `isOverridden`, `override.expiresAt`,
`discountPercent`, `effectivePriceCents`, `creditCents`, and `limits` that
reflect the override.

`apps/frontend/components/settings/subscription-card.tsx` renders:

- plan name with the `عرض خاص` badge when `isOverridden`
- effective MAC quota, not the plan default
- list price struck through beside the discounted price when a discount applies
- available credit when `creditCents > 0`

**Do not surface `overrideReason` to the tenant.** It is the owner's internal
note ("matched competitor quote", "compensation for October outage") and will
eventually say something that should never reach a customer.

Three new dictionary entries in `apps/frontend/lib/i18n.tsx`, ar → he/en:
`عرض خاص`, `رصيد متاح`, `الخصم`. Then re-run the audit script — it should return
to its two known non-UI exclusions.

---

## 6. Tenancy — gate 48 → 50

Two new checks in `apps/backend/scripts/tenancy-bleed-harness.js`, not one.

**`commercials: overrides are organization-scoped and expire`**
Set a plan override plus a MAC override on org A. Assert: org A's resolved
entitlements change; **org B's do not**; an override dated in the past resolves
as if absent (`isOverridden: false`, `expired: true`) while the columns remain;
and `OrganizationConfig` for org A is **byte-identical before and after** — that
last assertion is what pins §1's no-write-through rule so a future change cannot
quietly reintroduce it.

**`audit: PlatformAuditLog is never read under organization scope`**
A static audit, in the style of the existing `staticAudits()`. `PlatformAuditLog`
is in `PLATFORM_MODELS`, so under org scope the extension injects **nothing** —
a tenant-scoped `platformAuditLog.findMany()` would return **every subscriber's
commercial history**, including other tenants' negotiated discounts. Nothing
reads it today; this check makes sure nothing starts. Assert every
`platformAuditLog` reference outside `src/lib/audit.ts` sits in
`modules/platform/`.

That is the sharpest new hazard in P9 and it comes from an existing extension
entry, not from anything the migration adds.

---

## 7. Build order

1. Migration + `prisma generate` + apply. Verify `auditPlatformScope()` still
   writes (it is called on every platform-scope entry — run the gate).
2. `entitlements.resolver.ts` + `parseCommercialPatch`, with no call sites
   switched. Backend typechecks; nothing has changed behaviour yet.
3. Switch the four call sites in §3.4. **Verify quotas still enforce identically
   for an org with no overrides** — this is the regression risk of the whole
   phase, because it touches the path that blocks outbound sends.
4. `detectQuotaDrift` three-way classification (§3.3).
5. `PATCH …/commercials` + audit write.
6. Console dialog.
7. Tenant summary + i18n.
8. Two gate checks → 50/50.

Steps 1–3 are the ones that can break a working system; 4–8 are additive.

---

## 8. Verification

Standing gate at each step:

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/backend && npm run test:tenancy      # 48/48 → 50/50
cd apps/frontend && npm run build
docker compose build backend frontend && docker compose up -d
```

There are still no unit tests in this repo, so P9 needs deliberate live checks:

1. **No-override regression first.** An org with every override null must resolve
   to byte-identical limits and seat counts as before the change. Compare
   `GET /api/billing/summary` output before and after.
2. Set a MAC override; confirm `assertMetricAvailable` enforces the **new**
   number and the usage bar shows it (§3.4's easy-to-miss case).
3. Set an expiry in the past; confirm the override is ignored, the columns
   remain, and the console shows it as expired.
4. Confirm `OrganizationConfig` is untouched by every step above.
5. Confirm the audit row exists with before/after and a non-null actor, and that
   a rolled-back transaction leaves neither the override nor the audit row.
6. Cross-tenant: org B's summary is unchanged throughout.
7. Console: `عرض خاص` badge appears; tenant card shows discounted price and
   credit; `overrideReason` appears **nowhere** in the tenant response payload.

**Remove all test data afterwards.** The demo org is linked to a live WhatsApp
number — no verification step may send a real message.

---

## 9. Deliberately out of scope

- **Money does not move.** `discountPercent` and `creditCents` are display and
  billing-input only until P10-b wires a real provider. The console must not
  imply a refund was issued. `docs/BILLING-PROVIDER-GUIDE.md` covers activation,
  which is already automatic; only checkout is stubbed.
- **No proration.** Mid-period plan overrides do not generate credit notes.
- **No self-service.** Only `platformRole: 'OWNER'` can set commercial terms;
  there is no tenant-facing path, by design.
- **No per-metric quota overrides** beyond MAC — see §2.3 for the additive path.
