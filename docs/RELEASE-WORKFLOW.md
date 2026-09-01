# Release workflow

**Every change is committed and pushed. Nothing waits in the working tree for a
later batch.** Adopted 2026-09-01.

This file is the sequence. It exists because the alternative was demonstrated:
on 2026-09-01 this repository was carrying **54 commits across 16 branches that
existed on one laptop only**, with the last push dated 31 August. The editions
phase, the Stripe adapter and the invoice-integrity migration had no second copy
anywhere, and the co-founder could not see any of it — which is a plausible
reason he began rebuilding on a different database.

---

## 0. The repository is public

`github.com/osamarabi10/Rabi-Tech` is **public**, deliberately, confirmed by the
owner on 2026-09-01 after being shown what that publishes.

Two rules follow, and they are not negotiable by convenience:

1. **No secret ever enters the tracked tree.** Not in code, not in a doc, not in
   a commit message, not in a test fixture. `.env` is gitignored and has never
   been committed — `git log --all -- .env` is empty, and it stays empty. When a
   value must be shown, show its *name*, never its value.
2. **Rotation is urgent, not scheduled.** Because `CLAUDE.md`, `TODO.md` and
   `RESPONDIO-PARITY-CHECKPOINT.md` are public and name the shipped default
   database password and `dev-admin-key`, O1–O3 / F0.2 are a today item. Every
   push adds to a record that already describes those defaults.

If a secret is ever committed, **rotate it — do not just remove it.** The
`.gitignore` header says this and it is correct: history is public, so deletion
changes nothing about exposure.

---

## 1. The sequence

Run in order. Stop at the first red.

```bash
# 1. Typecheck. Cheapest signal, catches most of it.
cd apps/backend && npx tsc --noEmit -p .

# 2. The gates that apply to what you touched (see §2).
npm run test:tenancy          # any src/ change
npm run test:finance          # billing, invoices, receipts, OrgSequence

# 3. Frontend checks, if you touched the UI.
cd ../frontend && npm run check:i18n && npm run check:mojibake

# 4. Commit — your own files only (see §3).
git add <the files you wrote>
git commit

# 5. Push. This is part of finishing, not a separate errand.
git push -u origin <branch>
```

**Read the printed summary line, never the exit code alone.** A command list
exits with the status of its *last* command, so an appended `echo` or `tail`
replaces the gate's answer with its own. Every harness here prints
`N/N checks passed` for exactly that reason. Four defects in this repository
were gates reporting on their environment rather than on the code — D-5, D-10,
D-12, D-16.

**A gate is green only when it was watched to run.** Not when it was started,
not when the process is still on the process list, not when someone remembers it
passing last week.

---

## 2. Which gate for which change

| You touched | Run |
|---|---|
| Anything under `apps/backend/src/` | `test:tenancy` — it typechecks, lints for bare `PrismaClient`, and statically audits every socket emit and audit-log call site |
| Billing, invoices, receipts, `OrgSequence` | `test:finance` (17/17) |
| Backup or replication | `test:backup-replication` (30/30, hermetic — no Postgres, Redis or Docker) |
| Saved views / inbox filters | `test:inbox-views` (hermetic) |
| Signed media URLs | `test:media-url` |
| Snooze, campaign replies, dunning, worker fairness | the matching `test:*` script |
| Any UI string | `check:i18n` and `check:mojibake` |
| A Prisma schema change | write the SQL by hand, `prisma generate`, then `migrate deploy` — see CLAUDE.md |

**Image rebuilds run at checkpoints, not per commit.** `docker compose build`
belongs at the end of a batch, before something ships. Across eleven consecutive
runs it never caught a fault the typechecker and the harnesses had not already
caught, and it twice took the Docker engine down with it. This was removed as a
per-commit gate deliberately on 2026-09-01; do not restore it as one.

### Gates that need no environment

`test:backup-replication` and `inbox-views-check` are **hermetic** — they read no
environment variable and touch no database, so they cannot fail for a reason
that has nothing to do with the code. Keep them that way. Every other gate
requires `scripts/load-env.js` as its first require, which loads the one `.env`
at the repo root; see D-12 for what happens without it.

---

## 3. Commit only your own files

This tree frequently carries the owner's uncommitted work alongside anyone
else's. On 2026-09-01 it held changes to `billing.service.ts`, `plans.ts`,
`trial.service.ts`, `platform.routes.ts`, `system.routes.ts`,
`gateway-provisioning.worker.ts`, `editions/page.tsx`, `KNOWN-DEFECTS.md` and an
untracked migration — none of it reviewed, and the owner asked to review it
himself.

So: **`git status` before every commit, and stage files by name.** Never
`git add -A`, never `git add .`. Committing someone's half-finished migration
into a public repo on their behalf is not a small mistake.

If your change would touch a file someone else has open, say so before editing
it rather than after.

---

## 4. Branches

Multi-commit work, anything risky, and anything carrying a migration goes on a
branch — not straight onto `main`. Push the branch. Fast-forwarding afterwards
costs nothing; unpicking a bad commit from `main` on a public repo does not.

Name branches for the work, not the phase number:
`invoice-integrity`, `stripe-adapter-stage-1`, `meta-viability-gate`.

---

## 5. What "released" means here

A change is released when **all** of these are true:

- [ ] `tsc --noEmit` clean
- [ ] every gate in §2 that applies was **watched** to print `N/N checks passed`
- [ ] the working tree holds nothing of yours that is uncommitted
- [ ] the branch is pushed to `origin`
- [ ] the checklist entry is ticked **with its date and its evidence inline**,
      and mirrored into `PROJECT-SPEC.md` §6

That last line is not bookkeeping. On 2026-09-01, **H2 and H6 were both finished
and still showing as open** in `TODO.md` while `PHASES-TO-LAUNCH.md` recorded
them as complete, and the parity scorecard in `PROJECT-SPEC.md` §4 still listed
@mentions and saved segments as missing months after both shipped. Four
documents disagreeing about what is done is how finished work gets done twice.

**When a claim in a doc turns out to be stale, fix the doc in the same commit
that discovers it.** Do not open a task for it.

---

## 6. A migration is not reversible by wishing

Prisma Migrate is forward-only: there is no `migrate down`, no `migrate revert`.
Reversing one is a manual procedure, and the step people miss is the last one —
undoing the SQL is not enough, because `_prisma_migrations` still holds a row
saying the migration is applied.

The full rehearsed procedure is in
[RESPONDIO-PARITY-CHECKPOINT.md](RESPONDIO-PARITY-CHECKPOINT.md). Read it before
you need it, not during. Two rules from it that belong here:

- **Snapshot first.** `pg_dump -Fc`, verified readable with `pg_restore -l`. It
  is the only step the following steps cannot undo.
- **Never lower `OrgSequence`.** Reversing schema is recoverable; reissuing an
  invoice number a real document already carries is discovered by the customer
  being billed.
