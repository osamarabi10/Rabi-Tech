# P10-a — Saved segments · implementation plan

A segment is a named, stored M3 filter, plus the plumbing to load it in the
contacts page and the campaign composer.

Status: **plan only, nothing implemented.** Every path below was re-verified
against the tree on 2026-08-21. Gate is currently **50/50**.

---

## 0. Grounding — what the brief got right, and the two paths it did not

Confirmed against the live tree:

| Claim | Verdict |
|---|---|
| `contact:manage` does not exist; `requirePermission` 500s on unknown keys | ✅ `rbac.middleware.ts:59-63` |
| `compileRule` is private | ✅ `contact-filter-dsl.ts:398` — no `export` |
| `campaignIdsInFilter` is exported and sees through nesting | ✅ `contact-filter-dsl.ts:499` |
| Contacts page applies filters live, no Apply button | ✅ `page.tsx:91` |
| Composer is a dialog component, not a route | ✅ `components/campaigns/campaign-composer.tsx` |
| `app/(dashboard)/contacts/page.tsx` | ✅ exists |
| `contacts.routes.ts` | ✅ exists |
| No `Segment` model yet | ✅ free |

Two paths in the brief are still wrong:

| Brief says | Actual |
|---|---|
| "Backend: `src/modules/contacts/` (for routes and DSL)" | Routes yes; **the DSL is at `src/lib/contact-filter-dsl.ts`**, not under `modules/contacts/` |
| "Filter builder: `components/contact-filter-builder.tsx`" | `components/**contacts/**contact-filter-builder.tsx` |

One thing the brief does not mention that changes a design choice:
**`assertCampaignsInOrg` is private to `campaigns.routes.ts:58`.** The segment
count endpoint needs the same rule, so it must be extracted rather than
re-implemented — see §5.

Project rule from the RabiTech guide, which this phase must satisfy:
*"Never add a tenant table without both [`organizationId` and a composite FK
`[id, organizationId]`]."*

---

## 1. Migration

`apps/backend/prisma/migrations/20260823090000_saved_segments/migration.sql`

### 1.1 Prisma schema

`apps/backend/prisma/schema.prisma` — new model. **No `@@unique([organizationId, name])`**;
see the comment and §1.2.

```prisma
/// A named, saved contact filter. `filter` stores the same DSL the M3 builder
/// produces and `contactWhereFromFilterDsl` compiles.
model Segment {
  id             String    @id @default(cuid())
  organizationId String
  name           String
  /// ContactFilterDsl. Unversioned, exactly like Campaign.audienceFilter — the
  /// DSL is additive by contract, so stored filters keep compiling.
  filter         Json
  /// Who saved it. Audit only: there is no sharing model, so every segment in
  /// an organization is visible to everyone in it.
  createdById    String
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  /// Soft delete. Deliberately NOT `isArchived` (the Contact/Conversation
  /// convention): archiving there is a product feature the user sees, this is
  /// deletion, and a timestamp answers "when" for free.
  deletedAt      DateTime?

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  createdBy    User         @relation(fields: [createdById, organizationId], references: [id, organizationId], onDelete: Restrict)

  @@unique([id, organizationId])
  @@index([organizationId, deletedAt])
  @@index([organizationId, name])
  // Name uniqueness is a PARTIAL, CASE-INSENSITIVE index created in SQL.
  // Prisma can express neither, so do NOT add @@unique([organizationId, name]) —
  // a full unique index would make a soft-deleted segment reserve its name
  // forever, and re-creating it would be impossible without a manual DB edit.
}
```

Back-references: `segments Segment[]` on both `Organization` and `User`.

`Segment` must **not** go in `PLATFORM_MODELS` (`src/prisma/extensions.ts`) — it
is tenant-scoped, so the default path (inject `organizationId` into every `where`
and `data`) is exactly right.

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

-- Composite unique so another table could reference a segment tenant-locally,
-- per the project rule that every cross-model join key carries organizationId.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_id_organizationId_key"
  ON "Segment" ("id", "organizationId");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_deletedAt_idx"
  ON "Segment" ("organizationId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Segment_organizationId_name_idx"
  ON "Segment" ("organizationId", "name");

-- Name uniqueness: PARTIAL and CASE-INSENSITIVE.
--
--   WHERE deletedAt IS NULL — a soft-deleted segment must not reserve its name
--     forever. Without this, deleting "VIP" makes "VIP" permanently unusable.
--   LOWER(name) — "VIP" and "vip" are the same segment to a person, and two
--     chips differing only in case is a support ticket.
--
-- Prisma supports neither partial nor functional indexes in the schema, which
-- is why this lives here and the model carries a pointer to it.
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_organizationId_name_unique_active"
  ON "Segment" ("organizationId", LOWER("name"))
  WHERE "deletedAt" IS NULL;

ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite FK: the join key carries organizationId on both sides, so a segment
-- can never point at a user in another tenant. RESTRICT is safe because users
-- are deactivated, never hard-deleted (system.routes.ts:410 sets isActive).
ALTER TABLE "Segment"
  ADD CONSTRAINT "Segment_createdById_organizationId_fkey"
  FOREIGN KEY ("createdById", "organizationId") REFERENCES "User"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

Apply per CLAUDE.md. The backend image bakes in `prisma/migrations`, so either
rebuild before `migrate deploy`, or apply the SQL directly and then
`migrate resolve --applied 20260823090000_saved_segments`.

---

## 2. Permissions

`apps/backend/src/middleware/rbac.middleware.ts`, beside the contact block:

```ts
// Segments — saved contact filters. Org-wide once saved, so renaming and
// deleting sit above the role that can create one: an agent must not be able to
// delete a view the whole team relies on.
'segment:view':   new Set(['ADMIN', 'SUPERVISOR', 'AGENT', 'VIEWER', 'FINANCE']),
'segment:create': new Set(['ADMIN', 'SUPERVISOR', 'AGENT']),
'segment:rename': new Set(['ADMIN', 'SUPERVISOR']),
'segment:delete': new Set(['ADMIN', 'SUPERVISOR']),
```

`segment:view` mirrors `contact:read`, `segment:create` mirrors
`contact:create`. `segment:delete` is deliberately **not** ADMIN-only (unlike
`contact:delete`) because deletion here is soft and reversible in the database,
not destructive.

---

## 3. Filter validator

Added to **`apps/backend/src/lib/contact-filter-dsl.ts`** — not a new file.
`compileRule` is private, and a validator that re-implements the M3 rules is a
validator that drifts from them.

```ts
export type FilterValidationResult = {
  valid: boolean;
  /** Human-readable, each prefixed with its path, e.g. "$and[0]: حقل غير مدعوم: foo". */
  errors: string[];
};

export function validateContactFilter(
  filter: unknown,
  organizationId: string,
): FilterValidationResult;
```

**How.** Walk the tree; call the existing `compileRule` on each leaf inside a
`try/catch`, pushing `` `${path}: ${message}` `` on failure instead of throwing.
Validation and compilation then agree by construction — a filter that validates
*has already compiled*.

The brief specifies `errors: string[]`, so the path is embedded in the string
rather than carried in a separate field. In a filter three groups deep, a bare
`"حقل غير مدعوم: foo"` is unusable — the user cannot tell which of four rules is
wrong.

Rules it must enforce, in order:

1. **Not an object / is an array / is null** → `الفلتر غير صالح`. Guard before
   walking so a `filter` of `"hello"` fails with a message, not a `TypeError`.
2. **Empty** — `{}`, `{"$and":[]}`, or a tree whose groups are all empty →
   `الفلتر فارغ — الشريحة ستشمل كل جهات الاتصال`. This compiles fine and matches
   **everyone**; saved under the name "VIP customers" and pointed at a broadcast,
   it is the single most dangerous thing this feature can store.
3. **Depth** — reuse `MAX_FILTER_DEPTH`, so a filter saved through the API can
   never exceed what the builder can render and edit back.
4. **Every leaf** — via `compileRule`.

**Collect all errors; do not stop at the first.** `contactWhereFromFilterDsl`
throws on the first problem, which is right for a request and wrong for a save
dialog: a user fixing four broken rules one round-trip at a time gives up.

Route usage:

```ts
const result = validateContactFilter(req.body?.filter, req.user!.organizationId);
if (!result.valid) {
  return res.status(400).json({ error: 'الفلتر غير صالح', details: result.errors });
}
```

---

## 4. Routes

New file **`apps/backend/src/modules/segments/segments.routes.ts`**, mounted in
`src/index.ts` beside the others (after line 367):

```ts
app.use('/api/segments',       segmentRoutes);
```

Soft delete is **not** automatic — the tenancy extension injects
`organizationId`, never `deletedAt: null` — so one shared constant is the only
thing standing between this feature and a deleted segment reappearing:

```ts
/** Live segments only. Every read and write MUST spread this. */
const ACTIVE = { deletedAt: null } as const;
```

| Route | Permission | Behaviour |
|---|---|---|
| `GET /api/segments` | `segment:view` | `where: ACTIVE`, `orderBy: { name: 'asc' }`. Returns `{ id, name, filter, createdById, createdAt, updatedAt }`. |
| `POST /api/segments` | `segment:create` | Validate name + filter, create with `createdById: req.user!.id`. 400 on duplicate. |
| `PATCH /api/segments/:id` | `segment:rename` | Read with `ACTIVE` first → 404 if missing **or already deleted**, then update the name only. |
| `DELETE /api/segments/:id` | `segment:delete` | Read with `ACTIVE` → 404, else set `deletedAt`, return **204** with no body. |
| `GET /api/segments/:id/count` | `segment:view` | §5. |

**Cross-tenant reads return 404, not 403**, matching the existing convention
(`campaigns.routes.ts:113`: *"existence is itself information"*). The extension
already makes another org's id match nothing; the job here is to turn Prisma's
`P2025` into a clean 404 rather than a 500.

**Name validation** — one helper used by POST and PATCH:

- trim; reject empty; cap at 80 characters (a chip has to fit on one line)
- **case-insensitive pre-check**:
  `findFirst({ where: { ...ACTIVE, name: { equals: name, mode: 'insensitive' } } })`
  → 400 `يوجد شريحة بهذا الاسم` — a friendly message, not a database error
- **on PATCH, exclude the row being renamed** (`id: { not: req.params.id }`), or
  renaming "VIP" to "VIP" reports a duplicate against itself
- **also catch `P2002`**. The pre-check races — two saves in the same instant
  both pass it. The partial index is the real guarantee; the pre-check exists
  only for the message.

**No audit logging.** `auditLog()` is used only for conversations and system
config today. A segment is user data, not a billing or security event, and
`createdById` + `updatedAt` already answer the questions anyone would ask.

---

## 5. Counting a segment

### 5.1 Extract the campaign-reference guard

`assertCampaignsInOrg` is private to `campaigns.routes.ts:58`. The count endpoint
needs the same rule, and two copies of "this campaign must belong to my org"
will drift.

New **`apps/backend/src/modules/campaigns/campaign-refs.ts`**:

```ts
/** Campaign ids referenced by a filter that do not exist in this organization. */
export async function missingCampaignIds(filter: ContactFilterDsl | null): Promise<string[]>;

/** Throws a 404-shaped error when any referenced campaign is missing. */
export async function assertCampaignsInOrg(filter: ContactFilterDsl | null): Promise<void>;
```

`campaigns.routes.ts` imports `assertCampaignsInOrg` from here instead of
defining it; behaviour is unchanged, so the campaign preview must be re-verified
(§8.10) to prove the extraction was lossless.

### 5.2 The endpoint

`GET /api/segments/:id/count` → `{ count: number }`, compiled from the stored
filter with `contactWhereFromFilterDsl(filter, organizationId)` plus
`isArchived: false` — **contacts-page semantics**.

A dangling campaign reference returns the specific shape the brief asks for:

```json
{ "error": "Campaign referenced in filter was deleted", "field": "campaignId" }
```

Not a silent zero. A zero makes the segment look *empty*; the truth is that it is
*broken*, and those call for opposite actions from the user.

### 5.3 Two numbers for one segment, by design

`audienceWhere()` (`campaigns.routes.ts:41`) additionally excludes
`marketingConsent: 'OPTED_OUT'`, unconditionally and with no override. So a chip
reading 1,240 becomes 1,198 in the composer.

- The composer keeps using `POST /api/campaigns/audience/preview`, **never** the
  segment count endpoint — otherwise consent exclusion could be bypassed simply
  by routing a broadcast through a segment.
- The composer already returns and renders `excludedOptedOut` (M1.4). Selecting a
  segment must keep that line visible; it is the sentence that explains the gap.
- Do **not** reconcile them by hiding opted-out contacts from the chip count.
  The contacts page is a CRM view, and an agent needs to see who opted out.

---

## 6. Frontend — contacts page

`apps/frontend/app/(dashboard)/contacts/page.tsx`, inside the existing filter
`Card` (around line 213), in a row **below** `<ContactFilterBuilder>`:

```tsx
<div className="flex flex-wrap items-center justify-between gap-2">
  <SegmentChips segments={segments} activeId={activeSegmentId} onSelect={applySegment} … />
  <Button size="sm" variant="outline" disabled={!appliedFilter} onClick={() => setSaveOpen(true)}>
    <BookmarkPlus className="h-3.5 w-3.5" />
    {t('حفظ كشريحة')}
  </Button>
</div>
```

`disabled={!appliedFilter}` matters: `activeFilter()` returns `null` when nothing
is filled in, so this stops the "matches everyone" save at the button rather than
after a round trip — the same rule §3 enforces server-side.

**New — `apps/frontend/components/contacts/save-segment-dialog.tsx`**
Name input, required, `Enter` submits. A duplicate-name error renders **inline
under the field**, not only as a toast: a toast disappears while the user is
still looking at the field they have to change.

**New — `apps/frontend/components/contacts/segment-chips.tsx`**

- alphabetical, matching the API's default order
- clicking a chip calls `setFilter(segment.filter)`, which flows through the
  existing `appliedFilter` memo — the list refreshes with no extra plumbing
- the active chip is marked, and clicking it again clears the filter; without
  that there is no way back to "all contacts" except deleting rules by hand
- **counts fetched lazily per chip**, not eagerly for all. Eager means N
  `COUNT(*)` queries against `Contact` on every page load, and M3 filters
  traverse relations (`hasEverReplied`, broadcast history). Fetch on first
  render of a visible chip and cache in state; if it is still slow, ship chips
  without counts — a chip is useful without one.
- a small per-chip menu for rename / delete, hitting PATCH / DELETE

**`apps/frontend/lib/data.ts`** gains `Segment` plus `fetchSegments`,
`createSegment`, `renameSegment`, `deleteSegment`, `fetchSegmentCount` — the
single source for API types, per the project convention.

---

## 7. Frontend — campaign composer

`apps/frontend/components/campaigns/campaign-composer.tsx`, `step === 'target'`
(line 214). Picker **above** the builder:

```
[ شريحة محفوظة: ▾ بدون ]     ← selecting one loads its filter into the builder
──────────────────────────
<ContactFilterBuilder …>      ← stays visible and editable
```

Not a tab. A tab implies the two are alternatives; they are not. The value is
picking "lapsed customers" and then adding "and in Haifa" for this one campaign,
so a segment is a *starting point*. Loading into the shared builder gets that
for free and reuses the existing debounced `refreshAudience`.

Once the user edits a loaded filter, flip the label to `شريحة مخصصة` ("custom")
by comparing `JSON.stringify` of the current filter against the loaded one —
cheap, and these objects are small. Without it, someone believes they are
sending to the saved segment when they are not.

The audience line keeps rendering `excludedOptedOut` (§5.3).

---

## 8. Tenancy — gate 50 → 51

One case in `apps/backend/scripts/tenancy-bleed-harness.js`, beside the existing
`crm:` checks. Use the HTTP layer for the 404s (as `crm: contact refs…` does) so
the route guards are exercised, and the scoped client for row-level assertions.

**`segments: saved segments are organization-scoped`**

1. org A creates a segment → org A's `GET /api/segments` lists it
2. org B's list does **not** contain it
3. org B `GET /api/segments/:id/count` → 404
4. org B `PATCH /api/segments/:id` → 404
5. org B `DELETE /api/segments/:id` → 404
   — all three verbs, because a read guard that a write path skips is the
   classic hole
6. a filter org A stored against org A's tag resolves in org A and matches
   **nothing** in org B even when the tag name is identical — proving the
   compiled `where` is tenant-local, not just the row lookup
7. soft delete removes it from the list, leaves the row, and **frees the name** —
   the partial index's whole purpose, and what a plain `@@unique` silently breaks

---

## 9. Build order

1. Migration + `prisma generate` + apply. Gate stays 50/50.
2. `validateContactFilter` in the DSL + `segment:*` permissions. Nothing consumes
   them yet; backend typechecks.
3. Extract `campaign-refs.ts`; re-verify the campaign audience preview is
   unchanged **before** building on it.
4. Routes + count endpoint. curl round-trip.
5. Harness case → 51/51.
6. `lib/data.ts` helpers → contacts page (save dialog + chips).
7. Composer picker.
8. i18n ar→he/en: `حفظ كشريحة`, `تم حفظ الشريحة`, `يوجد شريحة بهذا الاسم`,
   `الشرائح`, `شريحة محفوظة`, `شريحة مخصصة`, `بدون`, `إعادة تسمية`, `حذف`,
   `الفلتر فارغ — الشريحة ستشمل كل جهات الاتصال`. Then re-run the audit script and
   confirm it returns to its two known non-UI exclusions.

Steps 1–4 are self-contained and reversible; 6–7 are additive UI. Step 3 is the
only one that touches working code, which is why it is verified in isolation.

---

## 10. Verification

Standing gate at each step:

```bash
cd apps/backend && npx tsc --noEmit -p .
cd apps/backend && npm run test:tenancy      # 50/50 → 51/51
cd apps/frontend && npm run build
docker compose build backend frontend && docker compose up -d
```

There are no unit tests in this repo, so each of these is a deliberate live check:

1. **Migration applied** — `prisma migrate status` clean, and `\d "Segment"`
   shows the partial predicate `WHERE (("deletedAt" IS NULL))`.
2. **Gate 51/51.**
3. **Round trip** — POST → GET (appears) → PATCH rename → GET (renamed) →
   DELETE (**204**) → GET (absent) → PATCH again (**404**) → row still present in
   SQL with `deletedAt` set.
4. **Cross-org** — org B gets 404 on GET/PATCH/DELETE of org A's segment id.
5. **Duplicate name** — create "VIP", create "VIP" again → 400.
6. **Case-insensitive** — create "VIP", create "vip" → 400.
7. **Name freed by delete** — create "VIP", delete, create "VIP" again →
   **succeeds**. This is the one a plain unique index breaks.
8. **Invalid filter** — unknown field, wrong operator for the type, and depth 4;
   each 400 with `details`, and a filter with **two** bad rules returns **two**
   errors, not one.
9. **Empty filter** — `{"$and":[]}` → 400.
10. **Deleted campaign reference** — save a segment using `receivedCampaign`,
    delete the campaign, then count → `{ error, field: "campaignId" }`, not 500
    and not `0`. Also re-check the campaign audience preview still works after
    the §5.1 extraction.
11. **Contacts page** — "حفظ كشريحة" appears, saves, the chip appears, clicking
    applies the filter, clicking again clears it.
12. **Composer** — the segment appears in the picker; its count equals the
    contacts-page count **minus** `excludedOptedOut`; editing after loading flips
    the label to "custom".
13. **RTL and LTR** both checked, as with M3.
14. **All test data removed** — segments, and any campaign or contact touched;
    residue check clean. The demo org is on a live WhatsApp number, so no step
    may send a real message.

---

## 11. Out of scope

Sharing between users, folders/categories, auto-updating segments, export.

Worth recording now: **there is no sharing model, so every segment is visible to
everyone in the organization.** `createdById` is audit only. That is precisely
why §2 puts rename and delete above create — an org-wide list with per-user
creation and per-user deletion is how a team loses a view it depends on.
