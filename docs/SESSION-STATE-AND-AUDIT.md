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

Three instances, and three is what turns coincidence into a category. Each is a
check that passed while proving nothing, and in every one the cause was the
same: **the thing doing the checking was structurally incapable of seeing the
thing it was checking.** Not a wrong assertion — a right assertion pointed at an
artifact where the property does not exist.

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

**How each was actually caught, since none was caught by reading:** (1) and (2)
by mutation — making the check fail on purpose, which is the only thing that
distinguishes a check that works from a check that is merely green. (3) by
cloning `origin/main` into a temp directory and running the gate there, which is
the only vantage point from which a working-tree-only defect is visible.

**The rule.** Before trusting a check, ask what the thing doing the checking is
structurally incapable of seeing.

The corollaries are cheap and worth stating: a check on a *source* property
(a cast, a comment, an import) must read source; a check on a *runtime*
property (a call, an order) must read compiled output; a check on anything the
build or the VCS normalises — line endings, whitespace, erased types — cannot
be trusted from inside the environment that normalises it.

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
