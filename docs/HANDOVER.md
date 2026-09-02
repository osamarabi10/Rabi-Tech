# Handover — read this before touching anything

Written 2026-09-02 for a session that has none of the preceding conversation.
The working tree is **not clean** and some of what is in it is not yours to
commit. Read §1 before running any git command.

Longer background: [SESSION-STATE-AND-AUDIT.md](SESSION-STATE-AND-AUDIT.md) —
what was built, every defect found, the recurring failure pattern, and the
ranked risks.

---

## 1 · The tree right now — the part that will bite you

**GitHub `main` is at `3f041e92`. Local `HEAD` is one commit ahead.**

| State | What | Action |
|---|---|---|
| **1 local commit, unpushed** | `b5b97a10` — five settings-audit fixes | The owner said *do not push*. Ask before pushing. |
| **15 uncommitted files** | Two unrelated bodies of work, mixed | **Never `git add` a directory.** |

### The 15 uncommitted files are two separate things

**A — the owner's trial-gateway work. Do not touch, do not commit.**

```
apps/backend/prisma/migrations/20260930090000_standard_trial_gateway/
apps/backend/src/modules/billing/billing.service.ts
apps/backend/src/modules/billing/plans.ts
apps/backend/src/modules/billing/trial.service.ts
apps/backend/src/modules/channels/channel-entitlement.ts
apps/backend/src/modules/platform/platform.routes.ts
apps/backend/src/workers/gateway-provisioning.worker.ts
apps/frontend/app/platform/editions/page.tsx
apps/backend/scripts/tenancy-bleed-harness.js   ← their D-26 assertion
```

**It must land as one commit.** The migration sets `STANDARD.autoProvisionGateway = true`
while the *committed* harness asserts `false`. Committing the migration alone
puts main into a state where `npm run test:tenancy` goes red for everyone.
**This already happened once** — `9a458795` is the revert. It was caused by
`git add apps/backend/prisma` sweeping the directory.

**B — unfinished Meta template sending, mine, uncommitted.**

```
apps/backend/src/modules/channels/meta.client.ts          (sendTemplateMessage)
apps/backend/src/modules/meta-templates/meta-template-send.service.ts
apps/backend/src/modules/meta-templates/meta-templates.routes.ts
apps/backend/scripts/verify-meta-template-send.js         (34/34, passing)
apps/backend/package.json                                 (test:meta-templates)
CLAUDE.md                                                 (gate docs)
```

Complete and green, not committed because the owner said don't push and the
batch after it had to stay separable. **`package.json` and `CLAUDE.md` carry
these changes**, which is why the newest gate could not be registered — see §4.

---

## 2 · Why this work mattered

`GROWTH`, `BUSINESS` and `ENTERPRISE` are `allowedChannels: ['WHATSAPP_CLOUD']`
only. Meta permits free-form messages **only inside the 24-hour window that
opens when the customer writes**. There was no template send path, so those
three paying tiers could reply and **could never start a conversation**.

`MetaMessageTemplate` carried the note *"Only the exact string APPROVED is
sendable in a later phase."* Item B above is that phase.

**Still missing for it to be complete: two caps, not one.** Both happen to be
250, which is why they have been read here as a single thing. They are not, and
enforcing either one does nothing about the other.

**The messaging tier limit.** 250 unique customers per rolling 24 hours,
**business-initiated only** — customer-initiated conversations are uncapped, so
a busy inbox never approaches it. This is the one
`maxUniqueRecipientsPer24h` implements. D-24 records it as unenforced *only
because* no business-initiated conversation could start; landing template
sending removes the reasoning that rested on.

**The unverified-business ceiling.** 250 unique contacts **per broadcast**. A
different limit with a different denominator, lifted by business verification
rather than by messaging tier. Nothing models it, nothing surfaces it, and
**D-24 does not mention it** — so a reader who satisfies D-24 will reasonably
believe the cap work is done. A broadcast to 5,000 contacts from an unverified
number stops after the 250th with no explanation anywhere in the product.

The owner asked for template sending and the cap work in **one commit**; that
has not happened.

---

## 3 · The rules that are not optional here

These are not style preferences. Each came from a defect that shipped.

**Stage files by name. Never a directory.** See §1.

**A gate is green only when it was watched to run.** Read the printed
`N/N checks passed` line. A command list exits with the status of its *last*
command, so anything appended replaces the gate's answer. Four defects in this
repo were gates reporting on their environment — D-5, D-10, D-12, D-16, and a
fifth in §5 of the audit doc.

**Assert reachability, not just correctness.** Nine instances of
*declared-but-unreachable* have been found here. A trigger with no dispatch
site, a scope no endpoint requires, an action with no executor branch, a
setting nothing reads — all compile, all pass tests, all appear in the UI, and
none work. The gates now check:

- every workflow trigger has a `dispatchWorkflowEvent` call site
- every action has an executor branch **or is provably refused at save**
- every refused action is absent from the *served* vocabulary
- every API scope is required by some endpoint
- every analytics report is reachable from the UI, or listed as deliberately not
  (added 2026-09-02 — this bullet described a gate that did not exist; see §9)
- the executor calls the gateway exactly once, from inside the consent check

**Source assertions cannot see behaviour.** `verify-collaborators.js` first
asserted `if (shouldAdd)` appeared in the source; mutating the compiled output
to `if (true)` left it green. If a gate claims a setting *changes* something,
it has to run the thing.

**Editing by substring is not structural editing.** Replacing a 10-space
indented pattern that is a substring of an 18-space one produces duplicate
properties. This happened twice in one session, the second time *after* being
recorded as a lesson. **Patch by line number** when indentation varies.

**Every migration needs a guarded `down.sql`** that refuses when live data
depends on it, and a verified `pg_dump -Fc` beforehand confirmed with
`pg_restore -l`.

**The 25 places we are ahead must not regress toward parity.** Consent
especially — Respond.io has no documented opt-out mechanism at all.

---

## 4 · Known loose ends

**`verify-collaborators.js` is not registered.** Run it with
`node scripts/verify-collaborators.js`. Add
`"test:collaborators": "npm run build && node scripts/verify-collaborators.js"`
to `package.json` **once item B lands**, since that file already carries
uncommitted changes.

**`utcOffsetMinutes` is still accepted and ignored** on the analytics query
string, so a deployed frontend does not 400 mid-rollout. Drop it from the
client, then from `analytics.routes.ts`.

**The per-message file cap is client-declared.** The reply route carries one
media item per request, so there is no single request holding five files. The
console cannot exceed it even with a modified client; a direct API caller
issuing five separate requests is a different act, bounded by the rate limiter.

---

## 5 · Gates

```bash
cd apps/backend
npm run test:tenancy          # 130  — isolation; a red gate is a release blocker
npm run test:public-api       # 141  — over HTTP against a booted server
npm run test:api-tokens       #  90
npm run test:workflow-p2      #  75
npm run test:webhooks         #  52
npm run test:restrictions     #  51
npm run test:csv              #  30
npm run test:meta-templates   #  34  — only after item B is committed
node scripts/verify-collaborators.js   # 14 — unregistered, see §4

cd apps/frontend
npm run check:i18n            # every t() key translated in he + en
npm run check:mojibake        # Arabic/Hebrew decoded as Latin-1
npx tsc --noEmit && npx next build
```

`test:public-api` boots a real server. If it prints `[ENV]` there is **no
summary line** — deliberately. A run that could not start has tested nothing
and must not print a number that looks like it did.

---

## 6 · What is left

| | |
|---|---|
| **Meta 250-caps** | **Two caps, both 250, different denominators.** The per-24h messaging tier limit (`maxUniqueRecipientsPer24h` — modelled, surfaced, unenforced, D-24) and the per-broadcast unverified-business ceiling (not modelled at all, absent from D-24). Finish item B with both, one commit — see §2 |
| **WhatsApp ceilings** | Messaging tiers and quality rating. **The second tier's ceiling is an open question, not a known number.** respond.io's messaging-limits page says 250→2K→10K→100K (2K twice); their promotional page says 1K once — a conflict inside one vendor's own docs, and neither page is authoritative about Meta. `meta.adapter.ts:23` maps `TIER_1K → 1000`. `TIER_1K` appears to be Meta's own enum string rather than something invented here, so the discrepancy is more likely in the *ceiling* than in the *name* — Meta has changed the number attached to that tier before. **Meta's own documentation settles this; ours does not.** Check there before relying on either number, and do not "correct" the adapter from a vendor page |
| **Small tail** | Unmerge, import tags, default segments, typing indicators, link previews, merge card, 4 sort modes |
| **Settings** | Data Export (async job, 7-day expiry), Growth Widgets |
| **Reports** | Lifecycle funnel, Assignments, Leaderboard, Users |
| **P2 tail** | 31 workflow templates, testing, import/export |
| **Owner console** | Six `PlatformPlaceholder` stubs: finance, organizations, operations, data, support, legal |
| **Canvas** | The graph editor. Unblocks `JUMP_TO` and `TRIGGER_WORKFLOW` |
| **AI** | Nothing exists. **Fix the executor's shape first** — it is a `switch`, so every safety property is per-case, which is how D-30 and D-31 happened |

**Growth Widgets is the largest conceptual gap.** No widget model, no
`sourceUrl`, no referrer, no attribution field on `Contact` — so *"which
campaign produced these customers"* is unanswerable in principle, not merely
unbuilt.

---

## 7 · Owner-only, and unmoved

Nothing engineering does substitutes for these.

1. **Rotate the exposed secrets.** The public repo names `dev-admin-key` and the
   shipped default database password; a MongoDB Atlas password was pasted into
   chat. **Rotation, not removal** — the history is public.
2. **Payment provider.** Activation is automatic, checkout is stubbed. The
   product cannot take money.
3. **Domain, TLS, VPS.** Not reachable by a customer.
4. **ToS and privacy policy.** Required before processing anyone's messages.
5. **MAC counting.** Ours counts broadcasts; theirs excludes them. A pricing
   decision, open for a while now.

---

## 8 · Where to start

0. **Read §9 too.** It was added after the rest and carries three things §1–§8
   cannot tell you: the auto-loading skill whose schema instruction springs
   §1's trap, the fact that every documented backup procedure here runs through
   a Docker daemon that is currently hung (with the way round it), and a
   corrected file list — **the tree has 16 uncommitted files, not 15** — and §10,
   which explains why a clean checkout of main goes red against this database. So do
   not stop at step 1 below on the count alone.
1. Read §1 and confirm the tree matches. If it does not, **stop and ask** —
   somebody has committed or reverted since this was written.
2. Ask whether to push `b5b97a10` and whether to commit item B.
3. Then pick from §6. Nothing there depends on conversation you do not have;
   the code is the authority, and it has been right every time it disagreed
   with a plan.

---

## 9 · Added 2026-09-02 — findings from a session that changed no code

This section exists because the findings below were discovered *after* §1–§8
were written, in a session that deliberately wrote nothing else. Two of them
are traps; one is an unblock; one is a decision that cannot be recovered from
the code.

### Docker's daemon is wedged, and it does not stop you taking a backup

`docker ps` exits 124 on a 10-second bound. `Docker Desktop` and two
`com.docker.backend` processes are alive, so the daemon is **hung, not dead**.
This is D-3 recurring for the third time.

**The database is unaffected and still reachable.** Port 15432 answers and the
server reports `PostgreSQL 15.19`.

That matters because **every backup procedure this repo documents runs through
`docker exec`** — CLAUDE.md, the rollback procedure in
RESPONDIO-PARITY-CHECKPOINT.md, every dump taken during the invoice and
editions phases. With the daemon hung, all of them fail, and the reasonable
conclusion is "I cannot take a backup, so I must stop."

You can. **PostgreSQL 17 client tooling is installed on this host**, just not on
PATH:

```bash
PGBIN="/c/Program Files/PostgreSQL/17/bin"
PW=$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')

PGPASSWORD="$PW" "$PGBIN/pg_dump.exe" \
  -h 127.0.0.1 -p 15432 -U admin -d rabitech -Fc -f pre-change.dump

PGPASSWORD="$PW" "$PGBIN/pg_restore.exe" -l pre-change.dump   # verify, always
```

Client 17 against server 15 is the supported direction. `psql.exe` and
`pg_restore.exe` are in the same directory, so the whole rollback procedure in
RESPONDIO-PARITY-CHECKPOINT.md works without Docker — substitute the `psql`
invocation and drop the `docker exec` prefix.

**A current verified dump now exists**, taken this way:

```
.tools/backups/rabitech-20260902-105013.dump   1.85 MB
.tools/backups/rabitech-20260902-105013.txt    what it contains, and how to restore it
```

`.tools/backups/` is gitignored, so it is durable on this machine and never
committed. `pg_restore -l` returns exit 0 and 1087 objects — 132 table-data
entries, 238 FK constraints (the composite tenant keys that *are* the isolation
boundary), 55 types (the enums). It captured 91 applied migrations, 5 editions,
3 organizations, 2 subscriptions, 33 contacts, 98 messages, 0 invoices, 0
receipts.

The `.txt` beside it records all of that plus the restore command, so a future
session can tell what a dump holds without restoring it to find out.

### §1's file count is off by one — the tree has 16, not 15

§8 step 1 says to confirm the tree matches §1 and **stop and ask** if it does
not. It does not: `git status --porcelain` returns **16** entries. Do not stop
on this alone — here is the full list, verified 2026-09-02.

**Item A — trial-gateway (owner's), 9:**

```
?? apps/backend/prisma/migrations/20260930090000_standard_trial_gateway/
?? apps/backend/src/modules/channels/channel-entitlement.ts
 M apps/backend/src/modules/billing/billing.service.ts
 M apps/backend/src/modules/billing/plans.ts
 M apps/backend/src/modules/billing/trial.service.ts
 M apps/backend/src/workers/gateway-provisioning.worker.ts
 M apps/backend/src/modules/platform/platform.routes.ts
 M apps/backend/scripts/tenancy-bleed-harness.js
 M apps/frontend/app/platform/editions/page.tsx
```

**Item B — Meta template sending, 6:**

```
?? apps/backend/src/modules/meta-templates/meta-template-send.service.ts
?? apps/backend/scripts/verify-meta-template-send.js
 M apps/backend/src/modules/meta-templates/meta-templates.routes.ts
 M apps/backend/src/modules/channels/meta.client.ts
 M apps/backend/package.json
 M docs/RESPONDIO-PARITY-MATRIX.md
```

**Unattributed, 1 — this is the sixteenth:**

```
 M CLAUDE.md
```

Whether `CLAUDE.md` belongs to A, to B, or to neither is not recoverable from
the file. **Diff it before staging either item**, or it rides along into a
commit it does not belong to — which is the §1 failure mode exactly, just with
a documentation file instead of a migration.

**Plus `AGENTS.md` — the seventeenth, and expected.**

```
?? AGENTS.md
```

Added by the same commit that wrote this line, so the count depends on when you
look: a tree checked **after** that commit shows **16**, and one checked
between the file being written and the commit landing shows **17**.

If you see 17 and the extra entry is `AGENTS.md`, nothing is wrong. **Any other
seventeenth entry is somebody's uncommitted work — stop and ask.**

### The `rabitech-guide` skill will spring §1's trap

`.claude/skills/rabitech-guide` loads **automatically** for any session touching
files under `RabiTech V5/`. A fresh session gets it whether or not it opens
`docs/`.

Its schema-change instruction reads:

> hand-write the SQL migration … then `docker compose exec backend npx prisma
> migrate deploy`

Followed literally against the tree described in §1, that applies
`20260930090000_standard_trial_gateway` — the uncommitted migration in item A —
because `migrate deploy` takes **every** pending migration and offers no way to
select one. Its supporting code is uncommitted and the committed harness
asserts the opposite, so the result is a red `test:tenancy`, or worse a green
one locally that fails on a clean checkout.

That is precisely what `9a458795` reverted.

The skill is not wrong; it predates the tree being dirty. Two ways to close it,
neither done here because both are the owner's call:

- Add one line to the skill's schema section — *"run `git status` first;
  `migrate deploy` applies every pending migration, including uncommitted
  ones"* — pointing at §1.
- Or land/park item A so the trap has nothing to spring. Same shape as parking
  `growth-wip` during the invoice phase: its own branch, fully recoverable,
  tree clean afterwards.

### A decision was made that the code cannot tell you

The owner asked to switch the database to MongoDB, pasting an Atlas connection
string. That was **declined and replaced**, not executed. The reasons are
recorded here because nothing in the repo shows a path not taken:

- 75 Prisma migrations, Postgres enums, CHECK constraints, `BigInt` and
  `String[]` columns — none port.
- The composite tenant foreign keys `[id, organizationId]` on every tenant
  table are *the* isolation boundary. CLAUDE.md states it: "the database
  rejects a cross-tenant write — app-level checks are not the boundary." Mongo
  has no foreign keys, so switching would delete that boundary.
- `test:tenancy` is built on disposable Postgres schemas and would not run.
- `INSERT … ON CONFLICT DO UPDATE … RETURNING` is what makes invoice numbering
  atomic and non-reusable — the whole point of the invoice integrity phase.

**What the owner actually wanted was a hosted database rather than local
Docker** — chosen explicitly when the options were put to them. That is a
managed **PostgreSQL** (Neon, Supabase, RDS), which is a `DATABASE_URL` change
plus a dump-and-restore, and keeps every gate working. Atlas is Mongo-only and
cannot serve it.

**This work is approved and not started.** Nothing has been done toward it.

### What this session did and did not do

Did: verified repo state and found §1's count off by one, diagnosed the wedged
daemon, found the host client tooling, took and verified the backup above, read
the skill, wrote this section.

**Did not:** change any application code, run any migration, or touch the 16
uncommitted files. The only tracked file this session changed is this one.

---

## 10 · The database is ahead of `main`, so `main` is red

Found 2026-09-02 while checking whether a new commit stood on its own. It does;
this does not.

**`20260930090000_standard_trial_gateway` is applied to the live development
database.** The migration file is untracked — item A in §1 — but somebody ran
it. `_prisma_migrations` has the row, and `Plan.STANDARD.autoProvisionGateway`
is `true`.

The committed code still says `false`, in both places:

```
committed  plans.ts       autoProvisionGateway: false
committed  harness        assert.equal(standard.autoProvisionGateway, false)
live DB    Plan.STANDARD  true
```

So a clean checkout of `main`, run against this database, **fails four checks**:

```
[FAIL] billing: a trial signup provisions a gateway once its email is verified
[FAIL] billing: the seeded edition catalogue matches PLAN_ENTITLEMENTS field for field
       STANDARD.autoProvisionGateway: database has true, constant has false
[FAIL] billing: Standard resolves end-to-end as messaging only
[FAIL] billing: an edition can be created, and the code space stays shut
125/129 checks passed.
```

Verified by swapping the committed `tenancy-bleed-harness.js` and `plans.ts`
into place, running the gate, and restoring both — checksums confirmed
identical afterwards.

**Why this is worth its own section.** §5 of the state document records getting
this exactly backwards once: a gate passed at 128/128 *because the owner's fix
was in the working tree*, reporting on the environment rather than on what was
committed. This is the same split seen from the other side. Anybody who checks
out `main`, runs the release blocker, and sees four billing failures will
reasonably assume they broke something. They did not. The tree is ahead of the
commit, and the database is ahead of both.

**It resolves itself the moment item A lands** — the working tree already has
the matching harness and `plans.ts` changes, which is why a run *here* is
130/130. Nothing needs fixing; item A needs deciding.

**Until then, two rules.**

A gate run in this working tree does **not** tell you whether `main` is green.
If that is the question, check out the committed files and run it against them,
the way this finding was produced.

And do not "fix" the four failures by editing the committed constants. They are
not wrong; they are simply older than the database. Editing them would commit
half of item A by hand, which is the §1 trap wearing a different hat.
