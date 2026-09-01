# Respond.io parity — the complete matrix

**Every module, every capability, nothing skipped.** The companion to
[RESPONDIO-PARITY-ROADMAP.md](RESPONDIO-PARITY-ROADMAP.md), which sequences the
work; this one is the exhaustive inventory it was sequenced from.

Compiled 1 September 2026 from `respond-io-as-documented.md` — a survey of ~130
first-party Respond.io pages plus their OpenAPI 3.0 specification — checked
against this codebase at the enforcement point.

**Legend**
`✓` we have it · `≈` partial, gap named · `✗` absent · `★` **we are ahead** ·
`—` deliberately not building

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
| Upcoming Broadcasts | Name, channel, scheduled time | `✗` |

**Their documented trap, worth copying the awareness of:** the Dashboard counts
assigned contacts differently from the Inbox — *it includes blocked contacts
while the Inbox does not*. Ours must not repeat that now that M9.1 exists.

**Gap:** Team Members widget, Upcoming Broadcasts widget, merge suggestions on
the dashboard, duration sorting.
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
| **Blocked Contacts Inbox** | A first-class inbox | `✗` **we block with nowhere to see it** |
| Lifecycle as inbox | *"Lifecycle does not create a separate inbox"* | `★` **ours does** — lifecycle queues in the selector |

**Custom inbox visibility:** theirs is Private (default) / Public / Shared with
named users or teams. Ours is private/shared. **Gap: per-user and per-team
sharing.**

### Conversation list

| | Theirs | Ours |
|---|---|---|
| Status filters | All, Open, Closed, Snoozed | `✓` plus PENDING and AWAITING_CLIENT |
| **Unreplied toggle** | Conversations lacking a team response | `✗` |
| Sorts | Newest, Oldest, Longest, Shortest (per state) | `≈` newest-first only |
| Row indicators | Status, channel icon, unread count, direction arrow (blue out / orange in) | `≈` no directional colour coding |
| Unread expiry | Cached; expires after **90 days** inactivity | `✗` n/a |
| Quick actions | Close · Close with notes · Snooze · Shortcuts · Assign · Collaborators · Lifecycle | `≈` missing Shortcuts and Collaborators |

**Gap:** Unreplied toggle, the four sort modes, Shortcuts, Collaborators.
**Size:** ~3 days without Shortcuts (which needs P2).

### Conversation window

| | Theirs | Ours |
|---|---|---|
| Typing indicators | WhatsApp, TikTok, Telegram | `✗` |
| Per-message actions | Copy, Copy link, Translate, Reply, Reply with AI Assist | `≈` no copy-link, no translate |
| Audio transcription | Yes | `✗` (P7) |
| Delivery status | Sent / Delivered / Read / Failed | `✓` |
| Link previews | Supported channels | `✗` |
| Channel switcher | Yes | `—` single channel by design |

### Contact details pane

| | Theirs | Ours |
|---|---|---|
| Tabs | Contact details · Call activities · Activities · HubSpot · Salesforce · Attachments | `≈` details, conversations, files, activity |
| Fields shown | Phone, email, country, language | `✓` plus custom fields, tags, consent + provenance, block |
| Merge suggestion card | Inline in the pane | `✗` |
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
| **Collaborators** | Up to **9**; can do everything the assignee can; own inbox; added by button, quick action, or @mention when a workspace setting allows | `✗` **the largest inbox gap** |
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
| Opening sources | 8: User, Contact, Workflow, API, Zapier, Make, Paid Ads, Growth Widget | `≈` Contact, Workflow, User — no API/Zapier/Make/Ads/Widget |
| Closing sources | 8–9 incl. Bot, AI Agent, n8n, **Blocked** | `✓` MANUAL, AUTO_CLOSE, WORKFLOW, API, MERGE |
| Merge/delete do **not** close | Explicit non-fire rule | `✓` same |
| Auto-close config | Default 24h · min 30 min · max 14 days | `✓` min 30 / max 20160 |
| **Auto-close timer rules** | Starts on last human outbound; resets on another human; cancelled by contact reply; **broadcasts, workflows and AI do not start or reset it** | `★` **identical, and gated** — the tenancy harness asserts *"only a human customer-facing send arms the auto-close timer"* |
| Snooze | Absolute dates (inferred); no snooze trigger | `★` ours cancels on customer reply, gated by `test:snooze` |
| Reopening | *Appears* to create a **new** conversation — their own doc calls this "the single largest gap in the documented conversation model" | `★` ours reuses the thread, preserves history, and as of M9.2b drops an assignee who can no longer receive it |
| Closing notes | Category + summary, three enforcement modes | `✓` the same three |
| Default categories | General Inquiry, Sales Inquiry, Payment Issue, Others | `≈` tenant-defined |
| Category rename | **Cannot be renamed** — delete and recreate | `★` ours renames with a cascade |

**Gap:** opening sources we cannot record (API, Zapier, Make, Ads, Widget) —
all downstream of P1.

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

| | Theirs | Ours |
|---|---|---|
| **Triggers** | **11** | **5** |
| **Steps** | **19** | **10** |
| Conditions | 11 categories, 18 operators | 6 |
| Branches | **9 + Else**, conditions 10 per branch | 1 level, `IF_ELSE` |
| Steps per workflow | 100 | 20 actions |
| Workflows per workspace | 150 | plan-gated |
| Total execution time | **7 days** | unbounded |
| Draft / Published / Stopped | Editing requires stopped; enrolled contacts ejected on stop | `≈` active/inactive only |
| Re-entry | *"A Contact cannot re-enter a Workflow they are currently enrolled in"* | `≈` 60-second window — **but `ASK_QUESTION` can hold a run open for 7 days** |
| Testing | Built in | `✗` |
| Import/export | 100 steps, ≤400 KB | `✗` |
| Templates | 31 pre-built | `✗` |

**Missing triggers:** Lifecycle Updated · Contact Field Updated · Shortcut ·
Incoming Webhook · Manual Trigger · Click-to-Chat Ads · TikTok Ads · Call Ended.

**Missing steps:** Jump To · Trigger Another Workflow · Add Comment · Open
Conversation · Close-with-category · Google Sheets · Meta CAPI · TikTok events ·
Date & Time as a *step* (ours is a condition only).

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
| **Messaging tiers** | 250 → 2K → 10K → 100K → unlimited per 24h; limits only go up | `✗` **not modelled** |
| Unverified cap | **250 unique contacts per broadcast** | `✗` **a hard ceiling on P12 nothing here mentions** |
| Product paths | API · Coexistence · Cloud API | `≈` OpenWA + Cloud API modelled |

---

## 09 · Reports

Theirs: **11 tabs.** Ours: one page with overview, first-response, resolution,
volume, hourly heatmap, team performance, campaign performance, gateway,
closures.

| Tab | Ours |
|---|---|
| Lifecycle funnel | `✗` |
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

Their workspace settings index lists **18** articles. Ours has 10 screens.

| Setting | Theirs | Ours |
|---|---|---|
| General info | Inactivity timeout 1–60 min · timezone · weekly recap | `✓` `/settings/general` + **quiet hours (ours only)** |
| Users | Add, revoke, edit, CSV export | `✓` `/settings/users` |
| Teams | **Max 200; one team per user** | `≈` ours allows many teams per user |
| Channels | *"Only Owners can connect Channels"* | `✓` `/settings/channels` |
| Integrations | Developer API, Dialogflow, Zapier, Make, Sheets | `✗` **none** |
| Growth Widgets | Embeddable, campaign attribution, branding toggle | `✗` |
| Contact Fields | 8 types, visibility, Owner-only delete | `✓` |
| Lifecycle | 20 max, default, reorder | `✓` |
| Conversations | Auto-close, closing notes, categories, mention toggle | `✓` |
| Snippets | Caps | `✓` (no caps) |
| Tags | | `✓` |
| AI Assist / AI Prompts | Knowledge, persona, 4 custom prompts | `✗` |
| Calls | Recording mode | `—` |
| **Files** | 20 MB platform cap; per-channel caps published | `✗` **not surfaced** |
| Contacts import | | `✓` |
| **Data Export** | Separate module, 4 types, 365-day range | `✗` |
| Notifications | | `★` ours has a dedicated screen |
| Meta templates | | `★` ours has a dedicated screen |

**Organisation settings** — theirs has 8 pages across a two-level org/workspace
model with 4 org roles. Ours has a **platform-owner console** (`/platform/*`:
subscribers, editions, finance, operations, staff, data, legal, support,
settings) which is a *different and arguably better* shape: they separate
org-from-workspace, we separate platform-owner-from-tenant.

**Their own gap:** *"No audit log is documented anywhere."* `★` **We have
`AuditLog` and `PlatformAuditLog`, and the tenancy gate asserts platform-scope
writes produce a durable audit row.**

---

## 11 · Roles and permissions

| | Theirs | Ours |
|---|---|---|
| Workspace roles | Owner · Manager · Agent (3) | `★` ADMIN · SUPERVISOR · AGENT · VIEWER · FINANCE (5) |
| Org roles | Admin · Billing Admin · User Admin · Member | `≈` platform OWNER + staff scopes |
| Restrictions | 7 (API enum) | **6 of 7** as of M8.1 |
| `restrict_data_export` | ✓ | `✓` |
| `restrict_contact_deletion` | ✓ | `✓` |
| `restrict_space_setting` | ✓ | `✓` |
| `show_team_contacts` / `show_only_mine` | ✓ | `✓` `contactVisibilityScope` |
| `restrict_shortcuts` | ✓ | `✓` `restrictWorkflows` |
| `restrict_space_integration` | ✓ | `✗` **withheld — no route here can enforce it** |
| Mask phone/email | Advanced+ only | `★` ours is not plan-gated |
| **Cannot edit own access** | Stated rule | `✓` added 1 Sep after reading their docs |
| Collaborator overrides visibility | Explicit | `✗` (needs collaborators) |

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
| Rate limit | **5 req/s per method + path** | 5/s per method+path, + a 600/min backstop | `✓` |
| Pagination | Cursor; default 10, max 100 (50 messages) | Same, messages capped at 50 | `✓` |
| Errors | …/429/**449**/500/502/504 | 449 `workspace_provisioning`, with Retry-After | `✓` |
| Webhooks | 11 events, HMAC-SHA256, retries 30/60/90s, auto-off 30 errors/30 min, **35 endpoints/org** | 11 events, HMAC **over timestamp+body**, same retries, same auto-off, 35 endpoints | `★` signing |
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
| `★` **We are ahead** | **21** | consent, empty-segment refusal, auto-close gating, thread-preserving reopen, reply metrics, quiet hours, audit logs, editions-as-data, 5 roles, richer filter DSL, digits-only phone storage, tag provenance, opt-out surviving import, template fail-closed, lifecycle inboxes, category rename, free send rates, explicit schedule timezone, notifications screen, Meta templates screen, composite tenant FKs |
| `✓` Match | ~45 | |
| `≈` Partial | ~40 | |
| `✗` Absent | ~35 | |
| `—` Deliberate | 6 | calls, tasks, channel switcher, Chats/Calls tabs, one-team-per-user, AI Objective |

**The absent set concentrates in four places:** the developer platform (13),
workflows (17 triggers and steps), AI (all of 06), and reporting tabs (4).
Everything else is small and cumulative.
