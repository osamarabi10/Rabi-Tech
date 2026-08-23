# UI surface map

Where things are, and which of them carry a rule you can break by accident.

Written at the end of the U1–U8 UI phases (see [UI-PHASES.md](UI-PHASES.md) for
what each phase changed and why). This is a map, not a changelog: it describes
the surface as it stands, and flags the places where the obvious edit is the
wrong one.

---

## Routes

`apps/frontend/app`

### Tenant

| Route | What it is |
|---|---|
| `/(auth)/login` | Sign-in. |
| `/(dashboard)` | Redirects into the default landing surface. |
| `/(dashboard)/overview` | Workspace summary. |
| `/(dashboard)/inbox` | The four-pane conversation workspace. The largest single file in the app. |
| `/(dashboard)/contacts` | Contact list, filters, segments. |
| `/(dashboard)/contacts/import` | CSV import with a consent declaration step. |
| `/(dashboard)/campaigns` | Broadcasts. Plan-gated; on Free the page renders the upgrade gate. |
| `/(dashboard)/automations` | Workflow list and builder. |
| `/(dashboard)/templates` | Message templates. |
| `/(dashboard)/reports` | Analytics, with drill-down into the conversations behind a number. |
| `/(dashboard)/users` | Workspace members. |
| `/(dashboard)/billing` | Plan and usage for the subscriber. |
| `/(dashboard)/settings` | Eleven anchored sections in one scroll, with a sticky sub-navigation. |
| `/(dashboard)/settings/lifecycle` | Lifecycle stage editor — a route of its own, linked from the sub-nav. |

### Public and platform

| Route | What it is |
|---|---|
| `/signup`, `/verify-email`, `/pricing` | Self-serve entry. |
| `/checkout-success`, `/checkout-cancel`, `/contact-us-to-activate` | Billing return paths. |
| `/platform/subscribers` | The platform-owner console. Requires a platform session; a tenant admin gets 403 from every route behind it. |

---

## Components that carry a rule

Everything under `components/ui` is shadcn primitives and is not listed. The
ones below either encode a decision or are easy to undo by accident.

### Inbox

| File | The rule |
|---|---|
| `inbox/inbox-selector.tsx` | Pane 1: scope, and the only always-visible gateway state on a wide screen. Counts come from the conversations actually loaded — exact today because the list endpoint has no pagination, and documented in the file as the thing that must move server-side when it gains any. |
| `inbox/inbox-scope-menu.tsx` | The same scopes and the same counting for screens below `lg`, where pane 1 is hidden, plus `GatewayNotice`. Not a duplicate: without it those scopes exist on desktop only. |
| `inbox/composer-readiness.tsx` | Whether this conversation can be replied to, stated before the agent types. Readiness is per session, never averaged across a multi-number workspace. `unknown` renders nothing — failing to identify a channel is not the same as knowing it is down. |
| `inbox/conversation-list-states.tsx` | Why the list is empty: no channel, nothing yet, or nothing matching. The filter is checked first — server-side search replaces the loaded list, so any other order tells an agent staring at their own search term that their workspace is empty. |
| `inbox/contact-context-tabs.tsx` | Details / Files / Activity. Automated events are hollow dots, not a colour difference. |
| `inbox/custom-fields-section.tsx` | The tenant's own contact fields, editable in the panel. Saves per field on blur — there is no form to submit, and one distant Save button is how edits get lost. Renders nothing when no fields are configured. |
| `inbox/contact-conversations-tab.tsx` | Every thread this contact has had, resolved ones included — they hold the answers and the inbox default filter hides them. Status colour comes from `STATUS_CONFIG`, not invented `text-status-*` classes, which Tailwind does not generate. |
| `inbox/consent-provenance.tsx` | Where a consent value came from. Distinguishes a recorded change, a value predating the history table, and never recorded — and renders nothing while loading, because "no source recorded" is a claim about the data. |
| `inbox/contact-panel.tsx`, `conversation-list.tsx`, `composer.tsx`, `lifecycle-select.tsx` | The rest of panes 2 and 4. |

### Settings and shell

| File | The rule |
|---|---|
| `settings/settings-sub-navigation.tsx` | Numbered sticky sub-nav with scroll-spy. The spy reads the real scroll parent, found by walking up for a computed `overflow-y`, because the sections scroll inside a container and an IntersectionObserver against the viewport marks nothing. |
| `permission-notice.tsx` | What a control looks like when you are not allowed to use it. Replaces rendering nothing, which is indistinguishable from an empty card or an ungranted feature. Grants nothing: the server enforces the same rule regardless. |
| `status-badge.tsx`, `color-pill.tsx` | Chips in a colour the palette does not own. Both go through `lib/tint.ts`. |
| `upgrade-gate.tsx` | The plan wall. |

### Platform console

| File | The rule |
|---|---|
| `platform/finance-document-table.tsx` | Invoices and receipts in one table. Downloads go through the api client, not an `<a href>`: the platform token lives in a header and a bare link downloads the 401 body as a file. |
| `platform/commercial-terms-dialog.tsx` | Plan override, quota, discount, credit. |
| `platform/gateway-health.tsx` | Per-subscriber gateway state. |

---

## lib modules with a trap in them

| Module | What to know |
|---|---|
| `lib/utils.ts` | `cn()` is `twMerge` **extended** with the role type scale (`text-caption`, `text-micro`, …). Those are plain CSS classes, not Tailwind theme sizes, and without the extension tailwind-merge treats `cn('text-caption', 'text-primary')` as one conflict and silently drops the size. Adding a role to the scale means adding it here too. |
| `lib/tint.ts` | How an arbitrary colour becomes a chip. Never concatenate alpha onto a colour string — `hsl(var(--x))20` is invalid CSS and fails silently. Theme-aware tokens and fixed hexes need opposite treatment; the file explains both. |
| `lib/gateway-state.ts` | The gateway's five states and what each one costs the workspace. Shared by the rail and the mobile notice so they cannot drift. |
| `lib/i18n.tsx` | Arabic source strings are the dictionary keys. A missing key falls back to its key, which keeps the UI working and hides the failure — hence `check:i18n`. |
| `lib/data.ts` | Every API call and type. Also `UNKNOWN_CONTACT` and `contactDisplayName()`: the placeholder for a nameless contact is produced here, where there is no `t()`, so display sites translate it. |

---

## Checks

Run from `apps/frontend`:

```bash
npm run check:i18n
```

Every literal `t()` key is translated in Hebrew and English; no duplicate keys,
no blank translations. Literals only — `t(someVariable)` is resolved at runtime
and a static check would have to guess.

```bash
npm run check:mojibake
```

Arabic or Hebrew that was decoded as Latin-1 somewhere and written back as
UTF-8 (`Ø¬Ù‡Ø§Øª Ø§Ù„Ø§ØªØµØ§Ù„`). Valid UTF-8, so nothing else complains,
and unreadable to the person it is shown to.

From `apps/backend`:

```bash
npm run test:tenancy
```

The isolation gate. Must stay green; treat red as a release blocker.

```bash
npm run test:finance
```

The platform finance ledger against the real database — builds first, because
it exercises the compiled output the server actually runs, and deletes
everything it creates on the way out.

---

## Conventions that are load-bearing

- **Logical properties only.** `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`,
  `text-start`. No `left`/`right` in new code — the interface is RTL in two of
  its three languages. Note that `inset-inline-0` reads like a logical property
  and is **not** a class Tailwind generates; use `start-0 end-0`.
- **`dir="ltr"` on numbers only.** Phone numbers, money, dates and numeric
  inputs render LTR inside an RTL interface. Never on a container.
- **Contrast is measured, not eyeballed**, in both themes, against the surface
  the text actually sits on rather than against white. Palette tokens tuned for
  a button fill are usually too light as text on a tint of themselves; the
  overrides for that live in `app/globals.css`.
- **Tenant colours are deepened, never replaced.** A subscriber picked that
  colour. Mixing it toward black keeps their hue and makes it legible;
  substituting a palette colour defeats white-labelling.
