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

- **`:18080` is a built image and never reflects the working tree.** The
  compose `frontend` service serves a Docker image baked at build time. It
  does not read `apps/frontend`, it does not rebuild when you edit, and it
  keeps serving whatever source it was built from until the image is rebuilt.
  Nothing warns you: the app loads, it looks like the product, and it is
  simply old.

  This cost a day of believing no change was taking effect. The image
  predated the vocabulary rename, so its settings rail still read "Workspace
  information" while the working tree, every gate and a green e2e suite all
  said "Organization information". Every one of those was right. The browser
  was pointed at a different build.

  **Local development uses the dev server**, which compiles from the working
  tree on every request:

      docker compose stop frontend        # free the port, keep the rest up
      cd apps/frontend && npm run dev     # http://localhost:8080

  Leave `postgres`, `redis`, `backend` and `openwa` running — the dev server
  reaches the backend on `:4000` through the rewrites in `next.config.js`.
  `localhost:3000` is nothing in this repo; the dev server is on 8080.

  The same confusion in a different costume is `test:e2e`, which serves a
  production build through `next start`. That one is now enforced by
  `check-build-freshness.js`. This one is not enforceable — a container has
  every right to serve an old image — so it is written down instead.

---

## Precedence

When two rules conflict, the later section wins: scope over evidence, evidence
over design. A change you cannot prove is a change you should not make, and a
change you cannot scope is a change you should not stage.
