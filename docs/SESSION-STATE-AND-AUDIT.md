# RabiTech — state, audit, risks and what remains

Written 2026-09-02, at the end of a single long working session.
**45 commits, 144 files, +16,675 lines**, all on `main` and pushed.

This is the honest record: what was built, what was found broken, what I got
wrong, what is genuinely at risk, and what is left. It is deliberately not a
summary of good news — the useful half is the defects and the pattern behind
them.

Read [RESPONDIO-PARITY-MATRIX.md](RESPONDIO-PARITY-MATRIX.md) for the
capability-by-capability inventory and [PUBLIC-API.md](PUBLIC-API.md) for the
API contract. This document is the state *of the work*, not of the product.

---

## 1 · What was built

### P1 — the public API and webhooks

The largest structural gap in the product, and it did not exist at all before
this session.

| | |
|---|---|
| `/api/v1` | **24 operations**, matching Respond.io's count |
| Auth | Bearer tokens: **scoped, expiring, revocable**, SHA-256 stored |
| Rate limit | 5/s per method+path, 600/min per credential |
| Errors | Including `449` for a workspace still provisioning |
| Webhooks | **11 events**, HMAC-SHA256, retries 30/60/90s, auto-off at 30 failures/30 min |
| Delivery log | Status, latency, attempt, response body, test button |
| Console | API keys and Webhooks screens, one-time secret reveal |

**Three places we deliberately beat them**, because copying would have been a
downgrade:

1. **Token scoping.** Their own docs record the gap: *"No expiry, rotation,
   revocation procedure or scoping mechanism is documented anywhere… the token
   is workspace-wide."*
2. **Signing covers the timestamp.** They sign the body alone, so any captured
   request replays forever and every replay verifies. We sign
   `<timestamp>.<body>`.
3. **A delivery log.** Theirs has none; it is an open feature request against
   them. Without one, *"did you send it?"* is unanswerable by both parties.

### P2 — workflow triggers and steps

| | Before | After |
|---|---|---|
| Triggers | 5 | **9** |
| Steps | 13 | **15** (+2 declared and refused) |
| Step ceiling | 20 | **100** |
| Run deadline | none | **7 days** |

New: `LIFECYCLE_UPDATED`, `CONTACT_FIELD_UPDATED`, `INCOMING_WEBHOOK`,
`SHORTCUT`, `OPEN_CONVERSATION`, `ADD_COMMENT`.

`JUMP_TO` and `TRIGGER_WORKFLOW` are **declared, refused at save, and withheld
from the builder**. Both turn a list into a graph, and a jump target is a
position — a flat builder has no stable positions, so reordering one step
silently repoints every jump past it. They wait for the canvas.

### Inbox

- **Collaborators** — up to 9, own inbox, thread panel. Their removal rule
  copied whole: *any collaborator or the assignee can remove anyone.*
- **Blocked inbox** — blocking refused new threads and left existing ones
  looking ordinary, so an operator could not find what they had blocked
  somebody from.
- **Unreplied toggle** — a filter, not a sixth tab, so it composes with status.
- **Shortcuts** — a workflow as a button in the thread action bar.

### Settings

13 screens → **15**, regrouped to mirror their information architecture, with
API keys and Webhooks moved under Integrations because that is where their users
look. New: **Integrations** hub, **Files**. All 14 screens now share one header
primitive.

### Security fixes

- **CSV injection** in both exports (see §3)
- **Token masking inheritance** — a masked admin could mint a token and read
  what they are not allowed to see
- **Seven of seven** per-user restrictions, up from six

### Migrations

Ten, each with a guarded `down.sql` that refuses when live data depends on it:

```
contact_blocking · invoice_ref_scoped_to_org · workflow_ask_question
campaign_quiet_hours · granular_user_restrictions · api_tokens
api_token_masking · webhook_endpoints · conversation_collaborators
restrict_integrations
```

---

## 2 · Gates

Sixteen registered. The ones added or extended this session:

| Gate | Count | Hermetic |
|---|---|---|
| `test:public-api` | **141** | no — boots the server, deliberately |
| `test:workflow-p2` | **71** | yes |
| `test:webhooks` | **52** | yes |
| `test:restrictions` | **51** | yes |
| `test:csv` | **30** | yes |
| `test:api-tokens` | **90** | no — its subject is stored rows |
| `test:tenancy` | **128** | no |

**Mutation-proved**, not merely green. Each of these was made to fail on purpose
before being trusted:

- removing `runAsPlatform` from token resolution
- leaking `organizationId` from the serializer
- unscoping the contact id lookup
- including internal notes in the default transcript
- removing the rate limiter's path collapse
- signing the webhook body without the timestamp
- making `ADD_COMMENT` customer-facing
- disabling the CSV formula guard

---

## 3 · Defects found

Ordered by consequence. **Three were mine, made this session.**

### CSV injection — reachable by a stranger, pre-existing

A cell starting `=` `+` `-` `@` tab CR `;` `` ` `` `|` is a **formula** to Excel,
LibreOffice and Sheets. Quoting does not defend it — `"=cmd|..."` is still a
formula once CSV quoting is stripped.

What made it live rather than theoretical: **a contact's name is their WhatsApp
display name**, which the contact sets. Anyone who can message a subscriber could
put `=cmd|'/c calc'!A1` there, wait for a contact export, and have it execute on
an admin's machine. No account needed, nothing compromised first. The finance
export was the same shape with a worse target — workspace names, opened by the
platform owner.

Both exports had written **their own escaper** and neither guarded formulas. The
duplication was the actual defect, so the gate now refuses any module that builds
a quoted cell by hand.

### Collaborators could not see their own thread — mine, same session

A restricted agent added as a collaborator got **404 on the conversation they had
just been added to**. Silently broken for exactly the users it matters most for:
the specialist brought in to help, who is restricted *because* they do not
normally work those threads.

### Four restrictions no admin could apply — pre-existing

`restrictDataExport`, `restrictContactDeletion`, `restrictWorkspaceSettings`
were enforced by the backend since M8.1 with **no control anywhere in the
console**. The enforcement was real; the feature was not.

### `TAG_REMOVED` never fired — pre-existing

A declared trigger dispatched by nothing. The executor emitted it when *a
workflow* removed a tag, so it looked correct in testing and never fired for the
case anyone builds it for: an agent removing a tag by hand.

### `SHORTCUT` had no button — mine, two commits after shipping it

The entire point of that trigger is *"a workflow becomes a button an agent
presses"*. There was no button. Caught by auditing every new endpoint against
whether the console can reach it.

### `tags:read` gated nothing — mine, same session

A scope a subscriber could grant that no endpoint required, in the API I had
just called complete.

### The canvas steps would have appeared in the builder — mine

The workflow vocabulary is *served*, so declaring `JUMP_TO` for the validator's
benefit put it straight into the UI as an option that fails on save.

### Runs never expired — pre-existing

A workflow paused on an unanswered question stayed `RUNNING` forever. Costing
nothing, which is why nobody noticed, but appearing in every report as
in-progress indefinitely.

---

## 4 · Why the same defect keeps happening

**Eight instances now** of one shape: *something declared, and nothing enforcing
or reaching it.* `autoProvisionGateway`, `allowedChannels`, the `Keyword` model,
M8.1 twice, `TAG_REMOVED`, `tags:read`, `SHORTCUT`, and four restriction
checkboxes that never existed.

It is worth being precise about the cause, because "be more careful" has not
worked.

**The declaration is the cheap half and the satisfying half.** Adding
`'SHORTCUT'` to an array is one line, it compiles, it appears in the UI
immediately, and every test still passes. The wiring — the dispatch site, the
route, the button — is five files away and nothing complains about its absence.
The type system cannot help: a string in a union is valid whether or not
anything reads it.

**And the failure is invisible in the only direction that matters.** A trigger
that never fires looks exactly like a trigger whose conditions were not met. A
scope that gates nothing looks exactly like a scope that was granted. There is no
error, no log line, no red gate — the feature simply is not there, and the person
who ticked the box believes it is.

**What actually changed the outcome** was not care, it was *asserting
reachability rather than correctness*. The gates now check:

- every declared workflow trigger has a `dispatchWorkflowEvent` call site
- every action has an executor branch **or is provably refused at save**
- every refused action is absent from the served vocabulary
- every declared API scope is required by some endpoint
- every new endpoint has a frontend reference

Four of the eight instances were found by those checks rather than by review, and
two were found within minutes of my creating them. That is the difference
between a rule and a test.

### The second pattern: the instrument could not see the property

**Seven instances now, in four sub-shapes.** In every one the cause is the same:
**the thing doing the checking was structurally incapable of seeing the thing it
was checking.** Not a wrong assertion — a right assertion aimed somewhere the
property does not exist.

The four sub-shapes are worth separating, because they need different habits:

- **(a) The check pointed at the wrong artifact** — instances 1, 2, 3, 4. The
  assertion is fine; the thing it reads cannot contain the answer.
- **(b) The probe never reached its target** — instance 5. The assertion is
  fine and so is the artifact; the *mutation meant to test it* landed somewhere
  else, so the green proved nothing and looked like proof.
- **(c) The right file, the wrong extent** — instance 6. The artifact is
  correct and the boundaries are not, so the check reads code belonging to
  something else and reports on that instead.
- **(d) Coverage contingent on code structure** — instance 7, and the one that
  does not belong with the others. The check is correct **and** aimed correctly.
  Nothing about it is wrong at any point. Its *reach* simply depends on how the
  code happens to be written, so ordinary refactoring shrinks it — silently,
  without ever failing, over months.

**One correction to how this category was first written.** It was described as
"a check that passed while proving nothing", and that is the *dangerous*
symptom, not the defining one. Instance 6 produced a false **red**: it accused
`/api/network` of touching tenant data that belonged to a different handler
entirely. The defect is the misaiming; whether it surfaces as a false green or a
false red is luck. False greens are worse only because nobody investigates them.

1. **A source assertion reading `dist/` for a cast.** `verify-workflow-p2` was
   written to refuse `as never`, the token that silenced D-31. It read the
   compiled output, as every behavioural check in that file correctly does. But
   TypeScript **erases casts at compile time**, so `as never` cannot appear in
   `dist` at all. The check would have passed forever, on any code, including
   code that reintroduced the defect.

2. **A cap check matching a string inside the guard's own declaration.**
   `verify-meta-template-send` looked for `RECIPIENT_CAP_REACHED` to prove the
   per-24h cap was enforced. That string lives in the guard's `throw`. Deleting
   the *call site* left the guard declared, unreachable, and the gate green at
   40/40 with the cap fully bypassed. This is the reachability pattern above,
   written into the gate built to catch it.

3. **A line-ending bug invisible to `git diff`.** Two gate regexes matched a
   bare `\n` against file contents, so they passed on an LF working tree and
   failed on a CRLF fresh clone of the same commit. The files were
   byte-identical once normalised — and `git diff` normalises line endings, so
   **the ordinary tool for "what changed?" reports nothing.** No amount of
   looking at diffs would have found it.

4. **A gate whose denylist source was renamed, checking nothing.**
   `verify-secret-scan` parses `KNOWN_WEAK` out of `verify-secrets.ts` rather
   than copying it, so the two lists cannot drift. But an unguarded parse
   returns `[]` when the Set is renamed or restructured — and a scan against an
   empty denylist finds nothing, reports green, and is indistinguishable from a
   repository with no weak credentials in it. Caught before it shipped, by
   asking what the file would do if its one external dependency moved. It now
   asserts the parse matched, that it yielded a plausible count, and that it
   still contains its anchors; renaming the Set turns four checks red.

5. **A mutation that missed its target — and so proved nothing.** While proving
   `verify-auth-exemptions`, the mutation meant to break the fallback branch
   used a plain `String.replace` for `verifyToken(req, res, () => {`. That
   replaces the **first** occurrence, and there is an earlier one in a different
   middleware **294 lines above** the fallback. The mutation edited a route that
   the gate does not examine; the gate reported 11/11, entirely correctly,
   because nothing it looks at had changed.

   Read carelessly that says *the check is broken*. The truth was the opposite:
   the check was fine and **the probe was broken**. Retargeted with
   `lastIndexOf`, it goes red as it should. This is the only instance in the
   list where the defect was in the act of verification rather than in the
   thing verified — which is why it gets its own rule below.

6. **A check reading the right file over the wrong extent.** The category-4
   assertion in `verify-auth-exemptions` must prove that an *authenticated, no
   tenant data* route touches no database. It read a fixed **forty lines** from
   the annotation — which ran off the end of `/api/network`, into the next
   handler, and found `runAsOrganization` there. It then reported
   `/api/network` as touching tenant data, which is code it does not contain.

   The file was right. The assertion was right. Only the boundaries were wrong,
   and a boundary is exactly the sort of thing a reviewer's eye slides over: a
   fixed window looks like a reasonable heuristic until the thing being measured
   is shorter or longer than the guess. It is now bounded by the handler's
   actual extent — from the registration to the next top-level registration.

   Two smaller faults in the same commit had the same flavour and are worth a
   line each: the rate-limiter exclusion did not account for the comma between a
   route's path and its arguments, so every limiter mount was reported as an
   unannotated route; and the orphan-annotation count matched `@auth-exempt`
   anywhere above the middleware, including **the header comment that documents
   the annotation vocabulary**, so it found nine annotations for eight routes. A
   check that reads its own documentation as data is the same defect in
   miniature.

7. **A check whose coverage shrinks under refactoring, without ever failing.**
   `check:i18n` matches literal `t()` arguments. That is the right thing to
   match and it is aimed at the right files. But move a literal into a constant
   and pass the constant — `t(item.label)` — and the string leaves the checker's
   view entirely. Nothing fails. The gate keeps printing green over a smaller
   set, and the number it is green over is not reported anywhere.

   Thirty-seven strings shipped untranslated across two commits this way. The
   earlier explanation was that a prompt's gate list omitted the frontend
   checks, which was true and is not the cause — **running `check:i18n` on those
   commits would not have found them either.** A probe found 98 dynamic call
   sites across 41 files, all invisible.

   **The refactor that reduces coverage is usually the good refactor, which is
   why nobody looks.** The largest single contributor was extracting `RailGroup`
   so a rail could be shared instead of copied — correct design, and it moved
   thirteen labels out of the checker's sight, two of which were untranslated in
   English and Hebrew for a week without a gate noticing. Nobody re-examines
   coverage after a change that improves the code.

   This is why it is its own sub-shape. Every other instance here is a check
   that was wrong somewhere. This one is right everywhere and still loses ground
   — so "is the check correct?" is the wrong question to ask of it, and the
   right one is "what does it still see, and is that number moving?"

   **The fix is to make the invisible visible rather than to widen the check.**
   Non-literal calls are now counted and must each be accounted for: a seeded
   backlog for the untriaged, an exemption with a reason for the examined, both
   counted separately in the summary line so the number moves in public. A
   backlog going down is progress; a pile of exemptions is a graveyard that
   reads as a decision.

**How each was actually caught, since none was caught by reading:** (1) and (2)
by mutation — making the check fail on purpose, which is the only thing that
distinguishes a check that works from a check that is merely green. (3) by
cloning `origin/main` into a temp directory and running the gate there, which is
the only vantage point from which a working-tree-only defect is visible. (4) by
asking what the gate would do if the file it parses moved out from under it.
(5) by noticing a green where red was expected, and chasing it. (6) by running
the check the moment it was written, before believing it — it accused a route of
something the route plainly does not do, and the accusation was specific enough
to be checked in seconds. (7) by asking, after two commits of missing
translations, why running the checker on them would not have helped — the
explanation everyone had was true and insufficient.

**The rule.** Before trusting a check, ask what the thing doing the checking is
structurally incapable of seeing.

**The third rule, which instance 6 adds.** *Bound what a check reads by the
thing it is checking, never by a guess at its size.* A fixed window — forty
lines, a hundred characters, the rest of the file — is a boundary chosen without
reference to the subject, and it is right only until the subject changes length.
Where the artifact has real edges, find them: the next declaration, the matching
brace, the end of the block. Where it does not, that absence is itself the
finding, and a check that cannot say where its subject ends cannot say what is
in it.

**The second rule, which instance 5 adds and which is not the same thing.**
*Verify that the mutation actually landed before trusting what the gate says
about it.* The existing rule says a green check means nothing until you have
watched it go red. This one says the watching itself can fail: a mutation that
does not touch what it claims to touch produces a green that looks exactly like
a passing test and is worth nothing. **A green where you expected red is a
finding to chase, not a result to accept** — the cheapest version is to confirm
the edited line is the line you meant, before drawing any conclusion from what
the gate reports.

The corollaries are cheap and worth stating: a check on a *source* property
(a cast, a comment, an import) must read source; a check on a *runtime*
property (a call, an order) must read compiled output; a check on anything the
build or the VCS normalises — line endings, whitespace, erased types — cannot
be trusted from inside the environment that normalises it.

### What the Workspaces stretch added — 2026-09-03

Four more, and none of them is "be more careful". Each names a specific thing
that can be checked before it costs anything.

**The thing that ESTABLISHES ambient scope can never be a consumer of it.**

The workspace resolver asked the Prisma client for "the default workspace",
relying on the tenancy extension to add the organization predicate — from
*inside* that extension, where the client handed to you is the unextended one.
The query ran platform-wide and resolved to another tenant's workspace. Eight
existing checks caught it, none of them about workspaces.

The general shape: anything that runs *before* or *during* the establishment of
an ambient value must name that value explicitly, because the mechanism that
would supply it is the thing being set up. Bootstrap code cannot use the thing
it bootstraps. See D-38.

**A per-line guard cannot see what a paragraph is about.**

A mechanical rename of comments saying "workspace" where they meant
"organization" was guarded by a regex that skipped any line naming the new
sub-unit. It corrupted seven files anyway, because a line reading *"the
workspace this contact belongs to"* carries no token that marks which concept it
means — the paragraph does, and the guard could only see the line.

The rule: a filter that operates per line cannot make a decision that depends on
context wider than a line. Either widen the unit to the block, or accept that
the pass is a draft and review the diff. Reverting seven whole files was
cheaper than either, and only possible because the change was scripted rather
than typed.

**Suspect your input before you suspect the tool.**

A migration failed on a dollar-quoted `DO $` block, and the conclusion reached
first was *"Prisma's statement splitter cannot parse this"*. It parses it fine.
The SQL was malformed: a shell expansion had eaten one dollar of each pair, and
the file contained `DO # RabiTech — state, audit, risks and what remains

Written 2026-09-02, at the end of a single long working session.
**45 commits, 144 files, +16,675 lines**, all on `main` and pushed.

This is the honest record: what was built, what was found broken, what I got
wrong, what is genuinely at risk, and what is left. It is deliberately not a
summary of good news — the useful half is the defects and the pattern behind
them.

Read [RESPONDIO-PARITY-MATRIX.md](RESPONDIO-PARITY-MATRIX.md) for the
capability-by-capability inventory and [PUBLIC-API.md](PUBLIC-API.md) for the
API contract. This document is the state *of the work*, not of the product.

---

## 1 · What was built

### P1 — the public API and webhooks

The largest structural gap in the product, and it did not exist at all before
this session.

| | |
|---|---|
| `/api/v1` | **24 operations**, matching Respond.io's count |
| Auth | Bearer tokens: **scoped, expiring, revocable**, SHA-256 stored |
| Rate limit | 5/s per method+path, 600/min per credential |
| Errors | Including `449` for a workspace still provisioning |
| Webhooks | **11 events**, HMAC-SHA256, retries 30/60/90s, auto-off at 30 failures/30 min |
| Delivery log | Status, latency, attempt, response body, test button |
| Console | API keys and Webhooks screens, one-time secret reveal |

**Three places we deliberately beat them**, because copying would have been a
downgrade:

1. **Token scoping.** Their own docs record the gap: *"No expiry, rotation,
   revocation procedure or scoping mechanism is documented anywhere… the token
   is workspace-wide."*
2. **Signing covers the timestamp.** They sign the body alone, so any captured
   request replays forever and every replay verifies. We sign
   `<timestamp>.<body>`.
3. **A delivery log.** Theirs has none; it is an open feature request against
   them. Without one, *"did you send it?"* is unanswerable by both parties.

### P2 — workflow triggers and steps

| | Before | After |
|---|---|---|
| Triggers | 5 | **9** |
| Steps | 13 | **15** (+2 declared and refused) |
| Step ceiling | 20 | **100** |
| Run deadline | none | **7 days** |

New: `LIFECYCLE_UPDATED`, `CONTACT_FIELD_UPDATED`, `INCOMING_WEBHOOK`,
`SHORTCUT`, `OPEN_CONVERSATION`, `ADD_COMMENT`.

`JUMP_TO` and `TRIGGER_WORKFLOW` are **declared, refused at save, and withheld
from the builder**. Both turn a list into a graph, and a jump target is a
position — a flat builder has no stable positions, so reordering one step
silently repoints every jump past it. They wait for the canvas.

### Inbox

- **Collaborators** — up to 9, own inbox, thread panel. Their removal rule
  copied whole: *any collaborator or the assignee can remove anyone.*
- **Blocked inbox** — blocking refused new threads and left existing ones
  looking ordinary, so an operator could not find what they had blocked
  somebody from.
- **Unreplied toggle** — a filter, not a sixth tab, so it composes with status.
- **Shortcuts** — a workflow as a button in the thread action bar.

### Settings

13 screens → **15**, regrouped to mirror their information architecture, with
API keys and Webhooks moved under Integrations because that is where their users
look. New: **Integrations** hub, **Files**. All 14 screens now share one header
primitive.

### Security fixes

- **CSV injection** in both exports (see §3)
- **Token masking inheritance** — a masked admin could mint a token and read
  what they are not allowed to see
- **Seven of seven** per-user restrictions, up from six

### Migrations

Ten, each with a guarded `down.sql` that refuses when live data depends on it:

```
contact_blocking · invoice_ref_scoped_to_org · workflow_ask_question
campaign_quiet_hours · granular_user_restrictions · api_tokens
api_token_masking · webhook_endpoints · conversation_collaborators
restrict_integrations
```

---

## 2 · Gates

Sixteen registered. The ones added or extended this session:

| Gate | Count | Hermetic |
|---|---|---|
| `test:public-api` | **141** | no — boots the server, deliberately |
| `test:workflow-p2` | **71** | yes |
| `test:webhooks` | **52** | yes |
| `test:restrictions` | **51** | yes |
| `test:csv` | **30** | yes |
| `test:api-tokens` | **90** | no — its subject is stored rows |
| `test:tenancy` | **128** | no |

**Mutation-proved**, not merely green. Each of these was made to fail on purpose
before being trusted:

- removing `runAsPlatform` from token resolution
- leaking `organizationId` from the serializer
- unscoping the contact id lookup
- including internal notes in the default transcript
- removing the rate limiter's path collapse
- signing the webhook body without the timestamp
- making `ADD_COMMENT` customer-facing
- disabling the CSV formula guard

---

## 3 · Defects found

Ordered by consequence. **Three were mine, made this session.**

### CSV injection — reachable by a stranger, pre-existing

A cell starting `=` `+` `-` `@` tab CR `;` `` ` `` `|` is a **formula** to Excel,
LibreOffice and Sheets. Quoting does not defend it — `"=cmd|..."` is still a
formula once CSV quoting is stripped.

What made it live rather than theoretical: **a contact's name is their WhatsApp
display name**, which the contact sets. Anyone who can message a subscriber could
put `=cmd|'/c calc'!A1` there, wait for a contact export, and have it execute on
an admin's machine. No account needed, nothing compromised first. The finance
export was the same shape with a worse target — workspace names, opened by the
platform owner.

Both exports had written **their own escaper** and neither guarded formulas. The
duplication was the actual defect, so the gate now refuses any module that builds
a quoted cell by hand.

### Collaborators could not see their own thread — mine, same session

A restricted agent added as a collaborator got **404 on the conversation they had
just been added to**. Silently broken for exactly the users it matters most for:
the specialist brought in to help, who is restricted *because* they do not
normally work those threads.

### Four restrictions no admin could apply — pre-existing

`restrictDataExport`, `restrictContactDeletion`, `restrictWorkspaceSettings`
were enforced by the backend since M8.1 with **no control anywhere in the
console**. The enforcement was real; the feature was not.

### `TAG_REMOVED` never fired — pre-existing

A declared trigger dispatched by nothing. The executor emitted it when *a
workflow* removed a tag, so it looked correct in testing and never fired for the
case anyone builds it for: an agent removing a tag by hand.

### `SHORTCUT` had no button — mine, two commits after shipping it

The entire point of that trigger is *"a workflow becomes a button an agent
presses"*. There was no button. Caught by auditing every new endpoint against
whether the console can reach it.

### `tags:read` gated nothing — mine, same session

A scope a subscriber could grant that no endpoint required, in the API I had
just called complete.

### The canvas steps would have appeared in the builder — mine

The workflow vocabulary is *served*, so declaring `JUMP_TO` for the validator's
benefit put it straight into the UI as an option that fails on save.

### Runs never expired — pre-existing

A workflow paused on an unanswered question stayed `RUNNING` forever. Costing
nothing, which is why nobody noticed, but appearing in every report as
in-progress indefinitely.

---

## 4 · Why the same defect keeps happening

**Eight instances now** of one shape: *something declared, and nothing enforcing
or reaching it.* `autoProvisionGateway`, `allowedChannels`, the `Keyword` model,
M8.1 twice, `TAG_REMOVED`, `tags:read`, `SHORTCUT`, and four restriction
checkboxes that never existed.

It is worth being precise about the cause, because "be more careful" has not
worked.

**The declaration is the cheap half and the satisfying half.** Adding
`'SHORTCUT'` to an array is one line, it compiles, it appears in the UI
immediately, and every test still passes. The wiring — the dispatch site, the
route, the button — is five files away and nothing complains about its absence.
The type system cannot help: a string in a union is valid whether or not
anything reads it.

**And the failure is invisible in the only direction that matters.** A trigger
that never fires looks exactly like a trigger whose conditions were not met. A
scope that gates nothing looks exactly like a scope that was granted. There is no
error, no log line, no red gate — the feature simply is not there, and the person
who ticked the box believes it is.

**What actually changed the outcome** was not care, it was *asserting
reachability rather than correctness*. The gates now check:

- every declared workflow trigger has a `dispatchWorkflowEvent` call site
- every action has an executor branch **or is provably refused at save**
- every refused action is absent from the served vocabulary
- every declared API scope is required by some endpoint
- every new endpoint has a frontend reference

Four of the eight instances were found by those checks rather than by review, and
two were found within minutes of my creating them. That is the difference
between a rule and a test.

### The second pattern: the instrument could not see the property

**Seven instances now, in four sub-shapes.** In every one the cause is the same:
**the thing doing the checking was structurally incapable of seeing the thing it
was checking.** Not a wrong assertion — a right assertion aimed somewhere the
property does not exist.

The four sub-shapes are worth separating, because they need different habits:

- **(a) The check pointed at the wrong artifact** — instances 1, 2, 3, 4. The
  assertion is fine; the thing it reads cannot contain the answer.
- **(b) The probe never reached its target** — instance 5. The assertion is
  fine and so is the artifact; the *mutation meant to test it* landed somewhere
  else, so the green proved nothing and looked like proof.
- **(c) The right file, the wrong extent** — instance 6. The artifact is
  correct and the boundaries are not, so the check reads code belonging to
  something else and reports on that instead.
- **(d) Coverage contingent on code structure** — instance 7, and the one that
  does not belong with the others. The check is correct **and** aimed correctly.
  Nothing about it is wrong at any point. Its *reach* simply depends on how the
  code happens to be written, so ordinary refactoring shrinks it — silently,
  without ever failing, over months.

**One correction to how this category was first written.** It was described as
"a check that passed while proving nothing", and that is the *dangerous*
symptom, not the defining one. Instance 6 produced a false **red**: it accused
`/api/network` of touching tenant data that belonged to a different handler
entirely. The defect is the misaiming; whether it surfaces as a false green or a
false red is luck. False greens are worse only because nobody investigates them.

1. **A source assertion reading `dist/` for a cast.** `verify-workflow-p2` was
   written to refuse `as never`, the token that silenced D-31. It read the
   compiled output, as every behavioural check in that file correctly does. But
   TypeScript **erases casts at compile time**, so `as never` cannot appear in
   `dist` at all. The check would have passed forever, on any code, including
   code that reintroduced the defect.

2. **A cap check matching a string inside the guard's own declaration.**
   `verify-meta-template-send` looked for `RECIPIENT_CAP_REACHED` to prove the
   per-24h cap was enforced. That string lives in the guard's `throw`. Deleting
   the *call site* left the guard declared, unreachable, and the gate green at
   40/40 with the cap fully bypassed. This is the reachability pattern above,
   written into the gate built to catch it.

3. **A line-ending bug invisible to `git diff`.** Two gate regexes matched a
   bare `\n` against file contents, so they passed on an LF working tree and
   failed on a CRLF fresh clone of the same commit. The files were
   byte-identical once normalised — and `git diff` normalises line endings, so
   **the ordinary tool for "what changed?" reports nothing.** No amount of
   looking at diffs would have found it.

4. **A gate whose denylist source was renamed, checking nothing.**
   `verify-secret-scan` parses `KNOWN_WEAK` out of `verify-secrets.ts` rather
   than copying it, so the two lists cannot drift. But an unguarded parse
   returns `[]` when the Set is renamed or restructured — and a scan against an
   empty denylist finds nothing, reports green, and is indistinguishable from a
   repository with no weak credentials in it. Caught before it shipped, by
   asking what the file would do if its one external dependency moved. It now
   asserts the parse matched, that it yielded a plausible count, and that it
   still contains its anchors; renaming the Set turns four checks red.

5. **A mutation that missed its target — and so proved nothing.** While proving
   `verify-auth-exemptions`, the mutation meant to break the fallback branch
   used a plain `String.replace` for `verifyToken(req, res, () => {`. That
   replaces the **first** occurrence, and there is an earlier one in a different
   middleware **294 lines above** the fallback. The mutation edited a route that
   the gate does not examine; the gate reported 11/11, entirely correctly,
   because nothing it looks at had changed.

   Read carelessly that says *the check is broken*. The truth was the opposite:
   the check was fine and **the probe was broken**. Retargeted with
   `lastIndexOf`, it goes red as it should. This is the only instance in the
   list where the defect was in the act of verification rather than in the
   thing verified — which is why it gets its own rule below.

6. **A check reading the right file over the wrong extent.** The category-4
   assertion in `verify-auth-exemptions` must prove that an *authenticated, no
   tenant data* route touches no database. It read a fixed **forty lines** from
   the annotation — which ran off the end of `/api/network`, into the next
   handler, and found `runAsOrganization` there. It then reported
   `/api/network` as touching tenant data, which is code it does not contain.

   The file was right. The assertion was right. Only the boundaries were wrong,
   and a boundary is exactly the sort of thing a reviewer's eye slides over: a
   fixed window looks like a reasonable heuristic until the thing being measured
   is shorter or longer than the guess. It is now bounded by the handler's
   actual extent — from the registration to the next top-level registration.

   Two smaller faults in the same commit had the same flavour and are worth a
   line each: the rate-limiter exclusion did not account for the comma between a
   route's path and its arguments, so every limiter mount was reported as an
   unannotated route; and the orphan-annotation count matched `@auth-exempt`
   anywhere above the middleware, including **the header comment that documents
   the annotation vocabulary**, so it found nine annotations for eight routes. A
   check that reads its own documentation as data is the same defect in
   miniature.

7. **A check whose coverage shrinks under refactoring, without ever failing.**
   `check:i18n` matches literal `t()` arguments. That is the right thing to
   match and it is aimed at the right files. But move a literal into a constant
   and pass the constant — `t(item.label)` — and the string leaves the checker's
   view entirely. Nothing fails. The gate keeps printing green over a smaller
   set, and the number it is green over is not reported anywhere.

   Thirty-seven strings shipped untranslated across two commits this way. The
   earlier explanation was that a prompt's gate list omitted the frontend
   checks, which was true and is not the cause — **running `check:i18n` on those
   commits would not have found them either.** A probe found 98 dynamic call
   sites across 41 files, all invisible.

   **The refactor that reduces coverage is usually the good refactor, which is
   why nobody looks.** The largest single contributor was extracting `RailGroup`
   so a rail could be shared instead of copied — correct design, and it moved
   thirteen labels out of the checker's sight, two of which were untranslated in
   English and Hebrew for a week without a gate noticing. Nobody re-examines
   coverage after a change that improves the code.

   This is why it is its own sub-shape. Every other instance here is a check
   that was wrong somewhere. This one is right everywhere and still loses ground
   — so "is the check correct?" is the wrong question to ask of it, and the
   right one is "what does it still see, and is that number moving?"

   **The fix is to make the invisible visible rather than to widen the check.**
   Non-literal calls are now counted and must each be accounted for: a seeded
   backlog for the untriaged, an exemption with a reason for the examined, both
   counted separately in the summary line so the number moves in public. A
   backlog going down is progress; a pile of exemptions is a graveyard that
   reads as a decision.

**How each was actually caught, since none was caught by reading:** (1) and (2)
by mutation — making the check fail on purpose, which is the only thing that
distinguishes a check that works from a check that is merely green. (3) by
cloning `origin/main` into a temp directory and running the gate there, which is
the only vantage point from which a working-tree-only defect is visible. (4) by
asking what the gate would do if the file it parses moved out from under it.
(5) by noticing a green where red was expected, and chasing it. (6) by running
the check the moment it was written, before believing it — it accused a route of
something the route plainly does not do, and the accusation was specific enough
to be checked in seconds. (7) by asking, after two commits of missing
translations, why running the checker on them would not have helped — the
explanation everyone had was true and insufficient.

**The rule.** Before trusting a check, ask what the thing doing the checking is
structurally incapable of seeing.

**The third rule, which instance 6 adds.** *Bound what a check reads by the
thing it is checking, never by a guess at its size.* A fixed window — forty
lines, a hundred characters, the rest of the file — is a boundary chosen without
reference to the subject, and it is right only until the subject changes length.
Where the artifact has real edges, find them: the next declaration, the matching
brace, the end of the block. Where it does not, that absence is itself the
finding, and a check that cannot say where its subject ends cannot say what is
in it.

**The second rule, which instance 5 adds and which is not the same thing.**
*Verify that the mutation actually landed before trusting what the gate says
about it.* The existing rule says a green check means nothing until you have
watched it go red. This one says the watching itself can fail: a mutation that
does not touch what it claims to touch produces a green that looks exactly like
a passing test and is worth nothing. **A green where you expected red is a
finding to chase, not a result to accept** — the cheapest version is to confirm
the edited line is the line you meant, before drawing any conclusion from what
the gate reports.

.

"The tool cannot do this" is a far more expensive conclusion than "my input was
broken" — it sends the next person to a workaround for a limitation that does
not exist, and it gets written into a comment where it outlives the mistake.
The cheap check is to read the file that was actually written.

**Group by cause, not by symptom — a flake nested inside a failure invents a
cause that does not exist.**

Nineteen failures in `settings-responsive` were two causes. Grouping by test
name would have produced nineteen; grouping by error message produced three,
because one of the eighteen identical failures had a *different* error — a load
flake that fired before the real assertion was reached.

That third "cause" was a Hebrew-desktop layout bug that does not exist, and
someone would have gone looking for it. Run alone, that case fails exactly like
the other seventeen. **A symptom seen once among many identical failures is more
likely to be noise inside the failure than a separate fault** — re-run it in
isolation before believing it.

---

## 5 · Mistakes I made

Process failures, distinct from the defects above.

**I swept the owner's migration into `main`.** Staging `apps/backend/prisma` as a
*directory* pulled in `20260930090000_standard_trial_gateway` — uncommitted
trial-gateway work. Not cosmetic: the migration sets STANDARD's
`autoProvisionGateway` true while main's committed harness asserts false, so a
clean checkout of main would have gone **red on `test:tenancy`**. My own run
passed 128/128 because the owner's harness fix is in my working tree — a gate
reporting on my environment rather than on what was committed. Reverted in
`9a458795`.

**I made the substring-edit mistake twice.** Replacing a 10-space-indented
pattern that is a substring of an 18-space one, producing a duplicate object
property. This was already recorded as a lesson earlier in the session and I
repeated it. The fix both times was to patch **by line number**, which is what the
lesson should have meant the first time.

**I called P1 complete when it was ~85%.** Checking §13 line by line afterwards
found seven gaps — 15 of 24 operations, the wrong rate-limit shape, no `449`, the
wrong endpoint cap. The correction stands; the original claim does not.

**I estimated 4–5 months of remaining work.** That was human-team framing and
wrong for how this actually goes: the same night produced a complete public API,
a webhook system and a delivery log.

**I worked reactively for a stretch.** Half-finished P2, then collaborators, then
workspace — jumping between areas as each message arrived, leaving four files
uncompiling. The owner stopped me, correctly.

**One mutation test reported zero failures and I nearly believed it.** The
mutation had crashed the file, so the script produced *no output at all* — and
"no failures" and "no output" are identical through a grep. The second attempt
showed 16/30.

---

## 6 · Risks, ranked

### Owner-only, and urgent

**The public repository names live secrets.** `dev-admin-key` and the shipped
default database password appear in tracked documents; a MongoDB Atlas password
was pasted into chat earlier and is still live. **Rotation, not removal** — the
history is public. Nothing engineering does substitutes for this.

**No payment provider.** Activation is automatic and checkout is stubbed, so the
product cannot take money. Every parity item is behind this in value.

**No domain, TLS or VPS.** Not reachable by a customer.

**No ToS or privacy policy.** Required before processing anyone's messages.

### Commercial, awaiting a decision

**MAC counts broadcasts; theirs excludes them.** This changes what can be
charged and has been open since early in the session. It is a pricing decision,
not an engineering one.

**No overage model.** Theirs sells MAC on demand at $12–15/100 with a 200% hard
cap on AI credits.

### Engineering

**Nine uncommitted files in the working tree** — the owner's trial-gateway work,
spanning a migration, billing, plans, the trial service, the provisioning worker,
a new channel-entitlement module and a harness assertion. It **must land as one
commit**: the migration alone breaks the committed gate, which is why it was
removed from main.

**The rate limiter is in-process.** Correct for one backend instance and wrong
the moment there are two — every limit becomes per-instance. Documented in
`rate-limit.middleware.ts`.

**`test:public-api` boots a real server.** Deliberate, because everything
protecting that surface is in the middleware chain rather than the handlers — but
it is the one new gate that can go red for environmental reasons. It prints
`[ENV]` and **no summary line** when the server does not start, so an
environmental failure cannot be mistaken for a code one.

**Docker has taken the daemon down twice** during image builds (D-3). Image
builds are a checkpoint activity, not a per-commit gate, and that is deliberate.

---

## 7 · What is left

Against the matrix: **~40 absent, ~45 partial**, versus ~57 matching and **25
where we are ahead**.

| Area | Remaining | Notes |
|---|---|---|
| **Workflow canvas** | The graph editor | Blocks `JUMP_TO`, `TRIGGER_WORKFLOW`. The single largest item |
| **AI (§06)** | Everything | Nothing exists. Roadmap says after revenue |
| **P2 tail** | Templates (31), testing, import/export | Templates matter most — a builder with no starting points goes unused |
| **Reports** | Lifecycle funnel, assignments, leaderboard | |
| **Settings** | Data Export, Growth Widgets | Reaches their 18 |
| **Contacts** | Unmerge, import tag, default segments | Unmerge is now unblocked by collaborators |
| **Inbox** | Typing indicators, link previews, merge card, 4 sort modes | |
| **WhatsApp** | Messaging tiers, quality rating, 250-contact unverified cap | The cap is a hard ceiling on broadcasts that nothing currently mentions |
| **Developer** | TypeScript SDK, MCP server | The last two §13 items |
| **Re-skin** | The 1,197-line general page | Everything else is converted |

### Deliberately not copied

Calls, tasks, the channel switcher, Chats/Calls tabs, one-team-per-user, AI
Objective — six items marked deliberate in the matrix.

And three where matching them would make the product worse: token scoping,
webhook signing, and the delivery log. Their own documentation flags the first
as a gap.

---

## 8 · How to verify any of this

```bash
cd apps/backend
npm run test:tenancy        # 128 — isolation, the release blocker
npm run test:public-api     # 141 — over HTTP against a booted server
npm run test:workflow-p2    #  71 — hermetic
npm run test:webhooks       #  52 — hermetic
npm run test:restrictions   #  51 — hermetic
npm run test:csv            #  30 — hermetic
npm run test:api-tokens     #  90
```

**Read the printed summary line, never the exit code alone.** A command list
exits with the status of its last command. Three defects in this repository were
gates reporting on their environment rather than on the code — see D-5, D-10,
D-12, D-16 in [KNOWN-DEFECTS.md](KNOWN-DEFECTS.md), and §5 above for a fourth
found this session.

**A gate is green only when it was watched to run.**
