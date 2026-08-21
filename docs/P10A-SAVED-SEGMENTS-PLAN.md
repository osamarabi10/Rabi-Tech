# P10-a — Saved segments · implementation plan

Builds directly on M3 (filter vocabulary), which is live. A segment is a named,
stored M3 filter plus the plumbing to load it in the contacts page and the
campaign composer.

Status: **plan only, nothing implemented.** Every path below was verified against
the tree on 2026-08-21. Gate is currently **50/50**.

---

## 0. Corrections to the brief

Six things do not match the code. Two of them would fail at runtime.

| # | Brief says | Reality | Consequence |
|---|---|---|---|
| 1 | `requirePermission('contact:manage')` | **`contact:manage` does not exist.** The matrix has `contact:create/update/delete/read` (`rbac.middleware.ts:23-26`), and `requirePermission` returns **500 "Invalid operation"** for an unknown key (`rbac.middleware.ts:59-63`) | Every segment write would 500. See §3.1 |
| 2 | Unique `[organizationId, name]` **and** soft delete | A plain unique index means a soft-deleted segment **permanently reserves its name** — deleting then re-creating "VIP customers" fails forever. The index must be **partial** (`WHERE "deletedAt" IS NULL`), and Prisma cannot express partial or functional indexes in the schema | Raw SQL index; do **not** declare `@@unique([organizationId, name])`. See §1.2 |
| 3 | `apps/backend/src/modules/contacts/routes.ts` | `contacts.routes.ts` | path |
| 4 | `apps/frontend/app/contacts/page.tsx` | `app/(dashboard)/contacts/page.tsx` | path |
| 5 | `apps/frontend/components/contacts/filter-builder.tsx` | `contact-filter-builder.tsx` | path |
| 6 | `apps/frontend/app/campaigns/composer/page.tsx` | `components/campaigns/campaign-composer.tsx` — the composer is a dialog inside the campaigns page, not a route | path |

Also worth stating before building:

- **"Next to Apply Filters" — there is no Apply button.** The contacts page
  applies filters live (`page.tsx:91`, `activeFilter(filter)` in a `useMemo`).
  The save button needs a home of its own; §5.1 places it.
- **`compileRule` is not exported** from `contact-filter-dsl.ts`. The validator
  therefore belongs *inside* that module — which is the right place anyway, and
  is what makes "matches M3 exactly" true rather than aspirational (§2).
- **Users are never hard-deleted** (`system.routes.ts:410` sets
  `isActive: false`). A composite FK on `createdById` with `onDelete: Restrict`
  is therefore safe and matches `Contact.assignee`.

---

## 1. Migration

`apps/backend/prisma/migrations/20260823090000_saved_segments/migration.sql`

### 1.1 Schema

`apps/backend/prisma/schema.prisma`:

```prisma
/// A named, saved contact filter. The `filter` column stores the same DSL shape
/// the M3 builder produces and `contactWhereFromFilterDsl` compiles.
model Segment {
  id             String    @id @default(cuid())
  organizationId String
  name           String
  /// ContactFilterDsl. Unversioned, exactly like Campaign.audienceFilter — the
  /// DSL is additive by contract, so stored filters keep compiling.
  filter         Json
  /// Who saved it. Audit only: there is no sharing model, every segment in an
  /// organization is visible to everyone in it.
  createdById    String
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  /// Soft delete. Deliberately NOT `isArchived` (the Contact/Conversation
  /// convention): archiving there is a product feature the user sees, whereas
  /// this is deletion, and the timestamp answers "when" for free.
  deletedAt      DateTime?

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  createdBy    User         @relation(fields: [createdById, organizationId], references: [id, organizationId], onDelete: Restrict)

  // Lets future models reference a segment tenant-locally, per the codebase rule
  // that every cross-model join key carries organizationId.
  @@unique([id, organizationId])
  @@index([organizationId, name])
  @@index([organizationId, deletedAt])
  // NOTE: uniqueness on the name is a PARTIAL, CASE-INSENSITIVE index created in
  // SQL — Prisma cannot express either. Do not add @@unique([organizationId, name]).
}
```

Add to `model Organization`: `segments Segment[]`
Add to `model User`: `segments Segment[]`

`Segment` must **not** be added to `PLATFORM_MODELS` in
`src/prisma/extensions.ts` — it is tenant-scoped, so the default path (inject
`organizationId` into every `where` and `data`) is exactly what is wanted.

### 1.2 SQL

```sql
-- P10-a: saved segments — a named, stored M3 contact filter.

CREATE TABLE IF NOT EXISTS "Segment" (
  "id"             TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name"           TEXT NOT NULL,
  "filter"         JSONB NOT NULL,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "deletedAt"      TIMESTAMP(3),
  CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- Composite unique so other tables can reference a segment tenant-locally.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_id_organizationId_key"
  ON "Segment" ("id", "organizationId");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_name_idx"
  ON "Segment" ("organizationId", "name");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_deletedAt_idx"
  ON "Segment" ("organizationId", "deletedAt");

-- Name uniqueness: PARTIAL and CASE-INSENSITIVE.
--
--   partial  — a soft-deleted segment must not reserve its name forever;
--              without the WHERE clause, deleting "VIP" then re-creating it
--              fails permanently and the only fix is a manual DB edit.
--   lower()  — "VIP" and "vip" are the same segment to a person, and two chips
--              differing only in case is a support ticket.
--
-- Prisma supports neither in the schema, so this lives here and the model
-- carries a comment pointing at it.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_org_name_active_key"
  ON "Segment" ("organizationId", lower("name"))
  WHERE "deletedAt" IS NULL;

ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK: the join key carries organizationId on both sides, so a segment
-- can never point at a user in another tenant. Restrict is safe because users
-- are deactivated, never hard-deleted (system.routes.ts:410).
ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_createdById_organizationId_fkey"
  FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

Apply per CLAUDE.md. The backend image bakes in `prisma/migrations`, so rebuild
before `migrate deploy`, or apply the SQL directly and then
`migrate resolve --applied 20260823090000_saved_segments`.

---

## 2. Filter validation

New export in **`apps/backend/src/lib/contact-filter-dsl.ts`** (not a new file —
`compileRule` is private, and a validator that re-implements the rules is a
validator that drifts from them).

```ts
export type FilterValidationError = {
  /** Where in the tree, e.g. "$and[0].$or[2]" — a bare message is unusable in a nested filter. */
  path: string;
  message: string;
};

export type FilterValidationResult = {
  valid: boolean;
  errors: FilterValidationError[];
};

export function validateContactFilter(
  filter: unknown,
  organizationId: string,
): FilterValidationResult;
```

**How it works, and why this shape.** It walks the tree and calls the existing
`compileRule` on each leaf inside a `try/catch`, collecting failures instead of
throwing on the first. That guarantees validation and compilation agree by
construction: a filter that validates *will* compile, because validating it
compiled it.

Points that matter:

- **Collect all errors, do not stop at the first.** `contactWhereFromFilterDsl`
  throws on the first problem, which is right for a request but wrong for a save
  dialog — a user fixing four broken rules one round-trip at a time gives up.
- **Enforce `MAX_FILTER_DEPTH` during the walk**, reusing the same constant, so
  a filter saved via the API cannot exceed what the builder can render and edit.
- **Reject an empty filter.** `{}` or `{"$and":[]}` compiles fine and matches
  *everyone*. As a saved segment named "VIP customers" that is a loaded gun
  pointed at a broadcast. Return an explicit error.
- **Reject non-objects and arrays** before walking, so a `filter` of `"hello"`
  or `null` fails with a message rather than a `TypeError`.
- **Campaign ids get an existence check separately.** `campaignIdsInFilter()`
  already exists (`contact-filter-dsl.ts:499`) and already sees through nesting.
  A segment referencing `receivedCampaign` must have that id validated against
  the caller's org on **save** — and note the consequence in §4.

The route wraps it:

```ts
const result = validateContactFilter(req.body?.filter, req.user!.organizationId);
if (!result.valid) {
  return res.status(400).json({ error: 'الفلتر غير صالح', details: result.errors });
}
```

`{ error, details }` matches the shape the brief specifies and the codebase's
existing `{ error }` responses.

---

## 3. API routes

New file **`apps/backend/src/modules/segments/segments.routes.ts`**, mounted at
`/api/segments` in `src/index.ts` beside the other module routers.

### 3.1 Permissions — add `segment:*`, do not reuse `contact:manage`

`contact:manage` does not exist and would 500. Two options:

| Option | Verdict |
|---|---|
| Map onto `contact:create` / `contact:update` / `contact:delete` | Rejected: `contact:delete` is ADMIN-only, so a SUPERVISOR could create a segment but not delete their own. And an AGENT (who has `contact:create`) could create one but not rename it. |
| **Add `segment:*` to `ROLE_PERMISSIONS`** | Recommended. CLAUDE.md says to use `requirePermission('operation:action')` and never inline role checks; a new resource gets new entries. |

```ts
// rbac.middleware.ts, beside the contact block
'segment:read':   new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),
'segment:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
'segment:update': new Set(['ADMIN', 'SUPERVISOR']),
'segment:delete': new Set(['ADMIN', 'SUPERVISOR']),
```

Rationale: reading mirrors `contact:read`; creating mirrors `contact:create` so
an agent can save their own working view; renaming and deleting are SUPERVISOR+
because a segment is shared across the whole organization — one agent must not
be able to delete a view the whole team is using. `segment:delete` is
deliberately *not* ADMIN-only (unlike `contact:delete`) because deletion here is
soft and reversible in the database, not destructive.

### 3.2 Routes

All four share one scoping helper. Soft delete is not automatic — the tenancy
extension injects `organizationId`, not `deletedAt: null` — so a single helper
is the only thing standing between this feature and a resurrected segment
appearing in a list.

```ts
/** Live segments only. Every read MUST go through this. */
const ACTIVE = { deletedAt: null } as const;
```

| Route | Permission | Notes |
|---|---|---|
| `GET /api/segments` | `segment:read` | `where: ACTIVE`, `orderBy: [{ name: 'asc' }]`. Accept `?sort=createdAt` for the documented alternative. Returns `{ id, name, filter, createdById, createdAt, updatedAt }`. |
| `POST /api/segments` | `segment:create` | Validate name and filter, then create with `createdById: req.user!.id`. |
| `PATCH /api/segments/:id` | `segment:update` | Rename only. **Read first, 404 if missing or soft-deleted**, then update. |
| `DELETE /api/segments/:id` | `segment:delete` | `update({ data: { deletedAt: new Date() } })`, return **204**. 404 if already deleted — deleting twice is a caller bug worth surfacing. |
| `GET /api/segments/:id/count` | `segment:read` | See §4. |

**Cross-tenant reads return 404, not 403** — matching
`campaigns.routes.ts:113`'s comment that existence is itself information. The
tenancy extension already makes another org's id match nothing, so this falls
out naturally; the point is to return 404 rather than letting a `P2025` become a
500.

**Name validation** (shared helper, used by POST and PATCH):

- trim; reject empty; cap at 80 characters (a chip has to fit)
- reject a name that is only punctuation or digits? No — over-reach. Only empty.
- **case-insensitive duplicate pre-check** with
  `findFirst({ where: { ...ACTIVE, name: { equals: name, mode: 'insensitive' } } })`
  so the user gets *"يوجد شريحة بهذا الاسم"* rather than a database error
- **also catch `P2002`** from the partial index. The pre-check races: two saves
  in the same instant both pass it. The index is the real guarantee; the
  pre-check exists only for the message.
- on PATCH, exclude the row being renamed (`id: { not: req.params.id }`), or
  renaming "VIP" to "VIP" reports a duplicate against itself

**Audit logging: not needed.** `auditLog()` is org-scoped and currently used
only for conversations and system config. A segment is user data, not a billing
or security event, and `createdById` + `updatedAt` already answer the questions
anyone would ask. Revisit if segments ever become shareable or drive automation.

---

## 4. Counting a segment — the two-numbers problem

`GET /api/segments/:id/count` returns `{ count }` compiled from the stored
filter with `contactWhereFromFilterDsl(filter, organizationId)` plus
`isArchived: false` — the **contacts-page** semantics.

**This will not equal the campaign audience count for the same segment, and that
is correct.** `audienceWhere()` (`campaigns.routes.ts:29`) additionally excludes
`marketingConsent: 'OPTED_OUT'`, unconditionally and with no override. So a
segment chip reading 1,240 can become 1,198 in the composer.

Two numbers for one segment looks like a bug unless it is labelled. Therefore:

- The composer must keep using `POST /api/campaigns/audience/preview`, **not**
  the segment count endpoint, so consent exclusion cannot be bypassed by routing
  a broadcast through a segment.
- The composer already returns `excludedOptedOut` and already renders it (M1.4).
  Selecting a segment must keep that line visible — it is the sentence that
  explains the difference.
- Do **not** try to reconcile them by excluding opted-out contacts from the chip
  count. The contacts page is a CRM view; hiding opted-out people from it would
  be wrong, and an agent would lose the ability to see who opted out.

Second interaction: **a stored filter can reference a deleted campaign.** A
segment saved with `receivedCampaign = X` keeps compiling after X is deleted, and
`assertCampaignsInOrg` will now 404 it. The count endpoint must catch that and
return a specific message (*"الحملة المشار إليها لم تعد موجودة"*) rather than a
bare 500 or a silent zero — a silent zero is the worst outcome, because the
segment looks empty rather than broken.

---

## 5. Frontend — contacts page

### 5.1 Save as segment

`apps/frontend/app/(dashboard)/contacts/page.tsx`, inside the existing filter
`Card` (line ~200), in a row **below** `<ContactFilterBuilder>`:

```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  <SegmentChips segments={segments} activeId={activeSegmentId} onSelect={applySegment} />
  <Button size="sm" variant="outline" disabled={!appliedFilter} onClick={() => setSaveOpen(true)}>
    <BookmarkPlus className="h-3.5 w-3.5" />
    {t('حفظ كشريحة')}
  </Button>
</div>
```

`disabled={!appliedFilter}` matters: `activeFilter()` returns `null` when nothing
is filled in, and saving "everyone" under a name is the failure mode §2 rejects
server-side. Disabling the button says so before the round trip.

New component **`apps/frontend/components/contacts/save-segment-dialog.tsx`** —
name input, required, `Enter` submits, duplicate-name error rendered inline
under the field rather than only as a toast (a toast disappears while the user is
still looking at the field they need to change).

### 5.2 Segment chips

New component **`apps/frontend/components/contacts/segment-chips.tsx`**.

- alphabetical by name, matching the API's default order
- clicking a chip calls `setFilter(segment.filter)` — which flows through the
  existing `appliedFilter` memo, so the list refreshes with no extra plumbing
- the active chip is visually marked, and clicking it again clears the filter;
  without that there is no way back to "all contacts" except deleting rules
- **counts are fetched lazily and per chip**, not eagerly for all of them. Eager
  counting means N `COUNT(*)` queries against Contact on every page load, and
  these filters traverse relations (M3 added `hasEverReplied`, broadcast
  history). Fetch on hover/first render of the visible chips, cache in state.
  If that proves slow, show chips without counts — a chip is useful without one.
- a rename/delete affordance per chip (small menu) calling PATCH/DELETE

New in `apps/frontend/lib/data.ts`: `Segment` type plus `fetchSegments`,
`createSegment`, `renameSegment`, `deleteSegment`, `fetchSegmentCount`.

---

## 6. Frontend — campaign composer

`apps/frontend/components/campaigns/campaign-composer.tsx`, `step === 'target'`
(line 214).

Add a segment selector **above** the builder, not as a separate tab:

```
[ Saved segment: ▾ none ]      ← selecting one loads its filter into the builder
────────────────────────────
<ContactFilterBuilder …>       ← stays visible and editable
```

A tab would imply the two are alternatives; they are not. A segment is a
*starting point* — the whole value is picking "lapsed customers" and then adding
"and in Haifa" for this one campaign. Loading into the shared builder gets that
for free, and reuses the existing debounced `refreshAudience`.

Once the user edits the loaded filter, clear the selection label to
`المخصص` / "custom" so nobody believes they are sending to the saved segment when
they are not. Track this by comparing `JSON.stringify` of the current filter
against the loaded one — cheap, and these objects are small.

The composer's audience line keeps showing `excludedOptedOut` (§4).

---

## 7. Tenancy — gate 50 → 51

One new case in `apps/backend/scripts/tenancy-bleed-harness.js`, placed beside
the existing `crm:` checks.

**`segments: saved segments are organization-scoped`**

- create a segment in org A via the scoped client under `runAsOrganization`
- org B's `GET /api/segments` does not list it
- org B reading, renaming or deleting it by id returns **404** (all three verbs —
  a read guard that a write path skips is the classic hole)
- a filter stored by org A that references org A's tag resolves in org A and
  matches **nothing** in org B, even though the tag name may be identical —
  proves the compiled `where` is tenant-local, not just the row lookup
- soft delete removes it from the list but leaves the row, and its **name becomes
  reusable** — the partial index's whole purpose, and the thing a plain
  `@@unique` would silently break

Use the HTTP layer for the 404s (as `crm: contact refs…` does) so the route
guards are exercised, and the scoped Prisma client for the row-level assertions.

---

## 8. Build order

1. Migration + `prisma generate` + apply. Gate stays 50/50.
2. `validateContactFilter` in `contact-filter-dsl.ts`, plus `segment:*`
   permissions. Nothing consumes them yet.
3. Routes + count endpoint. Verify by curl round-trip (§9.3).
4. Harness case → 51/51.
5. `lib/data.ts` helpers, then the contacts page (save dialog + chips).
6. Campaign composer selector.
7. i18n: `حفظ كشريحة`, `تم حفظ الشريحة`, `يوجد شريحة بهذا الاسم`, `الشرائح`,
   `شريحة مخصصة`, plus rename/delete strings — ar source → he/en, then re-run the
   audit script and confirm it returns to its two known non-UI exclusions.

Steps 1–3 are reversible and self-contained; 5–6 are additive UI.

---

## 9. Verification

Standing gate at each step:

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/backend && npm run test:tenancy      # 50/50 → 51/51
cd apps/frontend && npm run build
docker compose build backend frontend && docker compose up -d
```

There are still no unit tests, so this needs deliberate live checks:

1. **Migration applied**, `prisma migrate status` clean, and the partial index
   exists (`\d "Segment"` shows the `WHERE (deletedAt IS NULL)` predicate).
2. **Round trip**: POST → GET (appears) → PATCH rename → GET (renamed) →
   DELETE (204) → GET (gone) → row still present in SQL with `deletedAt` set.
3. **Name reuse after delete** — create "VIP", delete it, create "VIP" again.
   This is the one a plain unique index breaks, and it must pass.
4. **Case-insensitive duplicate**: create "VIP", then "vip" → 400 with the
   friendly message, not a 500.
5. **Empty filter rejected**: `{"$and":[]}` → 400. A segment matching everyone
   is the dangerous case.
6. **Invalid filter**: unknown field, wrong operator for the type, and depth 4 —
   each 400 with `details` naming the offending path, and **more than one error
   returned at once** for a filter with two bad rules.
7. **Cross-tenant**: org B GET/PATCH/DELETE on org A's segment id → 404 for all
   three.
8. **Counts**: segment count on the contacts page vs the composer's audience for
   the same segment — confirm they differ by exactly the opted-out count, and
   that `excludedOptedOut` explains it on screen.
9. **Dangling campaign reference**: save a segment using `receivedCampaign`,
   delete the campaign, then count → specific 400, not 500 and not a silent 0.
10. **Browser**: save from the contacts page, chip appears, clicking applies it,
    clicking again clears it; composer selector loads it and the count matches;
    editing after loading flips the label to "custom".
11. **RTL and LTR** both checked, as with M3.

**Remove all test data afterwards** — segments, and any campaign or contact
touched. The demo org is linked to a live WhatsApp number, so no verification
step may send a real message.

---

## 10. Out of scope (confirmed with the brief)

Sharing between users, folders/categories, auto-updating segments, export.

One consequence worth writing down now: **there is no sharing model, so every
segment is visible to everyone in the organization.** `createdById` is audit
only. That is why §3.1 puts rename and delete at SUPERVISOR+ — an agent deleting
a view the team relies on is the predictable failure of an org-wide list with
per-user creation.
