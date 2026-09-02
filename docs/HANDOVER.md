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

**Still missing for it to be complete:** enforcement of the **250-contact
per-24h cap** for unverified businesses. D-24 records that
`maxUniqueRecipientsPer24h` is unenforced *only because* no business-initiated
conversation could start. Landing template sending removes the reasoning that
rested on. The owner asked for both in **one commit**; that has not happened.

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
- every new endpoint has a frontend reference

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
npm run test:tenancy          # 128  — isolation; a red gate is a release blocker
npm run test:public-api       # 141  — over HTTP against a booted server
npm run test:api-tokens       #  90
npm run test:workflow-p2      #  71
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
| **Meta 250-cap** | Finish item B with it, one commit |
| **WhatsApp ceilings** | Messaging tiers 250→1K→10K→100K, quality rating |
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

1. Read §1 and confirm the tree matches. If it does not, **stop and ask** —
   somebody has committed or reverted since this was written.
2. Ask whether to push `b5b97a10` and whether to commit item B.
3. Then pick from §6. Nothing there depends on conversation you do not have;
   the code is the authority, and it has been right every time it disagreed
   with a plan.
