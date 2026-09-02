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

- **A check is trusted only after it has been made to fail.** Break the thing
  the check exists to catch, watch the gate name it, restore, and verify the
  restored file is byte-identical. A green gate that has never gone red is an
  untested assertion.

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

- **Every migration ships a guarded `down.sql`** that refuses when live data
  depends on it, and a verified backup taken beforehand (`pg_dump -Fc`,
  confirmed with `pg_restore -l`) before it is applied.

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
