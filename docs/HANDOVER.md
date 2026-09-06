# Handover — read this before touching anything

Refreshed 2026-09-06. §0 is the current state; everything from §1 onward was
written 2026-09-02 and is kept for the reasoning behind rules that still hold.
Where a later section is out of date, it says so at the top.

**The working tree is clean.** It was not when this was written — §1 described
sixteen uncommitted files across two unrelated bodies of work, and most of this
document exists because of them. Both landed on 2026-09-02: item A as
`ef4842e5`, item B as `1f652be7`. Nothing is uncommitted now.

§1 is kept as history rather than deleted. The incident it describes —
`9a458795`, a migration swept into main by `git add apps/backend/prisma` — is
still the reason the staging rules in §3 exist, and those rules have not
relaxed.

Longer background: [SESSION-STATE-AND-AUDIT.md](SESSION-STATE-AND-AUDIT.md) —
what was built, every defect found, the recurring failure pattern, and the
ranked risks.

---

## 0 · Current state — 2026-09-06

**Read this section, `docs/DEPLOYMENT-READINESS.md`, and `docs/DECISIONS.md`
D-10 to D-19. The rest of this file is background from 2026-09-02 and parts of
it are superseded; each such section says so.**

The working tree is clean. `main` and `editions-ladder` are level at
`f9c79ee1`, both pushed.

### What changed today, in one line each

| commit | |
|---|---|
| `5fe07cc5` | The provisioning worker became a supervised compose service; one rule for the host boundary |
| `8b331be1` | Deleted the competing supervisor scripts; two AGENTS rules about instruments that lie |
| `d5d8325b` | The gateway state machine learned to **demote**, not only promote |
| `b16acabb` | API and app bound to loopback; healthcheck and memory limit on all six services |
| `9388e106` | Off-host backups configured and the restore **drilled**; `DEPLOYMENT-READINESS.md` written |
| `68c14628` | Every organization deleted on owner instruction; D-12 resolved, D-17 unblocked |
| `0a4d3e96` | `Organization.tier` deleted — the plan has one home (C3a) |
| `e9d21cbf` | `PlanVersion` and `Price`; subscriptions pin a version (C3b) |
| `f9c79ee1` | The `can / limit / usage / assertCan` façade, and a sweep that proves it completed (C3c) |

Four more commits are AGENTS rules earned by the work above, not by principle.

### The two bugs that shaped the day, and they are mirrors

The session opened with a customer scanning a QR, their phone saying *device
linked*, and the product saying **Disconnected forever**. Cause: the only thing
that records a pairing is the provisioning worker, and it was a hand-started
process the OOM killer had taken.

Fixing that exposed the reflection. A gateway that **drops** was never recorded
as dropped: four components observed a disconnect and not one wrote it down,
and the reconcile loop did not even select `ACTIVE` channels — so the tenants
being watched were the ones mid-setup, and the ones being paid for were not
watched at all. Organization `mark` sat reading `ACTIVE` for four hours while
its gateway displayed a QR code.

The second is worse. A product that says *not connected* when it is sends the
user to support; one that says *connected* when it is not sends them nowhere.
See D-16.

### The database is empty

No organizations, subscriptions, channels, sessions, conversations, messages or
contacts. The owner deleted all three remaining ones — `mark`, `rabitech-demo`
and `ostudio`, the last explicitly, accepting the loss of its 17 real inbound
messages — after a backup verified by a full restore drill. 5,357 rows across 38
tables in one transaction.

Retained: the five-edition Plan catalogue, the OWNER identity, platform
settings, the platform audit log.

**Two consequences that outlive the deletion.** The first real customer will
genuinely be the first — nothing may rest on *"it works for the existing
tenants"* any more. And schema migrations are nearly free right now, with no
legacy rows to grandfather; that is the condition C3 was done under and it will
not last.

### In flight

Nothing. C3 is complete in three commits and every gate is green — a sweep of
all twelve, manifest-verified, is the last thing that ran.

**C3 was split deliberately.** Deleting `tier`, restructuring the catalogue and
building the façade touch disjoint code and each has its own provable property,
so a failure in any one of them inside a combined commit would have been hard
to attribute.

**C3c shipped the façade without finishing the move onto it**, and that is the
one thing a fresh session needs to know about it. `can / limit / usage /
assertCan` exist, are pure, and are proved behaviourally — but
`assertMetricAvailable` and `assertSeatAvailable` still resolve and decide for
themselves, and the workspace ceiling is still an inline count-and-compare in
its route. So the façade is *a* way to ask, not yet *the* way. That is C4, and
it is the reason C4 exists.

### What is next

C4 through C8 of the editions ladder, in `.claude/plans/prancy-puzzling-anchor.md`:

1. **C4 — adoption.** The façade is built (C3c); C4 is what makes it the only
   surface. Route `assertMetricAvailable` and `assertSeatAvailable` through
   `can`/`limit`, bring the workspace ceiling onto the same path, and keep the
   shown number and the enforced number reading from one source. Two ways to
   ask one question is the condition the façade exists to end, and it is the
   state the tree is in until this lands.
2. **C5** — the numbers meter (`maxNumbers`), the brief's second meter and the
   only wholly missing one.
3. **C6** — the plan editor writes a **new version** rather than editing the
   current one in place, and the existing preview is retargeted at versions.
   C3b deliberately left editing in place; this is where that changes.
4. **C7** — MAC: keep measuring, stop enforcing. A pricing act, so it is visible
   on its own.
5. **C8** — billing provider wiring, one-way outward.

Also open and not in that ladder:

- **D-10** — a first Connect on a cold gateway shows the customer an error for
  five seconds and then silently succeeds. Recorded, not fixed; the timeout
  belongs with the hosting decision.
- **D-15** — `destroyGateway` deletes the Organization as a side effect of
  retiring a gateway. **Do not call it.** Recorded for the delete-account work.
- **D-17** — the shared `openwa` service is a dead lane that still resolves.
  Its blocker is gone; removing it is a compose change nobody has asked for.
- **The tenancy harness leaves debris.** It deletes its fixture organizations
  and leaves their scheduled jobs in Redis, two more per run. AGENTS records it;
  nothing fixes it.
- **`verify-lazy-provisioning` enqueues on the real queue.** Stop
  `gateway-worker` before running gates, or the worker claims the job and builds
  real tenant containers. Documented in `DEPLOYMENT.md`; the proper fix is an
  isolated queue prefix.

### Owner-only — nothing engineering does substitutes for these

⬛ marks them in `DEPLOYMENT-READINESS.md` too.

1. **Rotate the exposed credentials, then clear `ALLOW_INSECURE_SECRETS=1`.**
   The flag is set today, which bypasses the boot gate that refuses shipped
   defaults. It must be cleared before the box goes up, and clearing it requires
   rotating first. §7 below still describes the credentials.
2. **Copy `BACKUP_ENCRYPTION_KEY` somewhere else.** It exists only on the
   machine it protects, which makes it useless in the disaster it is for. The
   backups are otherwise working and drilled: recovery from the off-host copy
   took 10.35 s.
3. **TLS, a reverse proxy, and the domain.** Both ports are loopback-bound now;
   that is the half that needed no decision. `FRONTEND_URL` and `APP_BASE_URL`
   still point at localhost.
4. **Firewall host ports 3100–3999**, the tenant gateway range.
5. **SMTP.** No email is delivered by anything (D-2).
6. **Stripe, then Meta.** Revenue rather than safety, and last for that reason.
   Meta's absence is why three of five editions cannot be sold at all (D-9).
7. **CI has been red since before this session** and is still red — the
   *Tenancy bleed gate* workflow, every run. It is **not the code**: the
   committed tree passes 153/153 from a clean export with only the workflow's
   five environment variables, on Linux time. The failing step is
   `npm run test:tenancy` and the log needs admin rights to read. Paste the last
   ~40 lines of that step and it can be closed. A red gate nobody reads trains
   everyone to ignore the one that matters. Also move to
   `actions/checkout@v5` / `setup-node@v5` in the same commit.
8. **Unlink stale WhatsApp devices on the phone.** Every gateway they belonged
   to is gone; the entries are dead and each occupies one of four slots.

### Capacity, measured rather than asserted

Docker VM 7.727 GiB. An **idle** gateway is ~135 MiB; a **live paired** one is
**900 MiB** — 6.7×, and the idle number is what an empty staging environment
shows you. Roughly six to eight active tenants on this machine. That is the
hosting decision with a number attached (D-11).

### Three operational rules that will bite a fresh session

- **Run the sweep with its runner, not by hand.**
  `bash apps/backend/scripts/run-gate-sweep.sh` runs all twelve gates, stops
  `gateway-worker` for the duration and restarts it on the way out, and ends
  with a manifest that fails if any gate is missing, stale, empty or non-zero.
  Results land in `.gate-runs/<timestamp>/`, which is gitignored. Adding a gate
  means adding it to the manifest in `verify-gate-sweep.js`.
- **Stop `gateway-worker` before running gates.** The runner above does it for
  you; doing it by hand is what this is for.
- **The gates run `dist/`.** A stale build produces failures that read like code
  faults; `verify-lazy-provisioning` reported `Unknown argument tier` from
  compiled output while the source was already clean.

---

## 1 · The tree as it was — historical, and still the reason for §3

> **CLOSED 2026-09-02.** Everything below describes a tree that no longer
> exists. Item A landed as `ef4842e5` (ten paths, staged by name) and item B as
> `1f652be7` (seven paths, with the per-24h recipient cap enforced;
> `test:meta-templates` 41/41). The tree is clean and **`origin/main` is at
> `343ec316`**.
>
> **Verified on a genuine fresh clone, not inferred.** `origin/main` was cloned
> into a temp directory, installed from a cold `npm ci`, built, and run against
> the same development database: **130/130**. Every earlier "green" in this
> document was a working-tree run, which §10 explains cannot answer this
> question. This one can.
>
> Kept because the rules in §3 were paid for here, and a rule whose reason has
> been deleted is one the next person talks themselves out of.

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

The owner asked for template sending and the cap work in **one commit**. That
happened on 2026-09-02 as `1f652be7`: template sending landed **with the
messaging tier limit enforced**, and `test:meta-templates` went 34 → 41.

**The unverified-business ceiling is still not implemented.** It is the second
cap above, and satisfying the first does not satisfy it.

---

## 3 · The rules that are not optional here

These are not style preferences. Each came from a defect that shipped.

**Stage files by name. Never a directory.** See §1.

**A gate is green only when it was watched to run.** Read the printed
`N/N checks passed` line. A command list exits with the status of its *last*
command, so anything appended replaces the gate's answer. Four defects in this
repo were gates reporting on their environment — D-5, D-10, D-12, D-16, and a
fifth in §5 of the audit doc.

**Assert reachability, not just correctness.** **Ten** instances of
*declared-but-unreachable* have been found here. A trigger with no dispatch
site, a scope no endpoint requires, an action with no executor branch, a
setting nothing reads — all compile, all pass tests, all appear in the UI, and
none work.

The tenth is `TemplateSendSource.CAMPAIGN` (`meta-template-send.service.ts`):
the union declares `MANUAL | CAMPAIGN | WORKFLOW | API` and only `MANUAL` is
ever passed. It is the mildest of the ten — a placeholder for a path not yet
built, rather than a feature claiming to work — and it is counted anyway,
because the number is what makes the pattern legible. Nine reads as a run of
bad luck; ten reads as a shape.

It also exposes a gap in the gates below: they check routes, triggers, actions
and scopes, and **nothing checks enum members**. A possible extension, noted and
deliberately not built.

The gates now check:

- every workflow trigger has a `dispatchWorkflowEvent` call site
- every action has an executor branch **or is provably refused at save**
- every refused action is absent from the *served* vocabulary
- every API scope is required by some endpoint
- every analytics report is reachable from the UI, or listed as deliberately not
  (added 2026-09-02 — this bullet described a gate that did not exist; see §9)
- the executor calls the gateway exactly once, from inside the consent check

**Ask what the check cannot see.** Three instances now of one shape: the
instrument was structurally incapable of seeing the property it was checking.
A source assertion read `dist/` for a cast that compilation **erases**. A cap
check matched a string living inside the guard's own declaration, so deleting
the call site left it green. And two regexes matched a bare `\n`, invisible to
`git diff` because **`git diff` normalises line endings**. Each was a right
assertion pointed at the wrong artifact.

Source properties need source; runtime properties need compiled output; and
anything the build or the VCS normalises cannot be trusted from inside the thing
that normalises it. Full write-up in §4 of
[SESSION-STATE-AND-AUDIT.md](SESSION-STATE-AND-AUDIT.md); the instances are
D-32 and D-33.

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

~~**`verify-collaborators.js` is not registered.**~~ **Closed 2026-09-02.**
Registered as `npm run test:collaborators`, 14/14. It was waiting on item B
only because `package.json` carried that item's uncommitted changes; item B
landed as `1f652be7` and the file was clean.

**`utcOffsetMinutes` is still accepted and ignored** on the analytics query
string, so a deployed frontend does not 400 mid-rollout. Drop it from the
client, then from `analytics.routes.ts`.

**The per-message file cap is client-declared.** The reply route carries one
media item per request, so there is no single request holding five files. The
console cannot exceed it even with a modified client; a direct API caller
issuing five separate requests is a different act, bounded by the rate limiter.

---

## 5 · Gates

> **Counts updated 2026-09-06.** `test:tenancy` is **153**, not 143: three
> checks for gateway disconnect detection (D-16), two guarding the deleted
> `Organization.tier` and the shipped signup rate limit (D-18). A new gate
> joined them, `node scripts/c3-entitlement-snapshot.js`, which seeds eight
> organizations through the real signup path and asserts resolved
> entitlements are byte-identical across the edition migrations.
>
> **Stop `gateway-worker` before running any of them** — see §0.

```bash
cd apps/backend
npm run test:tenancy          # 143  — isolation, now on two axes; a red gate is a release blocker
npm run test:public-api       # 141  — over HTTP against a booted server
npm run test:api-tokens       #  90
npm run test:workflow-p2      #  75
npm run test:webhooks         #  52
npm run test:restrictions     #  51
npm run test:csv              #  30
npm run test:meta-templates   #  41  — registered; the cap added seven checks
npm run test:collaborators    #  14  — registered 2026-09-02, see §4
npm run test:secrets          #  12  — no compromised credential in a tracked file
npm run test:auth-exemptions  #  16  — over 16 surfaces: 8 in the middleware, 8 outside it
npm run test:growth-widgets   #  17  — attribution, end to end; boots a server

cd apps/frontend
npm run check:i18n            # every t() key translated in he + en
npm run check:mojibake        # Arabic/Hebrew decoded as Latin-1
npm run test:e2e              # 193 passed, 2 skipped — the whole Playwright suite
npx tsc --noEmit && npx next build
```

**The default set is eleven**, and `test:e2e` is the newest of them. It needs
`RABITECH_E2E_SESSION` and a production build, and it is the slowest by an
order of magnitude. The two skips are pre-existing `test.skip`s in the suite,
not anything switched off to make a number look better.

It was added because nothing ran it. `settings-responsive` reached **19 failed
/ 37 passed** and stayed there across three commits, and the count travelled
forward in report prose each time — a person remembering rather than a gate
checking. Both causes turned out to be small: an assertion counting anonymous
checkboxes, which broke the day a second toggle shipped, and an expected payload
missing four restriction flags added later. Either was a one-line fix on the day
it appeared. The cost of finding out late was not the fix; it was that nobody
could tell a new failure from the nineteen already there.

`test:public-api` boots a real server. If it prints `[ENV]` there is **no
summary line** — deliberately. A run that could not start has tested nothing
and must not print a number that looks like it did.

**`test:secrets` and `test:auth-exemptions` are the two cheap ones.** Neither
needs a database, a build, or a booted server — both read source and finish in
about a second, so there is no excuse for not running them on any clone.

`test:secrets` asks one question: *is a compromised credential in the public
repository?* Its file list is `git ls-files`, never a filesystem walk, so a
local `.env` is correctly invisible and a tracked `.env.example` is not. It
matches known-compromised values repo-wide by SHA-256 digest — the digest, so
the gate can recognise a secret it does not itself contain — plus known-weak
values from `verify-secrets.ts`'s own `KNOWN_WEAK` (parsed, not copied) where
they are assigned to a credential key in a config file, plus
`ALLOW_INSECURE_SECRETS` shipping as `1`. See §7.1 and D-34.

`test:auth-exemptions` covers every surface reachable without the `/api` auth
middleware, where the invariant is that **exemption from that middleware must
never mean exemption from tenant scope.** Sixteen checks over **16 surfaces: 8
exemptions inside the middleware and 8 registered outside or above it.** Each
declares a category with a reason in prose — 1 genuinely public, 2 scoped
elsewhere, 3 public but tenant-derived, 4 authenticated with no tenant data —
and categories 2 and 3 declare the chain that establishes scope, checked to
exist and to end in a real `runAsOrganization` or `runAsPlatform` call.

Deliberately **not** a snapshot of the path list: that would go red on every
legitimate edit and still could not tell a safe addition from a dangerous one.
What makes it a coverage guarantee instead is set equality — the annotated set
must equal the found set, checked both ways, so a new router mounted elsewhere
fails for having no annotation and an annotation fails when its route moves.

**What it still cannot see, and it is the same blindness one level down.** It
reads `index.ts` and nothing else. A route registered inside a *router* file —
on a `Router()` rather than on `app` — is invisible to it, exactly as the
outside mounts were invisible before D-35. The eight it now covers were found by
reading `index.ts` by hand; nothing has done that for the router files.

**Your first run on a fresh clone will look like it has hung. It has not.**
`test:tenancy` boots the backend through `ts-node/register/transpile-only`,
which transpiles the whole source tree in process and caches nothing to disk.
Measured immediately after a cold `npm ci`: **~24 seconds to listening**, against
**~5 seconds** once warm. The readiness budget is **60 seconds** for that
reason.

If a genuinely slow machine still overruns it, raise
`HARNESS_BACKEND_READY_MS`. The failure now tells you which of the two things
happened — a backend that **exited** is a code problem, one that is **still
running** is a slow start and wants a bigger number, not debugging. See D-33;
the timeout wording is proven, the crash wording is not.

---

## 5.1 · Workspaces — the second key column

**This section exists because everything above it predates Workspaces.** A
session that read this document before 2026-09-03 would be wrong about the
schema: it described a single tenant key when there are now two.

### The model

`Workspace` is a division **inside** an organization — its own channel, its own
contacts, its own threads. `Organization` is still the tenancy boundary and
nothing about that changed. `WorkspaceMember` says who may work in one, and
carries a `role` copied from `User.role` rather than defaulted, because a
default would silently re-permission everybody on the day the table appeared.

Every organization has exactly one default workspace, created with the id
`ws_` || organization.id. That derivation is deliberate: it made the backfill
idempotent and it lets `down.sql` recognise its own rows. A partial unique index
enforces one default per organization.

### workspaceId is a THIRD key column, on four models only

`WhatsappSession`, `Contact`, `Conversation`, `Message`. Those four hold a
division's own work. The **other 54 tenant-scoped models are organization-scoped
only** — one billing account, one set of teams, one keyword list, one seat
count — and that is a product decision, not an omission. Adding a model to
`WORKSPACE_SCOPED` in `prisma/extensions.ts` is a decision about what a
workspace owns, and it is additive whenever it is taken.

`User` is deliberately absent from that set, and the absence is load-bearing:
seats are counted as `User` rows, so somebody working in five workspaces is one
row and one seat. The tenancy harness asserts both halves — the count, and the
list — because either alone leaves the other reachable.

Every composite foreign key between the four carries **both** keys, so a
conversation whose contact belongs to another workspace is unrepresentable in
the database rather than merely unwritten by careful code. App-level checks are
not the boundary; these are.

### The four constraint decisions, each for a different reason

| Constraint | Decision | Why |
|---|---|---|
| `Contact (organizationId, phone)` and `(organizationId, email)` | **Widened** | The same number in two workspaces is two contacts sharing nothing. This is the semantic change the whole model rests on |
| `Conversation (organizationId, displayId)` | **Not widened** | `displayId` is `1000 + OrgSequence`, an organization-level counter, and it is the number a customer quotes back at an agent. Per-workspace numbering needs a per-workspace counter — behaviour dressed as a constraint — and would let two workspaces both hold a "conversation 47" inside one company |
| `Message (organizationId, waMessageId)` | **Not widened** | The id comes from the provider and is globally unique there, so organization scope already disambiguates it. Three delivery-status callbacks look it up knowing only the organization; widening breaks status handling to buy disambiguation the identifier does not need |
| `WhatsappSession (organizationId, sessionName)` and `(organizationId, phoneNumber)` | **Not widened** | One physical number, one gateway. Widening would let the data model represent two workspaces owning the same number — a state the gateway cannot be in. A constraint that permits an impossible reality is worse than a restrictive one |

### The active workspace is a claim, never a parameter

There is no header and no query string that selects a workspace, for the same
reason `organizationId` has never had one: anything the client sends, the client
can change.

It is minted in **two places and only two** — at login, stamping the default
workspace, and at `POST /api/workspaces/:id/activate`, which re-signs the
existing payload after checking membership. Re-signing rather than rebuilding is
deliberate: a claim added to the login path later cannot then be silently
dropped by switching.

`verifyToken` **re-validates on every request**, because a token outlives the
moment it was signed and a membership revoked an hour later would otherwise keep
working until expiry. The two refusals are deliberately different:

- **A workspace id from another organization** resolves to nothing inside the
  organization scope and is refused as **not found**. Confirming that another
  tenant's workspace exists is itself a disclosure.
- **A workspace in this organization the user is not a member of** is refused as
  **forbidden**, because they can be told that much.

An absent claim is not a refusal: it resolves to the organization's default
workspace, which is where a pre-workspaces session's data already is.

### The public API `phone:` identifier — a temporary state, with its end condition

`phone:` and `email:` resolve against the organization's **default workspace**,
and return **400 `ambiguous_identifier`** the moment an organization has more
than one.

Correct today rather than merely convenient: with one workspace there is exactly
one answer and this finds it. `ApiToken` is not workspace-scoped, and giving it
a workspace is a change to the token model, its issuing UI and its published
documentation — which is why it is not done yet.

**The condition that ends this is the first organization to create a second
workspace.** At that point the identifier stops being unique and the endpoint
says so instead of returning a contact from whichever workspace sorted first —
which on a `PUT` would overwrite a record belonging to a different part of the
business. When token scoping lands, `assertRefUnambiguous` is **deleted, not
relaxed**.

### Deferred, as decisions rather than omissions

`WorkspaceMember` management UI · per-workspace settings · moving data between
workspaces · the downgrade behaviour, which **is decided and not built**: a
BUSINESS subscriber dropping to GROWTH keeps their workspaces, the non-default
ones become read-only, and the billing screen names exactly which and why.

---

## 6 · What is left

> **Superseded for the editions track by §0.** C3 is done; C4–C8 and the
> open decisions are listed there. The table below is still accurate for
> the product surface — Meta caps, widgets, reports, the canvas, AI.

| | |
|---|---|
| **Meta 250-caps** | **(a) landed** in `1f652be7` — the per-24h messaging tier limit is enforced in `sendMetaTemplate` from `maxUniqueRecipientsPer24h`, counting distinct recipients with `releasedAt: null` inside a rolling window. D-24 is closed. **(b) still open** — the per-broadcast unverified-business ceiling is a different denominator, modelled nowhere, and belongs to the broadcast path. **When that path is built:** refuse-per-recipient-and-continue, not halt. `assertWithinRecipientCap` returns early for a recipient already inside the window, so halting on the first refusal would also refuse sends that were permitted. The campaign worker's existing split is the precedent — a rolling cap resets, so it behaves like `QuotaExceededError` (`pending`), not like a capability (`failed`) |
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

> **See §0 for the current list**, which is shorter and ordered. This
> section still carries the detail on the exposed credentials, and item 1
> there depends on it. Nothing here has been done.

Nothing engineering does substitutes for these.

1. **Rotate the exposed secrets.** The public repo names `dev-admin-key` and the
   shipped default database password; a MongoDB Atlas password was pasted into
   chat. **Rotation, not removal** — the history is public.

   Unchanged in substance, more urgent in degree: `main` has moved from
   `3f041e92` to `343ec316` and now carries considerably more code publicly —
   the public API, the webhook system, Meta template sending, the platform
   console. Nothing about that changes what has to happen to these two
   credentials, but there is more surface standing behind them than when this
   item was written, and every day they stay valid is a day the rotation was
   still outstanding.

   **A third credential joined the list on 2026-09-02, and it was worse than
   the other two.** `.claude/settings.local.json` was tracked. Inside its
   recorded permission entries were the literal `dev-admin-key` on **12 lines**
   and a live **OpenWA webhook secret on 2** — a real, generated secret rather
   than a known-weak default, in a public repository. Nobody decided to publish
   it; a broad `git add` swept the file in and it then accumulated whatever
   credentials the approved commands happened to carry. See D-34.

   Untracked in `61f082f7` with `git rm --cached` and added to `.gitignore`.
   The working copy is deliberately kept — it holds this machine's approvals.

   **Untracking removed nothing from history.** Both values in that file are
   permanently public and need rotating **at the source**: a new OpenWA API key
   and a new webhook secret, issued from the gateway, not edited out of a file.
   Nothing in the repository can undo this and no further commit will change it.

   `test:secrets` now fails if either value reappears in any tracked file, and
   it went red on the real thing before the fix — 4 hits for the webhook secret,
   12 for `dev-admin-key`. **After rotation the digests stay in `COMPROMISED`.**
   A rotated secret is still a secret that must never come back, and deleting
   its digest is how it comes back.
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

> **This paragraph was wrong, and is corrected here rather than deleted** — the
> mistake is more instructive than the conclusion. It said `CLAUDE.md`'s
> ownership was "not recoverable from the file". It was recoverable, from the
> diff, in about a minute.
>
> **It belongs to item B.** One hunk, `@@ -279,0 +280,26 @@`, documenting the
> `test:meta-templates` gate — refusal ordering, the deliberate `assertSendable`
> bypass, the mutation-proof note. Zero occurrences of any item A term
> (`trial`, `autoProvisionGateway`, `STANDARD`, `gateway-provisioning`); item B
> terms present.
>
> And §1 had it right the whole time: its item B list names
> `CLAUDE.md (gate docs)`. So §9 was not filling a gap, it was **contradicting
> §1** — and §1 won. It landed with item B in `1f652be7`, which is where it
> belonged.
>
> The rule that survives is still the right one: **diff a file before staging
> it**. What changes is the reason — not because ownership is unknowable, but
> because it is knowable and worth thirty seconds of looking.

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

The skill is not wrong; it predates the tree being dirty.

> **Disarmed 2026-09-02, by the second of the two options below.** Item A landed
> as `ef4842e5`, so there is **no pending uncommitted migration left for
> `migrate deploy` to sweep**. `prisma migrate status` reports the database up
> to date, and the skill's instruction is now safe to follow literally.
>
> The trap was in the *tree*, never in the skill — which is why landing the work
> closed it and no edit to the skill was needed. It returns the moment another
> migration sits uncommitted, so the first option below is still worth doing as
> a standing guard rather than a fix.

Two ways it could have been closed, the second of which is what happened:

- Add one line to the skill's schema section — *"run `git status` first;
  `migrate deploy` applies every pending migration, including uncommitted
  ones"* — pointing at §1. **Still not done, and still worth doing.**
- Or land/park item A so the trap has nothing to spring. Same shape as parking
  `growth-wip` during the invoice phase: its own branch, fully recoverable,
  tree clean afterwards. **This is what happened.**

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

## 10 · The database was ahead of `main` — CLOSED 2026-09-02

> **Closed, and this time with the evidence rather than the inference.**
>
> `ef4842e5` supplied the missing half: the migration was already applied to the
> development database while the committed code still said `false`. The
> `130/130` run after that commit was the first to describe the **committed**
> state — but it was still a working-tree run, and the rule below says a
> working-tree run cannot answer whether `main` is green.
>
> So it was answered properly. `origin/main` at `343ec316`, cloned fresh into a
> temp directory, cold `npm ci`, built, run against the same development
> database: **130/130**, with the media-filename check named and passing. None
> of the four billing failures this section documents.
>
> **Both rules below still hold and are not historical.** The split recurs the
> moment anyone applies a migration whose code is uncommitted, which is exactly
> how this one arose. And the clean clone earned its keep twice over — it is
> also what exposed D-32 and D-33, two gate defects that are invisible from a
> working tree by construction.



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
