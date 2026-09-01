# Respond.io parity — the phased roadmap

**What it would take to make RabiTech work the way Respond.io works, in order, with the UI decisions written down beside the engineering.**

Compiled 1 September 2026 from `respond-io-as-documented.md` — a survey of ~130
first-party Respond.io pages plus their own OpenAPI 3.0 specification — checked
line by line against this codebase.

---

## How to read this

**Judged by enforcement, not by declaration.** Every "we have this" below was
verified at the code that enforces it, not at a schema field or a settings
toggle. This project has shipped five controls that looked real and gated
nothing — `autoProvisionGateway`, `allowedChannels` on the QR path, the tenant
`Keyword` model, and twice in one evening inside M8.1 itself. A feature that
exists in the schema and nowhere in a route is not a feature.

**Where a prior document disagrees with the code, the code wins.** That has been
true every time this project has checked.

**Their gaps are marked too.** Respond.io's documentation carries its own
`NOT DETERMINED` blocks, and several of them are places where we are ahead. Those
are recorded in §2 so nobody "achieves parity" by removing something better.

---

## 1. Where we already match

Do not rebuild these. Each was verified at its enforcement point.

| Capability | Ours | Theirs |
|---|---|---|
| **Auto-close timer semantics** | `markSuccessfulHumanOutbound` — only a human customer-facing send arms it; asserted by the tenancy gate | *"Messages sent by Broadcasts, Workflows or AI Agents do not start or reset the auto-close timer"* |
| **Custom field types** | text, list, checkbox, email, number, url, date, time | The same eight |
| **Closing-note enforcement** | `ClosingNoteMode` — optional / category / category+summary | The same three modes |
| **Assignment algorithms** | round-robin, least-open, with active/away/capacity guards | The same two, with online and capacity guards |
| **Conversation categories** | `ConversationCategory`, name denormalised onto the closure | Same, minus the rename (see §2) |
| **Snooze** | With customer-reply cancellation, gated | Same, durations undocumented on their side |
| **Snippets with topics** | `SnippetTopic` many-to-many, attachments | Same shape; 5,000/workspace cap |
| **Saved views with visibility** | `InboxView`, private/shared | Custom Inbox, private/public/shared |
| **Per-user restrictions** | 6 of their 7 (M8.1) | 7 in the API enum |
| **Blocked contacts** | M9.1 — dropped at the worker before a thread opens | Same intent; also excludes from MAC (see §5) |
| **Lifecycle stages** | Configurable, ordered, default, won/lost | Same, capped at 20 |

**A note on how close the M8.1 match is.** Their API publishes
`restrict_data_export`, `restrict_contact_deletion`, `restrict_space_setting`,
`show_team_contacts`, `show_only_mine`, `restrict_space_integration`,
`restrict_shortcuts`. We built six of those seven on 1 September without having
read this list. The one we deliberately withheld —
`restrict_space_integration` — is the one no route here can currently enforce.

---

## 2. Where we are ahead — do not regress toward them

**Consent.** Their broadcast documentation carries this, verbatim:

> **NOT DETERMINED — Opt-out handling.** *No page documents a built-in opt-out
> or unsubscribe mechanism, a STOP keyword, an opt-out flag on a contact, or
> automatic exclusion of opted-out contacts from broadcasts.*

Their only guidance is to obtain consent externally, and "Unsubscribe from
Broadcasts" is a **workflow template a customer builds**. Ours is a platform
rule: `audienceWhere` excludes `OPTED_OUT` unconditionally with no override
anywhere in the API, `ConsentEvent` keeps the history, and STOP is detected in
three languages on whole-message equality. **This is the single largest thing we
have that they do not.** Nothing in this roadmap weakens it.

**Empty segments.** `validateContactFilter` refuses a rule-less filter outright.
They ship six default segments and no such guard.

**Renaming a conversation category.** Theirs cannot be renamed — delete and
recreate. Ours renames with a cascade onto stored closures.

**Reopening a conversation.** Theirs appears to create a *new* conversation;
their own document calls this "the single largest gap in the documented
conversation model." Ours reuses the thread and preserves history — better for
the operator, and as of M9.2b it also drops an assignee who can no longer
receive it.

**Broadcast reply measurement.** They have none: *"Reply capture appears to be
something a customer builds with a workflow."* Ours is native and defined by one
exported predicate so the count and the list behind it cannot disagree.

**Tenancy.** They document no equivalent of composite tenant-bound foreign keys.
Ours makes a cross-tenant reference unrepresentable rather than merely refused.

---

## 3. The phases

Ordered by value per week of work, not by module. Each carries the UI decision,
because in every case below the interface is the harder half.

---

### P1 · Public REST API and outbound webhooks · ~3–4 weeks

**The single highest-value phase, and the largest structural gap.**

They expose `api.respond.io/v2`: 24 operations, bearer auth, cursor pagination,
5 req/s per method-and-path, a documented error set including a `449 "resource
is still being created"`, plus a TypeScript SDK and an MCP server. We expose
nothing. No Zapier, no n8n, no customer integration, no MCP — and no way for a
subscriber to build the thing we have not built.

**Their specification is a free blueprint.** Copy the shape, not the gaps.

Scope:
- `GET/POST/PUT/DELETE /contact/{identifier}` with their identifier grammar
  (`id:`, `email:`, `phone:`), plus `create_or_update`.
- `POST /contact/list` with a filter body — note it is a POST, because a filter
  grammar does not fit a query string. Their operator list is the only complete
  one published anywhere: `isEqualTo, isNotEqualTo, isTimestampAfter,
  isTimestampBefore, isTimestampBetween, exists, doesNotExist, isGreaterThan,
  isLessThan, isBetween, hasAnyOf, hasAllOf, hasNoneOf`. **Ours already has a
  richer DSL** — expose that rather than narrowing to theirs.
- Tags, lifecycle, comments, conversation assignee and status, messaging.
- Outbound webhooks: their eleven events, HMAC-SHA256 in `X-Webhook-Signature`,
  3 retries at 30/60/90s, auto-deactivation at 30 errors in 30 minutes.

**What to do better than them, deliberately:**
- **Token scoping.** Their own doc: *"No expiry, rotation, revocation procedure
  or scoping mechanism is documented anywhere… the token is workspace-wide."*
  Ours should carry scopes and an expiry from day one. Retrofitting auth is the
  most expensive fix in software.
- **A webhook delivery log.** Theirs has none and it is an open feature request.
  We already have `WebhookDeliveryLog` for the workflow step — reuse it.

**UI/UX:**
- Settings → Integrations → **API tokens**: create, name, scope, last-used-at,
  revoke. Show the token **once**, with a copy button and a plain warning that
  it will not be shown again. Never render it again anywhere.
- **Webhook endpoints** page: URL, events (checkboxes), signing key, and a
  *live delivery log* — status, latency, response code, retry count. That log is
  what makes webhooks debuggable and is precisely what they lack.
- An auto-deactivated endpoint must say **why**, when, and offer one button to
  re-enable. Their version emails you and leaves you to find the switch.

**Done when:** a subscriber can create a scoped token, call five endpoints, and
receive a signed webhook they can verify — with every delivery visible in the
console.

---

### P2 · Workflow triggers and steps · ~2 weeks

Ours: **5 triggers, 10 actions.** Theirs: **11 triggers, 19 steps.**

Highest value first, and two of these change what is *expressible*:

**Triggers to add**
| Trigger | Why it matters |
|---|---|
| **Lifecycle Updated** | Closes the loop opened by `SET_LIFECYCLE_STAGE` — a stage change can now drive automation |
| **Contact Field Updated** | The generic hook everything else is built from |
| **Shortcut** | An agent fires a workflow from the inbox, with an optional form. Changes how agents work day to day, and is the cheapest of the three |
| Incoming Webhook | Requires P1 |

**Steps to add**
| Step | Note |
|---|---|
| **Add Comment** | Internal note with `@mention` — we already have mentions and notes; this is wiring |
| **Open Conversation** | Their rule is worth copying exactly: *"sending a message from the workflow will not automatically open the conversation"* |
| **Close Conversation with category and summary** | We close; we do not attach closing notes |
| **Jump To** | Turns a list into a graph. Their caps: 10 jumps, "avoid more than 3" |
| **Trigger Another Workflow** | Same. Their warning is load-bearing: consecutive uses run **concurrently** |

**Limits to adopt**, because ours are looser and theirs are considered: 100 steps
per workflow, 7-day total execution, 9 branches plus Else, 10 conditions per
branch.

**UI/UX:** the form builder gains a step type per row. **Do not** add Jump To or
Trigger Another Workflow to the form builder — a graph does not render as a
list, and a jump target picker in a flat list is unusable. Those two wait for
P3 and should be refused at save until then, the way `WAIT_DELAY` and
`ASK_QUESTION` are already refused inside branches.

---

### P3 · The workflow canvas · 6–8 weeks · already P11.6

The flagship gap. The engine, every node, branching and the run log exist;
`/automations` is a form. Their builder is a canvas and it is why their workflows
feel like a product rather than a settings page.

**UI/UX — this phase is almost entirely interface:**
- React Flow. Drag nodes, connect edges, a config panel on the side rather than
  in a dialog — the current dialog is why branch editing stops at one level.
- **Validation on the canvas, not on save.** An orphan node, a missing trigger,
  a jump to nothing: show it on the node, in place. Their builder blocks
  publication on loops and names the offending step; ours should do the same and
  point at it.
- **Draft / Published / Stopped**, exactly as theirs. Editing requires the
  stopped state so no contact is ever mid-journey during an edit. Their rule is
  worth copying whole: *"When a Workflow is stopped, all enrolled Contacts will
  be ejected immediately."*
- Keep the form builder as an alternative view for simple flows. Do not delete
  it; a three-step automation is faster to type than to draw.

---

### P4 · Inbox completeness · ~2 weeks

Four absences, all small, all visible every day.

**Collaborators as first-class.** Ours has @mentions in internal notes; theirs
has a collaborator *role* on a conversation — up to 9, each able to do
everything the assignee can, with their own **Collaborations inbox**, added via
button, quick action, or @mention when a workspace setting allows it.

*UI/UX:* avatars in the conversation header, at most 3 shown plus a count.
A Collaborations entry in the inbox selector beside Mine and Unassigned. Their
rule — *"any collaborator or the assignee can remove a collaborator"* — is right;
a permission model here would be friction with no benefit.

**Blocked Contacts inbox.** We block; there is nowhere to see who is blocked.
A blocked contact currently disappears with no way to review or undo except
finding them by search.

*UI/UX:* an inbox entry, not a settings page. Blocking is an operational act and
belongs where the operator works. Show who blocked them, when, and the reason.

**Unmerge.** We merge and cannot undo it. Their split is asymmetric and worth
copying exactly: *"The primary Contact will have all interactions that happened
after the merge, plus all collaborators. The secondary Contact will keep any
interactions made before the merge, and no collaborators."*

**Auto-generated import tags.** Theirs tags every import automatically so the
batch is instantly a segment. Ours has an optional tag. One line, real value.

---

### P5 · Reports · ~2 weeks

Ours has the core. Theirs has eleven tabs. Missing: **Resolutions**,
**Assignments**, **Leaderboard**, **Users**, and Lifecycle-as-a-funnel.

Three of their counting rules are worth adopting verbatim because they are the
difference between a number and a true number:

- *"Resolutions report will be based only on closed conversations."*
- *"Unassignment will also be counted as an assignment."*
- The Users table *"only displays users who have closed at least one
  conversation in the selected time range."*

**UI/UX:** every tab states its exclusions **on the tab**, not in a tooltip. A
report whose scope rule is hidden is a report that will be misread — and their
Responses tab silently excludes workflow responses *and* open conversations,
which changes every number on it.

Also adopt: **10,000-row cap** with an explicit "truncated" statement, and
per-user column visibility that does not affect other users.

---

### P6 · Contacts and settings depth · ~1 week

Small, cumulative.

- **Import ceiling** 20,000 → 200,000 rows. Ours already chunks at 250 per
  transaction, so this is a constant and a progress UI.
- **Contact Status as a filterable field**, as theirs is — a column, a filter,
  and a read-only row in the panel.
- **Teams cap** and their rule that a user belongs to **one team**. Ours allows
  many. Theirs is simpler and makes routing legible; ours is more flexible.
  *A decision, not a defect.*
- **Files settings**: per-channel size caps surfaced to the operator, so a
  failed send is explicable before it fails.

---

### P7 · AI · after revenue · P13

Deliberately last, and their design is a warning as much as a model.

**Copy:** the receptionist pattern — collect intent, tag, hand to a human,
never answer. Their AI Agent actions are a good action list. Their credit model
(scaling allowance, hard cap at 200% of allowance) is sound.

**Do not copy:** their trust boundary. They locked down the customer-facing
agent and left the **internal staff composer unrestricted** — the boundary drawn
opposite to the risk. Staff-facing AI writing into customer records with no
guard is the higher-consequence half, and it is the half that feels safe.

**The blocker is structural, not schema.** The executor is a `switch`, so every
safety property is per-`case`. An AI action added to it starts with no consent
check, no quota check and no field allowlist — which is exactly how D-30 and
D-31 happened. **Fix the executor's shared-safety problem before adding AI to
it**, or the first AI action will ship both bugs again.

---

## 4. Deliberately not adopting

| Theirs | Why not |
|---|---|
| No platform opt-out | §2. Ours is the differentiator |
| Categories cannot be renamed | Ours renames with a cascade; theirs is a limitation |
| Reopen creates a new conversation | Ours preserves the thread. Theirs is cleaner for metrics, worse for the operator |
| Workspace-wide API tokens with no expiry | Their own doc flags it. Scope from day one |
| No webhook delivery log | An open feature request on their side |
| Tasks inbox | Unconfigured in the live workspace inspected, at 663 contacts |
| Calls | RabiTech is a one-to-one text platform by design |
| One team per user | Theirs is simpler; ours is more flexible. Keep ours |

---

## 5. The one place they are right and we are wrong

**Monthly Active Contacts must exclude broadcasts.**

Theirs, verbatim: a contact becomes active when they *"send or receive a message
(**excluding broadcasts**)"*. Ours counts them:
`entitlements.ts:333` calls `recordMessageUsage('OUTBOUND', contactId, …)`
unconditionally, and that records an `active_contacts` event whenever a
`contactId` is present. The `options.campaign` branch only *adds* a
`campaign_sends` event; it never suppresses the MAC one.

Two consequences, both against the subscriber:

1. A broadcast to 1,000 contacts makes all 1,000 billable. On their platform it
   makes none.
2. **Worse:** `entitlements.ts:318` calls `assertMetricAvailable('active_contacts')`
   for a contact not yet active this month — so a subscriber at their MAC
   ceiling **cannot broadcast at all**, even with campaign sends remaining. The
   two quotas are coupled and nothing documents it.

This is not a bug. It is a pricing decision currently being made by an
implementation detail rather than by the platform owner, and it should be made
deliberately before the first paying customer, because changing it afterwards
changes bills.

---

## 6. Honest sequencing

"Everything closer to them" is **six to nine months** at this pace.

**None of it changes that F0.1 — choosing a payment provider — is still the only
thing between this product and a paying customer.** Respond.io built every
capability above *with revenue*. This roadmap is what to do after that decision
is made, not instead of making it.
