# Where the parity matrix came from

Provenance for [RESPONDIO-PARITY-MATRIX.md](RESPONDIO-PARITY-MATRIX.md) and the
documents derived from it.

**Why this file exists.** The matrix cited its source as `respond-io-as-documented.md`
and that file has never been in this repository. So every claim in a
515-line comparison rested on a filename a clean clone could not open — the same
shape of problem as a gate whose evidence lives only on one machine. This file
records the method and the surfaces so the sourcing is checkable without
publishing the analysis.

**Why the survey itself is not committed.** It is a detailed teardown of a named
competitor's product, and this repository is public. Publishing it and
publishing a comparison drawn from it are different acts. What the matrix needs
is *checkable* sourcing — the method, the surfaces, the date — which this
provides.

---

## Method

| | |
|---|---|
| Read on | **1 September 2026** — a single pass, not a running log |
| Volume | **~130** first-party pages |
| Approach | Read the vendor's own documentation, then check each claim against this codebase **at the enforcement point** — the line that actually refuses, not the screen that describes the refusal |
| Verdicts | `✓` match · `≈` partial · `✗` absent · `★` we are ahead · `—` deliberately not building |

The enforcement-point rule is the part worth preserving. A capability was only
marked `✓` if something in this codebase refuses when it should — not because a
setting exists, a column is present, or a screen renders. Several `★` entries
exist specifically because a gate asserts the behaviour, and several `≈` entries
exist because a screen exists and nothing enforces behind it.

## The four first-party surfaces

Everything in the matrix comes from material the vendor publishes about itself.
No third-party reviews, no reverse engineering, no scraping of a logged-in
session.

1. **The help centre** — the written-for-humans product documentation, the bulk
   of the ~130 pages. Cited directly in §10 (*"their workspace settings index
   lists 18 articles"*) and §12.
2. **The developer hub** — the API reference. Where the two disagree the matrix
   prefers the developer hub and says so: §12 takes **11** webhook events from
   it over the help centre's 10, on the reasoning that a written-for-humans
   subset omitting one is likelier than a reference inventing one.
3. **The OpenAPI 3.0 specification** — used for endpoint shapes, error codes and
   rate-limit headers. It is what produced the rate-limit contradiction recorded
   in §12: their prose says organization-level, the section below says per method
   and path, and every OpenAPI 429 example shows a third number.
4. **Marketing and product pages** — pricing and the WhatsApp messaging-limits
   page. Used sparingly and treated as the weakest of the four, which is why the
   tier-ceiling conflict in HANDOVER §6 resolves to *"Meta's own documentation
   settles this; ours does not."*

## What this file does not contain, and that is deliberate

**Per-claim citation URLs were not preserved.** The survey recorded findings, not
a link per row, and reconstructing a URL for each of ~200 matrix cells from
memory would produce citations that look authoritative and are not verifiable.
Naming the gap is more useful than filling it badly.

What that means in practice: the matrix is checkable at the level of *surface and
date* — you can go to the vendor's help centre, developer hub or OpenAPI spec and
find the claim — but not at the level of *this row came from this page*. Anything
load-bearing should be re-read at the source before it is relied on.

## What the survey establishes, and what it cannot

It establishes what the vendor **documents** as of 1 September 2026. That is not
the same as what their product does. The matrix is careful about the difference
and marks it where it appears:

- **`NOT DETERMINED in their docs`** — used where the vendor's documentation is
  silent. §04 on which side's values survive a merge; §09 on the timezone of a
  scheduled send; §10's widget catalogue, which is never enumerated.
- **Internal contradictions** — recorded as contradictions rather than resolved
  by picking. §12's rate limit gives three answers across their own material,
  and the matrix takes **no parity claim** there rather than assert we matched a
  number that may not be theirs.
- **Their own stated gaps** — quoted, not paraphrased, so it stays clear they
  are the vendor's words: *"No audit log is documented anywhere."*

**Documentation ages.** Everything here is a snapshot of one day. A `✗` may have
shipped since; a `✓` may have changed shape. Re-read before making a decision
that depends on a specific number, and treat the date at the top of this file as
the expiry stamp it is.
