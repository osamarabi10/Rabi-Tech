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

---

## Precedence

When two rules conflict, the later section wins: scope over evidence, evidence
over design. A change you cannot prove is a change you should not make, and a
change you cannot scope is a change you should not stage.
