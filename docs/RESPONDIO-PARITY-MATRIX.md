# Respond.io parity — the complete matrix

**Every module, every capability, nothing skipped.** The companion to
[RESPONDIO-PARITY-ROADMAP.md](RESPONDIO-PARITY-ROADMAP.md), which sequences the
work; this one is the exhaustive inventory it was sequenced from.

Compiled 1 September 2026 from a survey of ~130 first-party Respond.io pages
plus their OpenAPI 3.0 specification, checked against this codebase at the
enforcement point. **The method, the surfaces read, and what that survey does
and does not establish are recorded in
[RESPONDIO-SOURCES.md](RESPONDIO-SOURCES.md).**

The survey document itself is deliberately not in this repository — it is a
detailed competitor teardown and this repository is public. Until 2026-09-02
this preamble cited it by filename alone, which meant a clean clone could not
check the sourcing of a single claim below. That is what the sources file fixes.

**Legend**
`✓` we have it · `≈` partial, gap named · `✗` absent · `★` **we are ahead** ·
`—` deliberately not building · `?` **unverified — see the audit note**

---

## Last audited against code: 2026-09-03

**Read this before trusting a row.** This document is a claim about code, and a
claim about code decays silently: nothing fails when a row goes stale, and a
stale row reads exactly like a checked one.

It decayed here. Three rows were known wrong before this audit and a fourth
was found by it costing real work — `Collaborators` was marked
`✗` **"the largest inbox gap"** while shipping complete and gated at 14/14, and
that row caused a prompt to commission a feature that already existed. A `✗`
that ships is the expensive direction: a `≈` that is really `✓` understates
the product, but a `✗` that is really `✓` gets it built twice.

**Twelve rows were corrected on 2026-09-03.** Eight had shipped and still read
`✗`; one `≈` was complete; three were reworded because the gap named in them
had moved. Each corrected row now names the file or the gate that proves it, so
the next reader can check a claim without re-deriving it.

### How much of this document was actually checked

| Section | Status |
|---|---|
| 02 Inbox | **Audited row by row** against `src/modules/conversations`, `components/inbox`, and the `inbox-gaps` and `collaborators` gates |
| 04 Contacts | **Audited** for the absent rows: unmerge, default segments, blocked-excluded-from-merge, conversation-status-as-field, import auto-tag, data export |
| 10 Settings | **Audited** for Growth Widgets and Files |
| 11 Roles | **Audited** for `restrict_space_integration` and collaborator visibility override |
| 12 Plans | **Audited** for the MAC exclusion row only |
| 01 Dashboard | **Audited 2026-09-03 (second pass).** One row corrected |
| 05 Workflows | **Audited (second pass)** against `workflow-schema.ts`: 9 triggers and 17 declared / 15 usable steps confirmed exactly, and every entry on both "still missing" lists confirmed genuinely absent. No change |
| 09 Reports | **Audited (second pass).** Already correct — the lifecycle-funnel and closures rows carry commit hashes |
| 13 Developer platform | **Audited (second pass).** Already correct; SDK, MCP and custom channel remain the only absent rows |
| 03, 06, 07, 08 | **NOT audited.** Their rows are as previously written and their accuracy is unknown |

The unaudited sections are not asserted to be wrong. They are asserted to be
**unchecked**, which is the state the whole document was in before anybody
looked — and the distinction is the only thing that stops this happening again.
Sections 05 (workflows) and 13 (developer platform) carry the largest absent
counts and are therefore the ones where a stale `✗` would cost the most; they
are the obvious next pass.

**The cheapest way to keep this honest** is to correct the row in the same
commit as the feature. Every row corrected here was stale because that did not
happen — the work shipped, its gate went green, and nobody came back.

---

## 01 · Dashboard

Theirs is a fixed five-widget screen, Owners and Managers only, separate from
Reports.

| Widget | Theirs | Ours (`/overview`) |
|---|---|---|
| Contacts with open conversations | Avatar, name, last message, duration, assignee; sorted longest-first | `≈` we show contacts and counts, not sorted by conversation duration |
| Team Members | All users, status, team, assigned count; filter by team and status | `✗` |
| Conversations opened / closed | Today, Yesterday, 14d, 30d | `✓` opened and resolved, last-7-days default |
| Merge Suggestions | Inline merge or dismiss | `≈` we have merge suggestions in Contacts, not on the dashboard |
| Upcoming Broadcasts | Name, channel, scheduled time | `≈` `overview/page.tsx` renders an **Upcoming broadcasts** panel — name, scheduled time and recipient count, the next five, linking to /campaigns. Channel is not shown |

**Their documented trap, worth copying the awareness of:** the Dashboard counts
assigned contacts differently from the Inbox — *it includes blocked contacts
while the Inbox does not*. Ours must not repeat that now that M9.1 exists.

**Gap:** Team Members widget, merge suggestions on the dashboard, duration
sorting, and channel on the broadcasts panel.

**Corrected 2026-09-03.** The Upcoming Broadcasts row said `✗`; the panel
exists and is titled. Team Members was re-checked and is genuinely absent from
`/overview`.
**Size:** ~2 days. **Phase:** P5-adjacent.

---

## 02 · Inbox

### Structure and inbox types

| | Theirs | Ours |
|---|---|---|
| Panes | Side panel · list · right sidebar | `✓` four-pane (scope, list, thread, contact) |
| Chats / Calls tabs | Two tabs | `—` no calls, by design |
| Standard Inbox | All, Mine, Unassigned, **Collaborations** | `≈` All, Mine, Unassigned — no Collaborations |
| Team Inbox | One per team | `✓` |
| Custom Inbox | User-created, All / By me / By others | `✓` `InboxView` |
| **Blocked Contacts Inbox** | Contacts you blocked; unblock from the row | `✓` `components/inbox/blocked-contacts-list.tsx`, `GET /api/contacts/blocked`; certified by `inbox-gaps` 36/36 |
| Lifecycle as inbox | *"Lifecycle does not create a separate inbox"* | `★` **ours does** — lifecycle queues in the selector |

**Custom inbox visibility:** theirs is Private (default) / Public / Shared with
named users or teams. Ours is private/shared. **Gap: per-user and per-team
sharing.**

### Conversation list

| | Theirs | Ours |
|---|---|---|
| Status filters | All, Open, Closed, Snoozed | `✓` plus PENDING and AWAITING_CLIENT |
| **Unreplied toggle** | Conversations lacking a team response | `✓` `conversations.routes.ts`; server-side, defined as no OUTBOUND non-internal non-auto message |
| Sorts | Newest, Oldest, Longest, Shortest (per state) | `≈` all four ship (`conversationOrder` in `conversations.routes.ts`); Longest/Shortest rank by `openedAt`, so for a resolved thread this is age rather than handling time |
| Row indicators | Status, channel icon, unread count, direction arrow (blue out / orange in) | `✓` arrow **and** colour, flipped under rtl, with an accessible name — `inbox/page.tsx` |
| Unread expiry | Cached; expires after **90 days** inactivity | `✗` n/a |
| Quick actions | Close · Close with notes · Snooze · Shortcuts · Assign · Collaborators · Lifecycle | `≈` **missing Shortcuts only** — Collaborators ship (`inbox/page.tsx`, `handleAddCollaborator`) |

**Gap:** Shortcuts. The unreplied toggle, the four sort modes, directional
indicators and Collaborators all shipped between 2026-09-02 and 2026-09-03.
**Size:** ~3 days without Shortcuts (which needs P2).

### Conversation window

| | Theirs | Ours |
|---|---|---|
| Typing indicators | WhatsApp, TikTok, Telegram | `✗` |
| Per-message actions | Copy, Copy link, Translate, Reply, Reply with AI Assist | `≈` no copy-link, no translate |
| Audio transcription | Yes | `✗` (P7) |
| Delivery status | Sent / Delivered / Read / Failed | `✓` |
| Link previews | Supported channels | `✗` |
| Channel switcher | Yes | `—` single channel by design — see also multichannel growth widgets in §10, which is `—` for the same reason |

### Contact details pane

| | Theirs | Ours |
|---|---|---|
| Tabs | Contact details · Call activities · Activities · HubSpot · Salesforce · Attachments | `≈` details, conversations, files, activity |
| Fields shown | Phone, email, country, language | `✓` plus custom fields, tags, consent + provenance, block |
| Merge suggestion card | Inline in the pane | `✓` `components/contacts/merge-suggestions.tsx` + `GET /api/contacts/merge-suggestions` |
| Channel status | Active / Inactive / Unavailable | `≈` |

### Snippets

| | Theirs | Ours |
|---|---|---|
| Fields | Name, Message, Topic, Files | `✓` |
| Caps | 5,000/workspace · 10 topics each · 50 files each · **5 files per composed message** | `≈` no documented caps |
| Composer invocation | `/` search | `✓` `:code` expansion |
| Dynamic variables | Yes | `✓` |

**Gap:** the caps, particularly 5-files-per-message which is a real send-failure
guard. **Size:** hours.

### Comments, mentions, collaborators

| | Theirs | Ours |
|---|---|---|
| Internal comments | Never visible to contacts; 50 files each | `✓` `Message.isInternal` |
| @mentions | Yes, with notification | `✓` (H5) |
| **Collaborators** | Up to **9**; can do everything the assignee can; own inbox; added by button, quick action, or @mention when a workspace setting allows | `✓` **all of it**, gated at 14/14 by `test:collaborators`. `ConversationCollaborator`, cap in `collaborator-limits.ts`, Collaborations scope in `inbox-selector.tsx`, and the @mention path behind `OrganizationConfig.mentionAddsCollaborator` (default off) |
| Conversation events | Assignments, closures, snoozes, workflow automation, inline and in Activities | `✓` |
| AI Summarize | Drafts an internal comment | `✗` (P7) |

**Their collaborator rule worth copying whole:** *"Any collaborator or the
assignee can remove a collaborator — there's no restriction on who can remove
whom."* A permission model there is friction with no benefit.

---

## 03 · The conversation model

| | Theirs | Ours |
|---|---|---|
| States | Open · Closed · Snoozed (3) | `★` OPEN · PENDING · RESOLVED · AWAITING_CLIENT (4) |
| Opening sources | 8: User, Contact, Workflow, API, Zapier, Make, Paid Ads, Growth Widget | `✗` **we record none of the eight.** There is no `openingSource` column on `Conversation` at all. Three — Contact, Workflow, User — are *reconstructible* from which code path created the row, which is not the same as stored and cannot be queried, filtered or reported on |
| Closing sources | 8–9 incl. Bot, AI Agent, n8n, **Blocked** | `✓` MANUAL, AUTO_CLOSE, WORKFLOW, API, MERGE |
| Merge/delete do **not** close | Explicit non-fire rule | `✓` same |
| Auto-close config | Default 24h · min 30 min · max 14 days | `✓` min 30 / max 20160 |
| **Auto-close timer rules** | Starts on last human outbound; resets on another human; cancelled by contact reply; **broadcasts, workflows and AI do not start or reset it** | `★` **identical, and gated** — the tenancy harness asserts *"only a human customer-facing send arms the auto-close timer"* |
| Snooze | Absolute dates (inferred); no snooze trigger | `★` ours cancels on customer reply, gated by `test:snooze` |
| Reopening | *Appears* to create a **new** conversation — their own doc calls this "the single largest gap in the documented conversation model" | `★` ours reuses the thread, preserves history, and as of M9.2b drops an assignee who can no longer receive it |
| Closing notes | Category + summary, three enforcement modes | `✓` the same three |
| Default categories | General Inquiry, Sales Inquiry, Payment Issue, Others | `≈` tenant-defined |
| Category rename | **Cannot be renamed** — delete and recreate | `★` ours renames with a cascade |

**Gap:** opening sources. This row read `≈ Contact, Workflow, User` until
2026-09-02 and that overstated us — it described what is *inferable from which
code path ran*, not a column. `grep` for the concept across the backend returns
nothing. The gap is all eight, not five.

**Deferred by design, not overlooked:** `ConversationOpeningSource`. Declaring
an eight-member enum to close this cell would leave **five members with no
producer** — API, Zapier, Make, Paid Ads and Growth Widget are all downstream of
integrations this platform does not have — and that is precisely the
declared-but-unreachable defect this repository has now found ten times. Closing
a documentation cell is not worth manufacturing the eleventh instance of its own
signature defect.

Attribution is also the wrong shape for a conversation. A contact is acquired
once; conversations recur. When Growth Widgets lands, where it came from belongs
on `Contact` as write-once first-touch, and an opening-source enum can follow
later carrying **only the members something actually writes**.

Note what is *not* being copied here: `JUMP_TO` in §05 is declared, filtered from
the served vocabulary, and refused at save — deliberately unreachable behind a
guard. Applying that mechanism here would mean declaring `GROWTH_WIDGET` and
refusing it, which is the same defect with an excuse attached. Nothing is
declared. **This record lives in this document only.**

---

## 04 · Contacts

### Fields

| | Theirs | Ours |
|---|---|---|
| Standard fields | 7, uneditable: First/Last Name, Phone, Email, Country, Language, Profile Picture | `✓` the same seven |
| Custom field types | 8: text, list, checkbox, email, number, url, date, time | `✓` **the same eight** |
| Field constraints | List/URL 255 chars · Date `YYYY-MM-DD` 1900–2100 · no defaults · ID and type immutable · emoji rejected in names | `≈` we validate type; not all caps |
| Visibility | Always show / Always hide / Hide when empty | `✓` the same three |
| Delete a custom field | Owners only | `≈` supervisor |
| **Conversation Status as a contact field** | Column, filter, read-only row | `✗` |

### Tags

| | Theirs | Ours |
|---|---|---|
| Shape | Emoji, name, colour, description | `✓` |
| **Agents can create from the Inbox** | Yes, any role | `✓` `contact:create` |
| Delete confirmation | Type the assigned-contact count | `✓` (verified in `workspace-tags.tsx` + `contacts.routes.ts`) |
| Bulk tagging cap | 100 contacts at a time | `≈` |
| **Auto import tag** | Generated for every import | `✗` |
| Provenance | Not documented | `★` `ContactTag.source` — MANUAL / IMPORT / WORKFLOW / API |

### Segments

| | Theirs | Ours |
|---|---|---|
| Dynamic membership | Yes | `✓` |
| Cap | **500 per workspace**; unique names | `≈` no cap |
| Default segments | 6 ship, two undeletable | `✗` |
| Sharing | Public to all Contacts-module users | `≈` org-wide |
| **Empty-filter guard** | None documented | `★` **ours refuses a rule-less filter** |
| Operators | 13, published only in their API spec | `★` **ours is richer** — plus nested groups to depth 3 |

### Merge, unmerge, deduplication

| | Theirs | Ours |
|---|---|---|
| Merge | Channels, Messages, Events, Comments consolidated | `✓` |
| Suggestions | Phone or email match | `✓` |
| Which side's values survive | **NOT DETERMINED in their own docs** | `≈` ours is defined |
| Older contact becomes primary | Only in their API spec | `≈` |
| **Unmerge** | Asymmetric split — primary keeps post-merge + collaborators; secondary keeps pre-merge, no collaborators | `✗` **we cannot undo a merge** |
| Blocked contacts excluded from merge | Yes | `✗` |
| Bulk / auto merge | Neither exists | `—` |

### Import

| | Theirs | Ours |
|---|---|---|
| Format | CSV, UTF-8 | `✓` |
| Size | < 20 MB, **200,000 rows** | `≈` **20,000 rows** |
| Conflict modes | 4 incl. "add all despite duplicates" | `≈` |
| Match keys | Phone, email, Contact ID | `≈` phone |
| Overwrite control | "Do Not Overwrite"; tags accumulate | `≈` |
| Phone format | **E.164 with `+`** | `★` **ours stores digits-only deliberately** — E.164 would mean an imported contact never matches their own inbound message |
| Import tag | Automatic | `✗` |
| Retention | Results file 7 days; one job at a time | `≈` |
| **Imports do not trigger workflows** | Explicit | `✓` same |
| **Opt-out survives import** | Not documented | `★` ours refuses to resurrect an opted-out contact |

### Export

| | Theirs | Ours |
|---|---|---|
| From module | 100/page, 2,500 pagination ceiling | `≈` 20,000 cap |
| Data Export module | Contacts, Conversations, Messages, Failed Messages; 365-day range; 7-day validity; one job | `✗` **no separate export module** |
| CSV-injection guard | Prepends `'` before `= + - @` tab CR `;` `` ` `` `\|` | `≈` we quote; no injection prefix |

### Blocking and lifecycle

| | Theirs | Ours |
|---|---|---|
| Block stops messages, closes conversations, **prevents workflow triggers** | Yes | `≈` ours drops before a thread opens — workflows never fire either |
| **Block excludes from MAC** | Yes | `✗` **see §12** |
| Blocked cannot open/close conversations | Buttons hidden | `≈` |
| Delete contact | Unlimited, deletes history, irreversible | `✓` |
| Lifecycle stages | **Max 20** incl. Lost; one default; drag-reorder | `≈` no cap |
| Lost stages | Distinct kind | `✓` `kind: ACTIVE\|LOST` |

---

## 05 · Workflows

**Corrected 2 September 2026 against the code.** This section was compiled
before P2 shipped and understated us on six rows — it still listed four
triggers and two steps as missing that exist. Counts below are read from
`workflow-schema.ts`, not from a plan.

| | Theirs | Ours | |
|---|---|---|---|
| **Triggers** | **11** | **9** | `≈` |
| **Steps** | **19** | **15 usable** (17 declared, 2 refused by design) | `≈` |
| Conditions | 11 categories, 18 operators | 6 | `≈` |
| Branches | **9 + Else**, conditions 10 per branch | nesting `MAX_BRANCH_DEPTH = 3`, `MAX_CONDITIONS = 10` | `≈` |
| Steps per workflow | 100 | **100** (`MAX_ACTIONS`) | `✓` |
| Workflows per workspace | 150 | plan-gated | `≈` |
| Total execution time | **7 days** | **7 days** (`MAX_RUN_DURATION_MS`) | `✓` |
| Draft / Published / Stopped | Editing requires stopped; enrolled contacts ejected on stop | `≈` active/inactive only |  |
| Re-entry | *"A Contact cannot re-enter a Workflow they are currently enrolled in"* | 60-second window; a run can no longer outlive the 7-day deadline | `≈` |
| Testing | Built in | `✗` | |
| Import/export | 100 steps, ≤400 KB | `✗` | |
| Templates | 31 pre-built | `✗` | |

**The nine triggers we have:** Conversation Created · Keyword Matched ·
Tag Added · Tag Removed · Out of Hours · Lifecycle Updated ·
Contact Field Updated · Incoming Webhook · Shortcut.

**Still missing:** Manual Trigger · Click-to-Chat Ads · TikTok Ads · Call Ended ·
**Conversation Closed**.

**Still missing steps:** Close-with-category · Google Sheets · Meta CAPI ·
TikTok events · Date & Time as a *step* (ours is a condition only).

**Refused by design, not missing:** `JUMP_TO` and `TRIGGER_WORKFLOW`. Both are
declared in `ACTION_TYPES` so the validator can name them, **filtered out of the
served vocabulary** so the builder never offers them, and **refused at save** by
name with a message saying why. Neither has an executor branch, so neither is
reachable. A jump target is a position, and a flat builder has no stable
positions — reordering one step would silently repoint every jump past it. They
arrive with the canvas.

> **Arithmetic, resolved.** The note that stood here left the sum open. It
> closes once two things are noticed: not every trigger of ours has a
> counterpart, and one of theirs answers to two of ours.
>
> - **Five missing**, not four — Conversation Closed was absent from the list.
> - **Two of ours have no counterpart:** Keyword Matched and Out of Hours.
>   Neither appears in their catalogue at all.
> - **Two of ours collapse into one of theirs:** our Tag Added and Tag Removed
>   are their single *Contact Tag Updated*.
>
> So: 9 − 2 with no counterpart = 7, of which Tag Added/Removed count once
> against theirs = **6 shared**. 6 shared + 5 missing = **11**. Their number and
> ours reconcile exactly, and the `≈` in the table above is the right symbol —
> the gap is five triggers, not two.

**Where ours is ahead:** `ASK_QUESTION` normalises Arabic-Indic digits and
stores phone answers digits-only to match the inbound path; the field is
resolved through `CustomFieldDefinition` so a workflow cannot write an arbitrary
column (D-31); and the re-ask goes through the consent-checked sender (D-30).

**Their limits are worth adopting wholesale** — every one is a considered
number and ours are mostly absent.

---

## 06 · AI Agents

`✗` **Nothing.** Ours is plan limits on `ai_tokens_in/out` with no feature
behind them.

Theirs: multilingual agents; image, file, audio, channel and ad context;
Knowledge Sources; Receptionist / Support / Sales / custom agents; prompt
templates; and agent actions for contact update, close, assign, follow-up,
comment, workflow and tags. Plus AI Assist and AI Prompts in the composer, and
AI summarisation on two paths with different caps (100 messages manual, 20
agent).

**Their documented hazards, which are the useful part:**
- *"Explicitly instruct AI Agent to stop responding after assignment"* — or it
  keeps replying after handoff.
- AI agents can only choose from **existing** closing notes.
- The AI Objective step is **legacy and will be removed**.
- **Their trust boundary is drawn backwards** — the customer-facing agent is
  locked down while the internal staff composer is unrestricted.

**Blocker on our side is structural:** the executor is a `switch`, so every
safety property is per-`case`. Fix that before adding AI or the first AI action
ships D-30 and D-31 again.

---

## 07 · Broadcasts

| | Theirs | Ours |
|---|---|---|
| Statuses | Draft · Scheduled · In Progress · Completed · Failed | `✓` DRAFT · SCHEDULED · SENDING · SENT · FAILED |
| Cancel | Scheduled → Draft; **In Progress cannot be cancelled** | `≈` |
| Delete | Draft only | `≈` |
| **Clone** | Channel, audience, content and time copied | `✓` M8.5 — ours re-resolves the audience, theirs copies it |
| Audience | A segment; **no segment = not sent** | `≈` null filter = everyone, now behind `confirmAllContacts` |
| Labels | Set at creation | `✗` |
| Scheduling | Immediate or future; calendar view | `✓` both |
| Timezone of a scheduled send | **NOT DETERMINED in their docs** | `★` ours is explicit |
| Quota behaviour | **All-or-nothing, pre-flight** | `✓` same |
| Send rate | Custom rate is a **paid add-on** | `★` ours is plan-resolved and free |
| **Quiet hours** | None | `★` **M8.4 — recipient-local, ours only** |
| Metrics | Completed, Failed, Recipients, Sent, Delivered, Read, Failed | `✓` |
| **Reply rate** | None — *"something a customer builds with a workflow"* | `★` **native** |
| Failure reasons | Enumerated, broadcast and message level | `≈` |
| Resend failed | No one-click; export → re-import → re-segment | `≈` same |
| **Opt-out** | **None. NOT DETERMINED.** Unsubscribe is a workflow template | `★★` **unconditional platform rule** |

---

## 08 · WhatsApp-specific

| | Theirs | Ours |
|---|---|---|
| 24-hour service window | Composer blocked; template required | `✓` enforced before Meta is called |
| Template categories | Utility / Authentication / Marketing | `≈` |
| Template component limits | Body 1,024 · buttons 1 URL, 1 phone, 3 quick-reply ≤20 chars | `✗` |
| Template edit limits | 10 per 30 days, 1 per 24h on approved | `✗` |
| **Nine template statuses** | Processing, In Review, Approved, Rejected, Flagged, Paused, Disabled, Appeal, Reinstated | `★` ours requires `APPROVED` and **fails closed on all others** — handles nine without enumerating them |
| Quality rating | High / Medium / Low + Restricted | `✗` |
| **Messaging tier limit** | 250 → 2K → 10K → 100K → unlimited **per rolling 24h**, business-initiated only; limits only go up | `✓` **enforced** since `1f652be7` — `maxUniqueRecipientsPer24h` is read from the published capability and refuses in `sendMetaTemplate`, counting distinct recipients with `releasedAt: null`. The ladder's second rung is disputed; see §13 and HANDOVER §6 |
| **Unverified cap** | **250 unique contacts per broadcast** — a different denominator, lifted by business verification rather than by tier | `✗` **still a hard ceiling on P12 that nothing mentions.** Modelled nowhere. Enforcing the tier limit above does **not** cover it, and the two were previously one row here, which is how they came to be read as one cap |
| Product paths | API · Coexistence · Cloud API | `≈` OpenWA + Cloud API modelled |

---

## 09 · Reports

Theirs: **11 tabs.** Ours: one page with overview, first-response, resolution,
volume, hourly heatmap, team performance, campaign performance, gateway,
closures.

| Tab | Ours |
|---|---|
| Lifecycle funnel | `✓` shipped in `554ab792`. A **distribution**, not a cumulative funnel — a contact holds one stage and no history is kept, so step-to-step rates would be fabricated. The won stage over the period's intake is the one honest conversion figure |
| **Closures** | `✓` shipped in `2b34e99c` — named in the prose above but missing from this table. `★` no counterpart of theirs; category, source and summary coverage, every breakdown reconciling to the total |
| Calls | `—` |
| Conversations | `✓` |
| Responses | `≈` we have first-response; theirs adds assignment-to-response |
| **Resolutions** | `≈` we have resolution time; not the tab |
| Messages | `✓` |
| Contacts | `≈` |
| **Assignments** | `✗` |
| **Leaderboard** | `✗` |
| **Users** | `≈` team performance, not per-user |
| Broadcasts | `✓` |

**Their counting rules worth adopting verbatim:**
- Resolutions is *"based only on closed conversations"*.
- *"Unassignment will also be counted as an assignment."*
- Users *"only displays users who have closed at least one conversation"*.
- 10,000-row cap, stated on every tab.

**UI rule:** state each tab's exclusions **on the tab**. Their Responses tab
silently excludes workflow responses *and* open conversations, which changes
every number on it.

Ours already exports **SVG, PNG and CSV** (M9.3) — matching theirs exactly.

---

## 10 · Workspace and organisation settings

**A note on the word, added 2026-09-03.** This section was written when this
product used "workspace" to mean the organization. It no longer does: the
interface says *organization* for the tenant and *workspace* for the division
inside it, matching the schema. The headings below keep their original wording
and mean the ORGANIZATION; the new sub-unit is §10.1.

Their workspace settings index lists **18** articles. Ours has 10 screens.

| Setting | Theirs | Ours |
|---|---|---|
| General info | Inactivity timeout 1–60 min · timezone · weekly recap | `✓` `/settings/general` + **quiet hours (ours only)** |
| Users | Add, revoke, edit, CSV export | `✓` `/settings/users` |
| Teams | **Max 200; one team per user** | `≈` ours allows many teams per user |
| Channels | *"Only Owners can connect Channels"* | `✓` `/settings/channels` |
| Integrations | Developer API, Dialogflow, Zapier, Make, Sheets | `✗` **none** |
| Growth Widgets | Embeddable, campaign attribution, branding toggle | `≈` the **chat-link** type ships with first-touch attribution, gated at 17/17 by `test:growth-widgets`; embeddable widgets and the branding toggle are absent, and the **multichannel** type stays `—`; see below |
| Contact Fields | 8 types, visibility, Owner-only delete | `✓` |
| Lifecycle | 20 max, default, reorder | `✓` |
| Conversations | Auto-close, closing notes, categories, mention toggle | `✓` |
| Snippets | Caps | `✓` (no caps) |
| **Workspaces** (sub-unit) | Multiple workspaces per account, member management, per-workspace settings | `≈` **shipped 2026-09-03** — see §10.1 |
| Tags | | `✓` |
| AI Assist / AI Prompts | Knowledge, persona, 4 custom prompts | `✗` |
| Calls | Recording mode | `—` |
| **Files** | 20 MB platform cap; per-channel caps published | `✓` `components/settings/file-limits.tsx` surfaces the accepted sizes |
| Contacts import | | `✓` |
| **Data Export** | Separate module, 4 types, 365-day range | `✗` |
| Notifications | | `★` ours has a dedicated screen |
| Meta templates | | `★` ours has a dedicated screen |

**Growth Widgets, and the one sub-type that is not a gap.** Respond.io names
four classes — single-channel, multichannel, QR code, chat link — and their own
documentation never enumerates the full catalogue, so there is no published list
to be measured against.

**Corrected 2026-09-03.** The paragraph above said the row stays `✗` because we
had no widget model, no `sourceUrl`, no referrer and no attribution field on
`Contact`. All four now exist: `GrowthWidget`, `WidgetClick` carrying landing
page and referrer, and four `acquisition*` columns on `Contact`, gated at 17/17
by `test:growth-widgets`. The row is `≈` — the chat-link type ships, embeddable
widgets and the branding toggle do not.

**Multichannel is `—`, the seventh deliberate non-build.** It is not deferred,
it is inapplicable. Our channel set is WhatsApp on two transports — `OPENWA` and
`WHATSAPP_CLOUD`, with `allowedChannels` defaulting to `["OPENWA"]` — and the
channel switcher in §02 is already `—` *single channel by design*. A multichannel
widget is a picker offering channels we have decided not to have. Building it
would mean either shipping a chooser with one option, or acquiring channels to
justify a widget, which is the tail wagging the dog.

The other three classes remain real gaps, and they are not equal. A **chat link**
is the cheapest thing that carries real attribution and works identically on both
transports, because the pre-filled text rides in the message body. A **QR code**
is a rendering of the same primitive. The **embeddable single-channel widget** is
by far the largest and the least reversible — a script tag on someone else's page
cannot be recalled, versioned unilaterally, or fixed for whoever cached it.

**Organisation settings** — theirs has 8 pages across a two-level org/workspace
model with 4 org roles. Ours has a **platform-owner console** (`/platform/*`:
subscribers, editions, finance, operations, staff, data, legal, support,
settings) which is a *different and arguably better* shape: they separate
org-from-workspace, we separate platform-owner-from-tenant.

**Their own gap:** *"No audit log is documented anywhere."* `★` **We have
`AuditLog` and `PlatformAuditLog`, and the tenancy gate asserts platform-scope
writes produce a durable audit row.**

---

### 10.1 · Workspaces — what shipped and what is deferred

Was `✗` until 2026-09-03. It is `≈` now rather than `✓`: the model and the
isolation are real and enforced at the database, and four things a subscriber
would expect are deliberately not built yet.

**Shipped.**

| | |
|---|---|
| Model | `Workspace` and `WorkspaceMember`, one default per organization, enforced by a partial unique index |
| Isolation | `workspaceId` is a third key column on `WhatsappSession`, `Contact`, `Conversation`, `Message`; composite foreign keys carry both keys, so cross-workspace reference is unrepresentable rather than merely unwritten |
| Contact identity | The same phone number in two workspaces is two contacts, sharing no tags, consent or history |
| Switcher | In the shell, driven by a validated claim in the session token — never a header or a query parameter. Absent entirely when there is one workspace and no room for another |
| Plan gating | `maxWorkspaces` on `Plan`, resolved through `resolveEntitlements`, so a platform-owner override moves it for free. **BUSINESS 5, ENTERPRISE unlimited**, everything below 1. The refusal is **402**, not 403 — the caller is permitted, the plan refuses |
| Certification | 36 of 36: 375/768/1440 × ar/he/en × light/dark, asserting both that switching changes what you see and that the control is absent when there is nothing to switch to |

**Deferred, as decisions rather than omissions.**

| | |
|---|---|
| Member management UI | Who is in which workspace, and adding or removing them. Memberships exist and are enforced; nothing surfaces them |
| Per-workspace settings | Every setting is organization-wide today |
| Moving data between workspaces | The hardest of the four: a contact carries consent and history that do not obviously travel with it |
| Downgrade behaviour | **Decided, not built.** A BUSINESS subscriber dropping to GROWTH keeps their workspaces; the non-default ones become read-only; the billing screen names exactly which and why. Blocking the downgrade traps a customer in a tier they want to leave, deleting data is unthinkable, and silent read-only is the worst of the three |

## 11 · Roles and permissions

| | Theirs | Ours |
|---|---|---|
| Workspace roles | Owner · Manager · Agent (3) | `★` ADMIN · SUPERVISOR · AGENT · VIEWER · FINANCE (5) |
| Org roles | Admin · Billing Admin · User Admin · Member | `≈` platform OWNER + staff scopes |
| Restrictions | 7 (API enum) | **6 of 7**, and the seventh is moot — `restrict_calls`, against a Calls module we deliberately do not build. All six that apply are enforced in `rbac.middleware.ts` and gated by `test:restrictions` |
| `restrict_data_export` | ✓ | `✓` |
| `restrict_contact_deletion` | ✓ | `✓` |
| `restrict_space_setting` | ✓ | `✓` |
| `show_team_contacts` / `show_only_mine` | ✓ | `✓` `contactVisibilityScope` |
| `restrict_shortcuts` | ✓ | `✓` `restrictWorkflows` |
| `restrict_space_integration` | ✓ | `✓` `restrictIntegrations` in `rbac.middleware.ts`, gated by `test:restrictions` |
| Mask phone/email | Advanced+ only | `★` ours is not plan-gated |
| **Cannot edit own access** | Stated rule | `✓` added 1 Sep after reading their docs |
| Collaborator overrides visibility | Explicit | `✓` `lib/user-access.ts` — being a collaborator grants visibility whatever the restriction says, and it is a code path rather than a comment |

---

## 12 · Plans and billing

| | Theirs | Ours |
|---|---|---|
| Tiers | Starter · Growth · Advanced · Enterprise | `✓` FREE · STANDARD · GROWTH · BUSINESS · ENTERPRISE |
| Model | **Capabilities withheld** on Starter; MAC unlimited | `≈` ours withholds volume, keeps capabilities |
| MAC definition | Send or receive a message **excluding broadcasts** | `✗` **ours counts broadcasts — see below** |
| Overage | MAC on-demand $12–15/100; AI credits with **200% hard cap** | `✗` |
| Users | Genuine quota with per-seat overage | `≈` seat limits, no overage |
| Trial | 7 days, Growth, 5 users, 1,000 MAC, **except broadcasts** | `≈` ours is time-based on STANDARD |
| Editions as data | Not documented | `★` ours are rows, editable, schedulable, archivable |

### The one place they are right and we are wrong

`entitlements.ts:333` records an `active_contacts` event on **every** outbound
including campaigns. So:

1. A broadcast to 1,000 contacts makes all 1,000 billable. Theirs makes none.
2. `entitlements.ts:318` asserts `active_contacts` availability for a
   not-yet-active contact — so **a subscriber at their MAC ceiling cannot
   broadcast at all**, even with campaign sends remaining.

Also: **blocking should remove a contact from MAC** (theirs does; ours does not).

A pricing decision currently made by an implementation detail. Settle it before
the first paying customer, because changing it afterwards changes bills.

---

## 13 · Developer platform

**Was** the largest structural gap. **P1 closed most of it** — see
[PUBLIC-API.md](PUBLIC-API.md). Status below is against the shipped surface.

| | Theirs | Ours | |
|---|---|---|---|
| API | `api.respond.io/v2`, 24 operations, 5 services | `/api/v1`, **24 operations** | `✓` |
| Auth | Bearer, max 10 tokens/workspace, workspace-wide, **no expiry or scoping** | Bearer, 20 tokens, **scoped + expiring + revocable**, masking inherited from creator | `★` |
| Identifiers | `id:` `email:` `phone:` | Same grammar, prefix required | `✓` |
| Listing | `POST /contact/list`, 13 operators | `POST /contacts/list`, our richer DSL | `★` |
| Rate limit | **Unsettled — their own docs give three answers.** Their prose says the limit is *organization-level*; the section below it says *per method + path*; and every OpenAPI 429 example shows `X-RateLimit-Limit: 10`, not 5. Nothing here reconciles them | **5/s per method + path, plus a 600/min per-credential backstop.** Asserted, not inferred — this is what the middleware does | `—` **no parity claim.** A `✓` here would assert we matched a number that may not be theirs |
| Pagination | Cursor; default 10, max 100 (50 messages) | Same, messages capped at 50 | `✓` |
| Errors | …/429/**449**/500/502/504 | 449 `workspace_provisioning`, with Retry-After | `✓` |
| Webhooks | **11 events** on their developer hub; their help centre lists **10**, omitting Lifecycle Updated. Taking 11: the developer hub is the API reference and the help centre is a written-for-humans subset, so an omission there is the likelier error than an invention here. Plus HMAC-SHA256, retries 30/60/90s, auto-off 30 errors/30 min, **35 endpoints/org** | 11 events, HMAC **over timestamp+body**, same retries, same auto-off, 35 endpoints | `★` signing |
| Webhook delivery log | **None — open feature request against them** | Full log: status, latency, attempt, response body, test button | `★` |
| SDK | `@respond-io/typescript-sdk` | — | `✗` |
| MCP | Self-hosted + hosted | — | `✗` |
| Custom channel | Inbound + outbound contract | — | `✗` |

**What does not exist on their side either:** no broadcasts API, no workflows
API, no teams API, no AI-agent REST API, no contact-events API, no conversation
object endpoint.

**Their own flagged gaps we should not copy:** no token expiry, rotation,
revocation or scoping; no webhook event log; no API versioning policy.

---

## Summary — counted

| Verdict | Count | |
|---|---|---|
| `★` **We are ahead** | **26** | consent, empty-segment refusal, auto-close gating, thread-preserving reopen, reply metrics, quiet hours, audit logs, editions-as-data, 5 roles, richer filter DSL, digits-only phone storage, tag provenance, opt-out surviving import, template fail-closed, lifecycle inboxes, category rename, free send rates, explicit schedule timezone, notifications screen, Meta templates screen, composite tenant FKs |
| `✓` Match | **73** | re-derived 2026-09-03 |
| `≈` Partial | **53** | re-derived 2026-09-03 |
| `✗` Absent | **34** | re-derived 2026-09-03 |
| `—` Deliberate | 7 | calls, tasks, channel switcher, Chats/Calls tabs, one-team-per-user, AI Objective, **multichannel growth widgets** |

**The absent set concentrates in four places:** the developer platform (13),
workflows (17 triggers and steps), AI (all of 06), and reporting tabs (4).
Everything else is small and cumulative.

**Counts after the 2026-09-03 audit.** A row's verdict is its **first** marker;
some rows quote a second one in their explanation, and prose outside tables
quotes them constantly, so both a whole-file count and a naive per-row count
overstate. This is the command that matches how the document is actually read:

    awk -F'`' '/^\|/{for(i=2;i<NF;i+=2){if($i=="✓"||$i=="≈"||$i=="✗"||$i=="★"||$i=="—"){c[$i]++;break}}}
      END{printf "✓%d ≈%d ✗%d ★%d —%d\n",c["✓"],c["≈"],c["✗"],c["★"],c["—"]}' docs/RESPONDIO-PARITY-MATRIX.md

**✓73 ≈53 ✗34 ★26 —7**, against **✓65 ≈52 ✗43 ★26 —7** before the audit began.

**Nine rows left `✗` across both passes** — eight in the first, one in the
second — every one of them because the work had already shipped. Nothing was
rescored, no standard was relaxed, and no row moved on an argument rather than
on a file.

Getting this number right took three attempts, which is itself worth recording:
the first count included prose outside tables, the second included second
markers inside table cells, and the third was skewed by a marker in a status
row this very audit had added. A count whose method is unstated is the same
defect as a row whose evidence is unstated — and a method stated loosely fails
the same way.

Three of the four concentrations — workflows, AI, the developer platform — sit
in sections this audit did NOT check. Those numbers should be read as the last
figure somebody wrote down rather than as a current measurement.

**One movement on 2026-09-03.** Workspaces went `✗ → ≈`, so `✗` drops by one
and `≈` gains one. `≈` rather than `✓` on purpose: the model, the isolation,
the switcher and the plan gate are shipped and certified, and member management,
per-workspace settings, moving data between workspaces and the downgrade
behaviour are not. The last of those is decided and written down — see §10.1 —
which makes it a deferral rather than a gap, but it is still not built and the
matrix should not imply otherwise.

**Two corrections on 2026-09-02, and the arithmetic follows them.** §03's
opening-sources row moved `≈ → ✗` — it claimed three of eight when there is no
`openingSource` column at all, so `≈` drops by one and `✗` gains one. And
multichannel growth widgets became the seventh `—`: inapplicable rather than
missing, for the same reason the channel switcher already was. The Growth
Widgets row in §10 said `✗` because the module as a whole was absent — **that
sentence was already wrong when it was written on 2026-09-02**, since the
chat-link slice had shipped, and it survived a documentation commit the
following day that noticed the staleness and deliberately left it. The row is
`≈` as of the 2026-09-03 audit.
