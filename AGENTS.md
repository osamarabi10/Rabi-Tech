# AGENTS.md

How to build in this repository. Every rule below either came from a defect that
shipped here or from a principle that has held. Rules are grouped: **design**
governs what the code should look like, **evidence** governs how you know it
works, **scope** governs what you are allowed to touch.

---

## Design

- **Prefer removing an obsolete path to maintaining it — but never remove one
  that live data or a deployed client still depends on.** Compatibility layers
  are a cost, not a virtue; a broken customer is a larger cost. Where a
  transitional path must exist, give it a written expiry condition, not a
  permanent home. (`utcOffsetMinutes` is accepted and ignored so a deployed
  frontend does not 400 mid-rollout. That is correct, and it is finished when
  the client stops sending it.)

- **Choose the simplest implementation that fully meets the current
  requirement.** No speculative abstraction, configuration, or indirection.
  "We might need it later" is not a requirement.

- **Simplest wins on implementation; longest-lived wins on interface.** When
  the two rules above pull against each other, the tiebreak is reversibility:
  an implementation you can replace in an afternoon may be as simple as you
  like, a schema or an API shape that outlives the code may not.

- **Grow the system in layers.** Start from the smallest version that works end
  to end and add each capability on top of a product that already works. Never
  trade a working product for unfinished complexity.

- **Keep components modular and concerns separated.** In particular, a safety
  property must live in one place, not once per branch of a `switch`.

- **Prefer established, well-maintained libraries** where they reduce overall
  complexity or improve reliability. Do not reimplement common functionality
  without a stated reason.

- **Use what is already in the project before adding a package or writing your
  own.** Do not assume a dependency lacks a capability without checking its
  documentation and its types.

- **Make architectural decisions for the long term.** Do not accept a stopgap
  whose removal has no owner and no trigger.

---

## Evidence

Design rules do not catch the failures this repository actually has. These do.

- **The default gate set always runs.** Not the gates a prompt happens to list —
  all of these, every time:

  ```
  cd apps/backend    npm run test:tenancy   test:public-api   test:auth-exemptions
                     test:secrets           test:growth-widgets
                     test:meta-templates    test:collaborators
  cd apps/frontend   npm run check:i18n     check:mojibake
                     npm run check:legacy-settings-links
                     npm run test:e2e         # the whole Playwright suite
  both               npx tsc --noEmit
  ```

  `test:e2e` needs `RABITECH_E2E_SESSION` and a production build, and it is the
  slowest of these by an order of magnitude. It is in the list anyway.

  It was added after `settings-responsive` sat at 19 failed / 37 passed across
  three commits. Nothing in this list ran it, so nothing said so — the number
  was carried forward in report prose each time, which is a person remembering
  rather than a gate checking. Both causes turned out to be small: an assertion
  counting anonymous checkboxes, which broke the day a second toggle shipped,
  and an expected payload missing four restriction flags added later. Either
  would have been a one-line fix on the day it appeared. The cost of finding out
  late is not the fix, it is that nobody can tell a new failure from the
  nineteen already there.

  A prompt may exclude one, and the exclusion must be **stated and reasoned** in
  the report — never silent, and never by omission.

  This exists because thirty-seven untranslated strings shipped across two
  commits whose prompts enumerated only the backend gates. Nothing was broken
  and no gate was wrong; the list simply did not mention `check:i18n`, so it did
  not run. **Whoever writes the list becomes a single point of failure that the
  gates cannot compensate for**, and a default that must be opted out of is the
  only structure that survives an incomplete instruction.

- **A check is trusted only after it has been made to fail.** Break the thing
  the check exists to catch, watch the gate name it, restore, and verify the
  restored file is byte-identical. A green gate that has never gone red is an
  untested assertion.

- **A test catch-all must fail loudly, not answer plausibly.** A route handler
  that responds to every unmatched request with `{}` converts every fixture gap
  into the same misleading symptom: consumers read fields off an object that is
  truthy and empty, crash three components away, and the failure names whatever
  you were looking at rather than what was missing. Four separate causes once
  presented as "the rail is missing" for exactly this reason. Reject the
  unmatched URL and say which one it was.

- **One display utility per element per breakpoint.** Layering `flex` onto a
  `hidden … lg:block` class leaves two utilities competing, and the winner is
  decided by Tailwind's emission order rather than by anything written at the
  call site. An element whose visibility depends on which class the framework
  happens to emit last is unpredictable by construction — it will be visible,
  clickable, or neither, for reasons no one reading the component can see.

- **And prove the control: it must go green on the correctly-formed case.**
  Making a gate go red is half the proof. The other half is a case that *should*
  pass and does, because a check that is red for everything is as useless as one
  that is green for everything — and it is far more convincing, since a failure
  looks like diligence.

  Both directions, or neither is evidence. The version of this that bites is a
  guard whose own requirement hides its subject: a rule demanding a route sit
  inside an environment guard, checked by a parser that only recognises routes
  at column zero, is always red for correct code and would have been "proved" by
  a red mutation alone.

- **Read the summary line.** A gate is green only when you watched
  `N/N checks passed` print. A command list exits with the status of its last
  command, so anything appended replaces the gate's answer. Four defects here
  were gates reporting on their environment rather than on the code.

- **Point the check at the artifact that carries the property.** A source
  assertion cannot see behaviour, and a compiled artifact cannot see a type
  assertion — casts are erased by compilation. A check aimed at the wrong
  artifact is worse than no check, because it looks like coverage.

- **Assert reachability, not just correctness.** Declared-but-unreachable is
  this codebase's default failure mode: a trigger with no dispatch site, an
  action with no executor branch, a scope no endpoint requires, an endpoint no
  frontend calls. All of it compiles, passes, and appears in the UI. Every new
  surface needs a gate proving something reaches it, or an explicit,
  named allowlist entry saying why not — and the gate must refuse a stale
  allowlist entry, so an excuse cannot outlive the thing it excused.

- **A gate run in a dirty working tree does not tell you the committed state is
  green.** If that is the question, check the committed files out and run
  against them.

- **A revert that reaches for HEAD is not a revert when the baseline is
  uncommitted — snapshot the contents instead.** `git checkout -- <file>`
  restores from the index, so using it to undo a control mutation discards
  everything uncommitted in that file, including the code the mutation was
  testing. This removed a new gate mid-proof and the next run reported
  `130/130` — the count from before that gate existed. A green that is missing
  its checks looks exactly like a green that ran them, and the number was
  *lower* than the passing run, which is the only visible tell.

  A third route to declared-but-unreachable, and the least expected: not a check
  aimed at the wrong artifact, and not a mutation that missed its target, but a
  revert that silently deleted the subject before the check ran.

- **A mutation proof on frontend code must rebuild after restoring, not only
  restore.** `test:e2e` serves a production build through `next start`, so the
  compiled artifact is what the certification actually tests. Restoring the
  source leaves `.next` still asserting the mutation: byte-identical source is
  not a current build.

  The near-miss is the evidence. In 950048c0 the switcher A/B probe ended with
  a copy of the backup over `app/(dashboard)/layout.tsx` and an "restored"
  echo — after the e2e run, and with no rebuild. For roughly ninety seconds
  the source had the switcher mounted and `.next` did not. The certification
  passed only because the very next command happened to rebuild for an
  unrelated reason. Had it not, 36/36 would have been measured against a build
  with the feature removed — and it would still have been green, because the
  tests that would have caught it are the ones that did not exist yet.

  `check-build-freshness.js` now runs in front of Playwright inside `test:e2e`
  and refuses a build older than its source, so this is no longer something
  anyone has to remember.

- **The thing that establishes ambient scope can never be a consumer of it.**
  Anything running before or during the establishment of an ambient value must
  name that value explicitly, because the mechanism that would supply it is the
  thing being set up. The workspace resolver asked the Prisma client for "the
  default workspace" from inside the tenancy extension, where the client handed
  to you is the unextended one — so it read platform-wide and resolved to
  another tenant's workspace. Eight existing checks caught it. See D-38.

- **A per-line guard cannot see what a paragraph is about.** A filter operating
  one line at a time cannot make a decision that depends on wider context. A
  comment rename skipped any line naming the new concept and still corrupted
  seven files, because "the workspace this contact belongs to" carries no token
  saying which concept it means — the paragraph does. Widen the unit, or treat
  the pass as a draft and read the diff.

- **Suspect your input before you suspect the tool.** A migration failed on a
  `DO $$` block and the first conclusion was that Prisma could not parse it. It
  parses it fine; a shell expansion had eaten one dollar of each pair and the
  file said `DO $`. "The tool cannot do this" is far more expensive than "my
  input was broken": it sends the next person to a workaround for a limitation
  that does not exist, and it gets written into a comment that outlives the
  mistake. Read the file that was actually written.

- **An analysis script is an instrument, and it fails more often than the thing
  it measures.** Two scans of the session transcripts were wrong before they
  were right, in the two ways this repository keeps producing.

  The first was written into a heredoc and lost a backslash: a character class
  written to match either path separator arrived a backslash short, and node
  died on an invalid regular expression. Same shell mangling as the dollar-quote
  migration above, and the same fix — avoid the character rather than escape it
  harder. `String.fromCharCode(92)` and a normalising split cannot be eaten, and
  writing the script through a file tool instead of a heredoc avoids the shell
  altogether.

  Then the same character bit a third time, in a place with no shell involved.
  The rewritten script fed the corrected text to `String.prototype.replace` as a
  replacement **string**, and a replacement string treats a dollar followed by a
  backtick as "everything before the match". The text being inserted was itself
  about dollar-quote mangling, so it contained exactly that sequence, and the
  file inlined a copy of itself — 238 lines became 477, with zero deletions, so
  nothing looked destroyed. Pass a replacement **function** and the substitution
  rules do not apply.

  The second was quieter and would have produced a confident wrong answer. The
  pattern matched `npm run build` anywhere in a command, so `cat`, `cp`,
  `sed -i` and `git stash push` all came back tagged BUILD because a build
  appeared later in the same chain. Each would have counted as evidence that a
  build ran. Anchoring on where the match sits inside the command is what
  separated a real build from a mention of one.

  Both were caught because the output looked implausible, not because anything
  checked them. That is the rule above applied to the tool rather than the
  code: when a measurement disagrees with what you expect, the measurement is
  the first suspect.

- **Group failures by cause, not by symptom.** Nineteen failures were two
  causes. Grouping by error message produced three, because one of eighteen
  identical failures carried a different error — a load flake that fired before
  the real assertion was reached, inventing a Hebrew-desktop layout bug that
  does not exist. A symptom seen once among many identical failures is more
  likely noise inside the failure than a separate fault; re-run it alone before
  believing it.

- **A test that fails intermittently is reporting something intermittently, not
  reporting nothing.** A one-cell-in-thirty-six flake was a real user-facing
  defect: a failed undo visible for a single frame. It had been explained away
  in a comment and worked around with a widened timeout, and the timeout could
  never have helped — the toast was gone, not late. Name what the wait is for
  before widening anything. See D-40.

- **A checker that manufactures work gets distrusted, and a distrusted checker
  gets switched off.** When a new gate would demand hundreds of immediate
  entries, stage it: a ratchet that records today's count and refuses to let it
  grow buys the same guarantee without asking anybody to write ninety-eight
  justifications first. `check:i18n` shipped this way — 85 backlog, 0 exempt,
  and the number may fall but never rise.

- **Every migration ships a guarded `down.sql`** that refuses when live data
  depends on it, and a verified backup taken beforehand (`pg_dump -Fc`,
  confirmed with `pg_restore -l`) before it is applied.

  **Proved to refuse is not proved to reverse, and the difference matters.**
  Every `down.sql` here has been shown to parse and to refuse. Only the
  Workspaces ones have been run for real against a populated database and
  re-applied with row counts identical on both sides. For the rest, what is
  known is that the guards fire — not that the reversal leaves a working
  database. Exercise a reversal before claiming one, and never read "we have
  guarded down migrations" as "we can roll back".

- **Anything the project relies on to reproduce state — seeds, fixtures,
  bootstrap scripts — must be exercised by a gate.** `prisma/seed.ts` had been
  broken since the workspaces migration made `workspaceId` required: it omitted
  the column, so `npm run db:seed` could not create a session and the whole seed
  failed. It stayed broken for four commits and **all twelve gates were green
  the entire time**, because not one of them runs it. It is also outside
  `tsconfig`'s `include`, so `tsc` never looked at it either.

  A script that cannot run is a script nobody can verify, and the first person
  to find out is whoever needs a working database in a hurry. Either a gate
  invokes it, or it is dead code that should be deleted — those are the two
  honest states, and "it is there if we need it" is neither.

- **An audit that greps for a literal tests spelling, not behaviour.** Two
  audits fired in two consecutive commits on code whose enforcement had got
  strictly *stronger*, because a checked expression was assigned to a local and
  the string they searched for stopped appearing. One demanded
  `getEdition(planCode).autoProvisionGateway` in `billing.service.ts`; the flag
  had just moved from gating an automatic trigger to gating the provision
  itself, which is more enforcement in a better place, and the gate called it a
  regression.

  **Where a gate can be behavioural, it must be:** toggle the flag, assert the
  refusal, toggle it back, assert the action. That cannot be satisfied by
  spelling and cannot be broken by a rename. `verify-collaborators.js` records
  the same lesson from the other direction — it began as a grep for
  `if (shouldAdd)` and stayed green when the compiled output was mutated to
  `if (true)`, which is exactly the defect it existed to catch.

  A grep is still right for what has no behaviour to observe: an annotation, a
  forbidden import, a comment convention, a rule about which files may exist.
  The test is whether the property can be executed, not whether a grep is
  easier to write.

- **Never track a floating image tag.** `ghcr.io/rmyndharis/openwa:latest`
  moved from an image that read `API_KEY` to one that mints its own key into
  its data volume on first boot, and every per-tenant gateway began failing
  401 — no code changed, no config changed, and no gate could see it, because
  nothing in this repository had moved. Pin to a digest, in every compose file,
  and treat a tag change as a deployment: pulled on purpose, recorded in
  `docs/DEPLOYMENT.md`, and the gateway's authentication model re-verified
  before a tenant is built on it.

  Fifth instance of "the thing serving you is not the thing you think" — after
  `:18080`, `:4000`, `ts-node-dev` and the host port proxy — and the first
  where nobody changed anything at all. The earlier four were stale artifacts
  or a dead route on this machine; this one was a fresh artifact built by
  somebody else, arriving under a name the tree only points at. A gate can
  compare the tree against itself. It cannot notice the world moving
  underneath a name.

- **`docker kill` does not test a restart policy.** The daemon treats it as a
  requested stop and suppresses the policy, so `restart: always` correctly does
  nothing. On 2026-09-06 that first attempt read as a failure and was not one —
  the service was right and the instrument was wrong. To test supervision, kill
  the process **inside** the container and let the daemon observe an exit it did
  not ask for; `RestartCount` incrementing is the evidence.

  Same class as every other instrument in this file that looked at the wrong
  property: a green that means the check could not see, and a red that means the
  check asked the wrong question. Before believing either, confirm the
  instrument observes the property claimed.

- **A gate must never enqueue onto the real queue.** `verify-lazy-provisioning`
  asserts that a connect request *queues a build*, and did so by putting a real
  job on the real `gateway-provisioning` queue and deleting it during cleanup.
  That was survivable only while nothing consumed the queue. The moment the
  worker became a supervised service it won the race, and one gate run **built
  two actual tenant gateways** — containers, volumes, published ports — for its
  own fixture organizations, then failed its cleanup because the jobs were
  locked by a worker.

  "Run it with the worker stopped" is a workaround, and it is recorded as the
  contract in `docs/DEPLOYMENT.md` only until this is fixed properly. A test
  uses an isolated queue name or prefix. **A test that can change production
  infrastructure is not a test** — it is production, running unattended, with
  assertions attached.

  **And it must clean up what it enqueues.** The same rule ran the other way
  round on 2026-09-06: the tenancy harness deletes its fixture organizations
  and leaves their scheduled jobs behind in Redis, where they fail for ever
  against an organization that no longer exists. Fourteen delayed jobs and
  twenty-six failures for one deleted `bleed_org_a`, **accumulating two more
  on every run** — the harness was run seven times that day and left seven
  pairs. The failures are `TENANT_ISOLATION_VIOLATION`, so the guard is
  working; what is broken is that the debris outlives its own test.

  Deleting a fixture row is not cleanup while a queue still holds work for
  it. Enqueue and delete are one transaction in the test's mind and two in
  the system, and the second one is the one everybody forgets.

---

## Scope

- **Stage files by name. Never a directory.** `git add <dir>` sweeping an
  unrelated migration into a commit is the single most repeated defect here.

- **Patch by line number when indentation varies.** Editing by substring
  replaces a 10-space pattern that is a substring of an 18-space one and
  produces duplicate properties. This has happened twice, the second time after
  being written down as a lesson.

- **Read a file's full diff before staging it.** A file can carry more than one
  author's work.

- **Do not regress toward parity.** Where this product is deliberately ahead of
  the thing it is measured against, that is a decision, not an accident.
  Consent above all.

- **When the component named for a decision does not make it, the decision is
  being made somewhere that cannot be audited.** Look for the code that owns a
  rule before assuming the rule lives there; if it does not, the real decision
  is somewhere nobody will think to check.

  `access-gate.middleware.ts` exists to answer "is this subscriber entitled to
  be here". It checked neither `PENDING` nor `MANUAL_REVIEW`. The actual login
  decision was a ternary inside an email-verification side effect, reading a
  *subscription* status to decide an *organization* status — so a billing state
  gated authentication, from a function whose name says it verifies an email.

  This is the same shape as the dunning lockout that wrote `SUSPENDED` while
  nothing enforced it, which is the defect `access-gate.middleware.ts` was
  written to fix. That one was a status with no reader; this one is a reader
  with no status. Both leave the named component looking authoritative and
  inert, and both are invisible to every gate, because the code is correct — it
  is merely somewhere nobody would audit.

  The test is cheap: name the file you would change to alter the behaviour, then
  check whether that file mentions it at all.

- **A fabricated success state is usually fabricated at every boundary.** When
  one layer is found inventing a reassuring answer, check the layers above and
  below it for the same invention before believing the fix is done.

  The pairing endpoint swallowed six gateway failures and returned
  `{pending: true}` for all of them. One layer up, the screen's poll had
  `catch { setQr({ connected: false, pending: true }) }` -- so a failed request
  became "pending" a second time, independently, in different code. Fixing only
  the endpoint would have changed nothing the customer sees: the screen would
  have carried on spinning whenever the request itself failed.

  This happens because each boundary faces the same question -- "what do I show
  when I do not know?" -- and the comfortable answer is the same at every one.
  The honest default is the opposite: not knowing is a state worth reporting,
  and it is never the same state as working on it.

  So the check is not "did I fix the bug" but "how many places implement this
  lie". Read the caller and the callee, not just the file the defect was
  reported in.

- **Never pipe a gate.** `npm run test:e2e | tail -10` reports **tail's** exit
  status, not the gate's. Redirect to a file and read the file:

      npm run test:e2e > run.log 2>&1; echo "EXIT=$?"; tail -6 run.log

  This swallowed a real Playwright failure -- the suite never started, because
  an orphaned `next start` still held port 8081 -- and the pipeline reported
  `exited with code 0`. The rule against *appending* to a gate was already
  written and did not cover it, because nothing was appended: the pipe alone
  was enough. A general rule that does not name its mechanism is a rule you
  will walk past, so the mechanism is named here.

- **When a change does not appear, suspect the server before the code.**
  Establish which artifact is being served and prove it carries your edit
  before concluding anything about the edit. `docker compose ps` for a
  container, the process start time against the file mtime for a dev server,
  the build manifest for a production build.

  Three instances in one day, and the third is the one that matters because it
  is not a container:

  - `:18080` served a frontend image built before the vocabulary rename, for a
    day, while every gate agreed the code had changed.
  - `rabitech-backend-1` answered `{"error":"Not found"}` for three endpoints
    that were written, typechecked and on disk.
  - a `ts-node-dev` process **older than the file it was serving** kept
    answering with pre-edit code after logging `Restarting`. The edit was
    right, `tsc` was clean, and the response was from a different build.

  So the rule names dev servers as well as containers. The check is two
  commands: the process start time, and the mtime of the file you changed. If
  the process is older, nothing you conclude from its output is about your
  code. It caught a nine-hour-old dev server on the very next run.

- **Never hand-mint a session token to reach real data.** A JWT signed
  directly with `JWT_SECRET` can be made to authenticate, and it is the wrong
  way to see the product for two reasons.

  It is a shape no login produces. `auth.middleware.ts` tolerates a token with
  no `sessionId`, so a hand-made one passes — down a branch kept for legacy
  tokens. Anything verified through it was verified on a path no user takes,
  which makes the verification worth less than it looks.

  And `JWT_SECRET` sits in `.env` beside credentials that are in public git
  history and still unrotated. Reaching for it normalises handling the one
  file that must never be treated casually.

  When real data is needed, seed a user through the real signup path and log
  in as that user.

- **A new title that contains an existing title breaks locators elsewhere.**
  Playwright matches accessible names by substring, so adding a heading called
  "Contacts with open conversations" to a screen that already had "Contacts"
  made `getByRole('heading', { name: 'Contacts' })` resolve to two elements.
  The pre-existing test then failed on strict mode rather than on absence,
  which reads as "the card is gone" and is not.

  Two halves to this. Pin the locator with `exact: true` where a name is a
  prefix of another. And check for the collision when choosing the title,
  because the failure lands in a test nobody was editing, on a screen the new
  work did not touch, and the error names ambiguity rather than the cause.

- **Order in a list is not a meaning.** The dashboard funnel headline took the
  last element of the lifecycle stage array as the funnel's end and reported
  "0% reached Unqualified" against real data. The stages run Contacted,
  Qualified, Lead, Customer, Unqualified — the terminal stage is not the final
  element, and nothing about the array says which one it is. The model already
  carried an `isWon` flag, and the frontend type already exposed it.

  A positional assumption about domain data is invisible to `tsc`, survives
  every gate, and renders a confident wrong number. Where the domain has a
  flag, read the flag; where it does not, the assertion has to name the member
  it depends on, so reordering the list fails loudly instead of quietly
  changing the answer.

- **Before adding a widget, ask whether a card already answers its question.**
  A Team Members widget was built onto a dashboard that already had a Team
  Members card. Both rendered, correctly, with the same title, on one screen.
  Neither `tsc` nor any gate has an opinion about a screen saying the same
  thing twice — only opening the page does.

  The old card counted active users; the new one answers that and four more
  questions, so the old one was deleted rather than kept beside it. Deleting it
  also orphaned its request, which is the second half of the same check: a
  panel that is gone should not still be fetching.

- **Both compose app containers are built images and neither reflects the
  working tree.** `rabitech-frontend-1` and `rabitech-backend-1` each serve a
  Docker image baked at build time. Neither reads `apps/`, neither rebuilds
  when you edit, and each keeps serving whatever source it was built from
  until its image is rebuilt. Nothing warns you: the app loads, it looks like
  the product, and it is simply old.

  | Port | Serves | From |
  |---|---|---|
  | `:8080` | `next dev` | **the working tree**, compiled per request |
  | `:18080` | compose `frontend` | a built image, stale until rebuilt |
  | `:4000` (container stopped) | `npm run dev` in `apps/backend` | **the working tree** |
  | `:4000` (container running) | compose `backend` | a built image, stale until rebuilt |

  Note that the backend has no second port: `:4000` serves from source or from
  an image depending only on which one is running, so the URL cannot tell you
  which you are talking to. `docker compose ps` can.

  This cost a day on the frontend, and then repeated on the backend inside the
  same session, which is the reason this rule now names both. The frontend
  image predated the vocabulary rename, so its settings rail still read
  "Workspace information" while the working tree, every gate and a green e2e
  suite all said "Organization information". Every one of those was right.
  The browser was pointed at a different build. The backend image then did
  the same thing to three freshly written dashboard endpoints, which returned
  `{"error":"Not found"}` while `tsc` was clean and the routes were on disk.

  **Local development uses the dev servers**, which compile from the working
  tree:

      docker compose stop frontend        # then, from apps/frontend:
      npm run dev                         # http://localhost:8080

      docker compose stop backend         # then, from apps/backend:
      npm run dev                         # http://localhost:4000

  Leave `postgres`, `redis` and `openwa` running. The frontend dev server
  reaches the backend on `:4000` through the rewrites in `next.config.js`,
  whichever backend is answering there. `localhost:3000` is nothing in this
  repo; the frontend dev server is on 8080.

  The same confusion in a different costume is `test:e2e`, which serves a
  production build through `next start`. That one is now enforced by
  `check-build-freshness.js`. This one is not enforceable — a container has
  every right to serve an old image — so it is written down instead.

---

## Precedence

When two rules conflict, the later section wins: scope over evidence, evidence
over design. A change you cannot prove is a change you should not make, and a
change you cannot scope is a change you should not stage.
