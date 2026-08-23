# Amarsail — design system, screen architecture, component specifications

Design system for **Amarsail**, which builds on and evolves the RabiTech
multi-tenant console rather than replacing it.

**Established before writing:**

- Amarsail is the Marasil-category product — multi-tenant, Arabic-first customer
  messaging, shipping Arabic / Hebrew / English, RTL as a primary layout mode.
  See [MARASIL-SPEC-FIT.md](MARASIL-SPEC-FIT.md).
- Phase 2 maps onto the **existing** four-pane inbox and console, not an
  abstract greenfield structure.
- The channel is an **unofficial gateway (OpenWA)**, not Meta Cloud API. So: QR
  pairing, permanent session-health surfacing, manual reconnect. No 24-hour
  service window, no template approval lifecycle.
- **Dark and light both ship at v1.** Agents sit in this for eight-hour shifts.
- **Two densities, one visual system** — a dense operator surface and a spacious
  configuration surface.

Every rule below that carries a "this shipped" note is describing a defect that
actually reached production in this codebase. They are the reason the rule
exists, and they are why it is phrased as a constraint rather than a preference.

---

# Phase 1 — Design system and brand identity

## 1. The rule the palette is built around

Every semantic colour ships **two values: a fill and a text**. A colour tuned to
carry white text as a button background is almost always too light to *be* text
on a tint of itself.

Not theoretical. The Marasil spec sets `text-tertiary` at `#8B95A1`, roughly
2.9:1 on white — it fails AA outright. In this codebase the same class of error
shipped three times: `--destructive` at 3.8:1 as text, `--warning` tuned against
white while every real use sat on a tinted panel, and a status chip at 4.29:1.

> **Law.** Contrast is measured against the surface the text actually sits on,
> in both themes. Never against white by default.

## 2. Colour

### 2.1 Brand

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | `#1A56DB` | `#5B8DEF` | Primary actions, active nav, focus |
| `--brand-text` | `#1749B8` | `#8FB4F5` | Brand colour used *as text* |
| `--brand-tint` | `#1A56DB @ 10%` | `#5B8DEF @ 16%` | Selected rows, active chips |
| `--accent` | `#0F766E` | `#3FBFB0` | Secondary emphasis |
| `--accent-text` | `#115E56` | `#6FD3C6` | Accent as text |

Cobalt over the category-default blue: deeper, holds up as text without a second
variant fighting it, and distinguishable from WhatsApp green in the same row.
Teal secondary rather than a warm accent — warm hues collide with the warning
state in a product where "waiting" and "overdue" are constant.

### 2.2 Neutrals — ink scale

| Token | Light | Dark |
|---|---|---|
| `--canvas` | `#F6F8FB` | `#0B1220` |
| `--surface` | `#FFFFFF` | `#121A2A` |
| `--surface-raised` | `#FFFFFF` | `#1A2436` |
| `--nav` | `#0F172A` | `#080D18` |
| `--border` | `#DFE4EC` | `#263043` |
| `--text` | `#0F172A` | `#E8EDF5` |
| `--text-muted` | `#54607A` | `#A3AFC2` |
| `--text-faint` | `#6B7690` | `#8B97AC` |

`--text-muted` is deliberately darker than the category norm. Metadata is where
designers reach for grey and where AA quietly dies — and metadata here is
timestamps, phone numbers and counts, which people actually read.

There is deliberately no token below `--text-faint`. A fourth, lighter grey has
no legitimate use.

### 2.3 Semantic — fill and text are different values

| Meaning | Fill (light) | Text (light) | Fill (dark) | Text (dark) |
|---|---|---|---|---|
| Success | `#16A34A` | `#0F7034` | `#34D399` | `#5FE0A8` |
| Warning | `#F59E0B` | `#96450A` | `#FBBF24` | `#FCD34D` |
| Danger | `#EF4444` | `#C21C1C` | `#F87171` | `#FCA5A5` |
| Info | `#0EA5E9` | `#0369A1` | `#38BDF8` | `#7DD3FC` |

The text column is what `.text-danger` resolves to. The fill column is what a
button background uses. Wiring both to one value is the most repeated mistake in
this category.

### 2.4 Channel identity

| Channel | Colour |
|---|---|
| WhatsApp | `#25D366` |
| Telegram | `#2AABEE` |
| Web chat | `--brand` |
| Instagram | `#E1306C` |

Channel colour is **never the sole carrier of meaning** — always paired with an
icon or a label. Roughly 8% of men in this market cannot separate the WhatsApp
green from a status green.

### 2.5 Tenant colour

White-label tenants pick their own brand colour. **Deepen it, never replace it**
— `color-mix(in srgb, {tenant} 68%, black)` for text use — so their hue survives
and stays legible.

Never concatenate alpha onto a colour string. `hsl(var(--x))20` is invalid CSS
that fails silently and takes the whole tint with it. That shipped here and cost
every status badge its background with nothing complaining.

## 3. Typography

### 3.1 Stack

**IBM Plex Sans Arabic / IBM Plex Sans Hebrew / IBM Plex Sans**, with **IBM Plex
Mono** for numerics.

One superfamily across all three scripts, drawn with shared metrics and matching
weights. Pairing three unrelated families produces a different vertical rhythm
per language, and the Arabic ends up looking like a translation of the Hebrew
rather than a peer of it — the exact criticism levelled at the incumbents in
this market. It is a typography decision before it is a localisation one.

```css
--font-sans: 'IBM Plex Sans Arabic', 'IBM Plex Sans Hebrew', 'IBM Plex Sans',
             system-ui, sans-serif;
--font-mono: 'IBM Plex Mono', ui-monospace, monospace;
```

Arabic and Hebrew are listed **first**: they carry the Latin glyphs adequately,
and leading with the Latin face causes visible fallback flicker on the primary
market's screens.

### 3.2 Scale — named for role, never for size

| Token | Size / line-height | Weight | Use |
|---|---|---|---|
| `text-display` | 32 / 40 | 700 | Marketing, empty-state headlines |
| `text-h1` | 24 / 32 | 700 | Page title |
| `text-h2` | 20 / 28 | 600 | Section |
| `text-h3` | 16 / 24 | 600 | Card title |
| `text-body` | 14 / 22 | 400 | Default |
| `text-body-strong` | 14 / 22 | 600 | Emphasis in prose |
| `text-small` | 13 / 20 | 400 | Dense rows |
| `text-caption` | 11 / 16 | 500 | Metadata, labels |
| `text-micro` | 10 / 14 | 500 | Badges, counts |

Role names, not `text-[13px]`. When captions later become 12px that is one edit,
not a search across forty files.

`text-micro` at 10px is legitimate only for numerals and single words. Any
sentence at that size is a decision to make something unreadable.

### 3.3 Numerals

All numerals — money, phone numbers, dates, IDs, counts — render `--font-mono`,
`font-variant-numeric: tabular-nums`, and `dir="ltr"`.

`dir="ltr"` goes on **the number, never on a container**. Wrapping a container
flips the whole layout; a phone number inside RTL prose without it renders its
digit groups in the wrong order, which for a phone number means wrong.

## 4. Global styling rules

### 4.1 Spacing — 4px base, 8px rhythm

`--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 24
· `--space-6` 32 · `--space-8` 48 · `--space-10` 64

**Density modes multiply row padding only — never the type scale.** Shrinking
text to fit more rows is how a dense interface becomes an unreadable one.

| Density | Row padding | Row height |
|---|---|---|
| Compact | `--space-2` | 44px |
| Comfortable | `--space-3` | 56px |
| Spacious | `--space-4` | 68px |

### 4.2 Radius

`--radius-sm` 4 (chips, inputs) · `--radius-md` 8 (cards, buttons) ·
`--radius-lg` 12 (modals, panels) · `--radius-full` 9999 (avatars, pills)

Nothing above 12px on a working surface. Large radii read as consumer and cost
usable width in a dense table.

### 4.3 Elevation

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgb(15 23 42 / .06)` | Cards at rest |
| `--shadow-md` | `0 4px 12px rgb(15 23 42 / .08)` | Dropdowns, popovers |
| `--shadow-lg` | `0 12px 32px rgb(15 23 42 / .16)` | Modals, drawers |

**Dark mode does not use these.** Shadow on a dark canvas is invisible;
elevation there is carried by `--surface-raised` plus a 1px border. A dark theme
built by reusing light shadows loses all layout structure — the chrome and the
content merge into one surface.

### 4.4 Motion

`--motion-micro` 120ms (hover, focus) · `--motion-panel` 200ms (drawers,
popovers) · `--motion-modal` 300ms. Easing `cubic-bezier(0.2, 0, 0, 1)`.

Every transition honours `prefers-reduced-motion: reduce`. Non-negotiable in a
product someone stares at for eight hours.

### 4.5 Layout direction

**Logical properties only.** `margin-inline-start`, `padding-inline-end`,
`inset-inline-start`, `text-align: start`. No `left` / `right` in application
code.

Two of three languages are RTL, and physical properties do not fail loudly —
they put the search icon on the wrong side and the active-row marker on the far
edge of the row, and it ships.

One specific trap: **`inset-inline-0` is not a class Tailwind generates.** It
reads exactly like the logical property and produces nothing, leaving an
absolutely positioned element with no horizontal anchoring, sized to its longest
child. Use `start-0 end-0`.

### 4.6 Focus

`0 0 0 2px var(--surface), 0 0 0 4px var(--brand)` — a ring that survives on any
surface. Never `outline: none` without a replacement.

---

# Phase 2 — Core screen architecture and layouts

## 1. The two-surface principle

| | **Operator surface** | **Configuration surface** |
|---|---|---|
| Screens | Inbox, Contacts | Settings, Broadcasts, Reports, Console |
| Session | 8 hours, continuous | 10 minutes, occasional |
| Density | Compact / Comfortable | Spacious |
| Chrome | Minimal — content is the interface | Explanatory — headings, help text, numbering |
| Navigation | Keyboard-first, no page reloads | Anchored scroll with a sticky index |

Applying one design language to both is the standard failure in this category.
An operator does not need a heading explaining what their inbox is; an admin
configuring auto-replies needs a paragraph explaining what happens if they leave
the field empty.

## 2. Global frame

```
┌──┬──────────────────────────────────────────────────────┐
│  │  top bar (contextual — only where it earns its row)  │
│R ├──────────────────────────────────────────────────────┤
│A │                                                      │
│I │                    canvas                            │
│L │                                                      │
└──┴──────────────────────────────────────────────────────┘
```

**Rail — 48px, `--nav` navy, fixed, full height.** Icon-only, tooltip on hover.
Destinations are filtered by the caller's real permission set **fetched from the
server**, not mirrored in the client — a mirrored permission matrix drifts the
first time a role gains an operation, and it drifts toward offering pages the
server then refuses.

Pinned to the bottom of the rail: **gateway state**, notifications, account.
Gateway state sits in the always-visible column because on an unofficial gateway
nothing else warns you — a dead session is silent until a send fails.

**No global top bar.** Each surface owns its header. A persistent bar costs 56px
of vertical space on the one screen where vertical space is the product.

| Width | Rail | Behaviour |
|---|---|---|
| ≥ 1280 | 48px icons | Full four-pane inbox |
| 768–1279 | 48px icons | Pane 1 collapses |
| < 768 | Off-canvas drawer | Sequential panels, never a squeezed grid |

## 3. Operator surface — the four-pane inbox

```
┌──┬────────────┬─────────────┬──────────────────┬───────────┐
│R │ 1 SCOPE    │ 2 LIST      │ 3 THREAD         │ 4 CONTEXT │
│A │ 232px      │ 280px       │ flex             │ 320px     │
│I │ inboxes    │ status pills│ header + actions │ tabs      │
│L │ stages     │ search      │ ─────────────    │ details   │
│  │ teams      │ ─────────── │ messages         │ convos    │
│  │ views      │ rows        │ (scroll)         │ files     │
│  │ ────────── │             │ ─────────────    │ activity  │
│  │ gateway    │             │ readiness strip  │           │
│  │            │             │ composer         │           │
└──┴────────────┴─────────────┴──────────────────┴───────────┘
```

### 3.1 Pane 1 — scope

Groups: **Inboxes** (All / Mine / Unassigned / Mentions / Snoozed) · **Lifecycle
stages** · **Team inboxes** · **Saved views**. Every row carries a live count.

Groups appear only when populated. Mentions shows only once you have one; an
agent nobody has ever named does not need a permanent zero. An empty "Lifecycle"
heading over nothing is a dead section, and this product's vocabulary is
tenant-defined.

**Counts and the list must be computed by one predicate** — not two
implementations that agree today. This has failed twice here: a filter applied
in the list but not in the counting code, so every row read one higher than the
list it opened.

**Below 1280 this pane is hidden, and that is the trap.** The scopes it holds
exist nowhere else: Mine, Unassigned, every stage, every team queue — and the
gateway warning went with them. They reappear as a compact dropdown in the list
header plus a slim gateway banner, both reading from the same source, so wide
and narrow cannot disagree.

### 3.2 Pane 2 — conversation list

Header: status pills with counts, search, density control.

Rows: avatar · name · timestamp · status chip · assignee · preview · unread
badge. Active row marked with a 2px bar on the **inline-start** edge — physical
`left` puts it on the far side of the row in English.

Per-row channel health appears **only** when the workspace has more than one
number and some-but-not-all are down. If everything is down the rail already
covers the whole list. What this catches is the case the rail cannot express —
two numbers, one dead, and no way to tell which conversations went quiet.

### 3.3 Pane 3 — thread

Sticky header: contact, `#id`, status, and the state-changing actions — Resolve,
Pending, Awaiting customer, Snooze.

Two scroll behaviours that are invisible until they break:

- **`overflow-anchor: none`** on the message container. Browsers compensate for
  prepended content themselves, so doing both scrolls twice as far as intended.
- Capture `scrollHeight` before prepending and restore after, or "load older"
  throws away the reader's position.

Failed sends state the reason and offer a retry inline — not a grey ✗. The retry
updates the existing message rather than creating a second one: the row is
persisted *before* the gateway call, so a message marked FAILED may already have
been delivered, and re-sending puts it in front of the customer twice.

**Composer readiness strip** above the composer: whether *this* conversation can
be replied to, stated before the agent types rather than after they press send.
Readiness is per session, never averaged — a workspace with support up and
marketing down must not show one blended answer that is wrong for both.

### 3.4 Pane 4 — contact context

Tabs: **Details · Conversations · Files · Activity**.

Details carries identity, team, lifecycle stage, marketing consent **with its
provenance** (source, date, who recorded it), and tenant-defined custom fields
edited in place, saved per field on blur. There is no form to submit; one distant
Save button is how edits get lost when the agent clicks away to answer.

Conversations lists this contact's other threads **including resolved ones** —
they hold the answers, and the default filter hides them, which is why they are
unreachable anywhere else.

Activity merges audit events with automated messages. Automated events render as
**hollow dots**, not a colour difference.

## 4. Session lifecycle — the OpenWA screens

### 4.1 Five states, not three

| State | Meaning | Impact shown | Action |
|---|---|---|---|
| **Checking** | Not yet known | *nothing* | — |
| **Never paired** | Session exists, no number ever scanned | "No message can arrive or be sent" | Scan the code |
| **Disconnected** | Paired before, dropped now | "Incoming messages are lost and replies do not send" | Reconnect |
| **Degraded** | Some numbers down, not all | "Conversations on the disconnected channels are stalled" | Review channels |
| **Connected** | All good | *nothing* | — |

**Checking renders as nothing or as "checking" — never as an error.** An agent
sent to fix a working channel is worse off than one told nothing.

Never-paired and disconnected are identical in a three-state model and have
completely different fixes: one needs a phone in someone's hand, the other
usually recovers itself. Distinguish by whether the session has ever carried a
phone number.

Degraded is meaningful only with more than one number, and it must **name which**
is down. A ratio like `2/3` without names is a puzzle, not a status.

### 4.2 QR pairing modal

```
┌─────────────────────────────────────┐
│  Connect a WhatsApp number       ✕  │
├─────────────────────────────────────┤
│   ┌───────────────┐   1. Open       │
│   │   QR (256px)  │      WhatsApp   │
│   │               │   2. Linked     │
│   └───────────────┘      devices    │
│   expires in 0:47     3. Scan       │
├─────────────────────────────────────┤
│  ● Waiting for scan                 │
└─────────────────────────────────────┘
```

- **Polls, and shows that it is polling.** A static QR with no state is
  indistinguishable from a frozen one.
- **Visible expiry countdown**, then an explicit Refresh. WhatsApp codes rotate;
  a silently stale code is the most common false "it's broken".
- On success the modal shows the connected number rather than closing — closing
  leaves the admin unsure whether it worked.

### 4.3 The reconnect trap

**Reconnect and re-pair are different operations.** When the gateway still holds
credentials it reconnects *the same number* and **no QR is offered**. An admin
wanting a different phone will watch a spinner waiting for a code that never
appears.

That state needs its own copy: *"WhatsApp still holds this device link. To pair a
different number, open WhatsApp on the phone → Linked devices → remove this
device, then come back."*

Three distinct controls, never one:

| Control | Effect | Consequence |
|---|---|---|
| **Reconnect** | Resume the same number | None — safe |
| **Pause** | Stop inbound, keep the link | Reversible, same number returns |
| **Unlink** | Discard credentials | Requires a new QR. Old conversations kept — say so on the button |

## 5. Configuration surface

### 5.1 Settings

Two columns: a **sticky numbered index** (232px) beside anchored sections. Not
tabs — eleven mounted/unmounted tabs would restructure hundreds of lines of
working form, anchors keep deep links working, and the page survives with
JavaScript disabled.

Scroll-spy marks the current section, and **must read the real scroll parent** —
found by walking up for a computed `overflow-y`. These sections scroll inside a
container, and an IntersectionObserver against the viewport marks nothing.

**Controls a role cannot use are shown with the restriction stated, not
removed.** A blank space is indistinguishable from an empty card and from an
ungranted feature. Saying so grants nothing — the server enforces the same rule
regardless, which is exactly why it is safe to say.

Navigation is the one exception: an absent menu entry is unambiguous, and a menu
is a list of places you can go.

### 5.2 Complex forms

Every field that changes behaviour states the consequence beneath it, **in both
branches**. A field that explains itself only to the people who cannot edit it is
backwards, and that shipped here.

Destructive actions name what survives: *"Old conversations are kept."*

## 6. Data surface — reports

Filter bar (period · team · channel) → three headline tiles → series → tables.
Tiles are **clickable into the rows behind them**; a metric you cannot open is
trivia.

**An empty period says so.** Em-dashes and zeros with no explanation cover three
different situations — the product is broken, the filter is wrong, or the
business was quiet — and only one is the reader's to fix. Name the period and
offer the widening as a control.

Campaign reply counts open the replies: each customer's **first** message since
the send, which is almost always the requirement.

## 7. List surface — contacts

Table with column control, filter builder, saved segments as chips, bulk
selection.

Selecting rows reveals bulk actions **in place** — label, assign, save-as-group.
Saving a *selection* as a group and saving a *filter* as a segment are different
operations: one is "these eleven people", the other is "everyone matching these
rules", and only the second can be written as a rule.

## 8. Micro-interactions

| Interaction | Rule |
|---|---|
| **Hover** | Background shift only, `--motion-micro`. Never movement — a row that shifts under the cursor is a row you misclick. |
| **Sticky** | Thread header, list header, settings index, table header. Everything else scrolls. |
| **Skeletons** | Shaped like the rows they replace, staggered ~90ms. **First load only** — replacing a list an agent is reading with a skeleton every poll is worse than showing nothing. |
| **Empty states** | Three distinguishable causes: no channel · nothing yet · nothing matching. The filter is tested **first**, because server-side search replaces the loaded list, and any other order tells someone staring at their own search term that their workspace is empty. |
| **Optimistic UI** | Only where the server cannot meaningfully refuse. Not for sends. |
| **Toasts** | Carry the server's own message. "Failed" discards the only part that says what to change. |
| **Focus** | Visible ring on every interactive element. Escape closes every overlay. |
| **Live regions** | New messages announced politely; connection loss assertively. |

## 9. Breakpoints

| Token | Width | Layout |
|---|---|---|
| `sm` | 640 | Single panel, drawer nav |
| `md` | 768 | List + thread; pane 1 → dropdown, gateway → banner |
| `lg` | 1024 | Pane 1 returns |
| `xl` | 1280 | All four panes |
| `2xl` | 1536 | Panes widen; the thread takes the surplus |

**Below `md` the inbox is sequential, never a compressed grid.**

---

# Phase 3 — Component specifications and frontend logic

## 1. Tailwind configuration

### 1.1 Tokens as HSL triplets, not hex

```css
:root {
  --brand:        217 79% 48%;   /* #1A56DB */
  --brand-text:   220 77% 40%;
  --accent:       175 77% 26%;
  --canvas:       213 33% 97%;
  --surface:        0  0% 100%;
  --nav:          222 47% 11%;
  --border:       217 24% 90%;
  --text:         222 47% 11%;
  --text-muted:   220 18% 40%;

  --success-fill: 142 76% 36%;   --success-text: 145 76% 25%;
  --warning-fill:  38 92% 50%;   --warning-text:  26 90% 31%;
  --danger-fill:    0 84% 60%;   --danger-text:    0 74% 44%;
}

.dark {
  --brand:        217 82% 65%;
  --brand-text:   217 80% 76%;
  --canvas:       222 47%  8%;
  --surface:      222 35% 12%;
  /* … every token redefined, never inherited */
}
```

**Why triplets.** `bg-brand/10` only compiles if the value is
`hsl(var(--brand) / <alpha-value>)`. With a hex variable you cannot express a
tint, and people reach for string concatenation instead — `hsl(var(--brand))20`,
invalid CSS that fails silently.

Where a tint must be computed from a runtime value (a tenant's colour), use
`color-mix()`:

```ts
backgroundColor: `color-mix(in srgb, ${tenantColor} 12%, transparent)`,
color:           `color-mix(in srgb, ${tenantColor} 68%, black)`,  // deepened for text
```

### 1.2 One source for the type scale

```ts
// design/type-scale.ts
export const TYPE_SCALE = {
  display:       ['2rem',     { lineHeight: '2.5rem',  fontWeight: '700' }],
  h1:            ['1.5rem',   { lineHeight: '2rem',    fontWeight: '700' }],
  h2:            ['1.25rem',  { lineHeight: '1.75rem', fontWeight: '600' }],
  h3:            ['1rem',     { lineHeight: '1.5rem',  fontWeight: '600' }],
  body:          ['0.875rem', { lineHeight: '1.375rem' }],
  'body-strong': ['0.875rem', { lineHeight: '1.375rem', fontWeight: '600' }],
  small:         ['0.8125rem',{ lineHeight: '1.25rem' }],
  caption:       ['0.6875rem',{ lineHeight: '1rem',    fontWeight: '500' }],
  micro:         ['0.625rem', { lineHeight: '0.875rem',fontWeight: '500' }],
} as const;

export const TYPE_SCALE_NAMES = Object.keys(TYPE_SCALE);
```

```ts
// tailwind.config.ts
import { TYPE_SCALE } from './design/type-scale';

export default {
  theme: {
    extend: {
      fontSize: TYPE_SCALE,
      colors: {
        brand:   'hsl(var(--brand) / <alpha-value>)',
        canvas:  'hsl(var(--canvas) / <alpha-value>)',
        surface: 'hsl(var(--surface) / <alpha-value>)',
        border:  'hsl(var(--border) / <alpha-value>)',
        success: { DEFAULT: 'hsl(var(--success-fill) / <alpha-value>)',
                   text:    'hsl(var(--success-text) / <alpha-value>)' },
        danger:  { DEFAULT: 'hsl(var(--danger-fill) / <alpha-value>)',
                   text:    'hsl(var(--danger-text) / <alpha-value>)' },
      },
      borderRadius: { sm: '4px', md: '8px', lg: '12px' },
      transitionDuration: { micro: '120ms', panel: '200ms', modal: '300ms' },
      transitionTimingFunction: { standard: 'cubic-bezier(0.2, 0, 0, 1)' },
    },
  },
};
```

### 1.3 The merge configuration

**`tailwind-merge` does not read `tailwind.config.ts`.** It ships its own class
map. A custom `text-caption` is unknown to it, and `text-*` is ambiguous — size
or colour — so `cn('text-caption', 'text-brand')` collapses to one and **drops
the size**. The component renders at inherited 16px with both classes visibly
present in the source, and typecheck, lint and build all pass it.

```ts
// lib/utils.ts
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import { TYPE_SCALE_NAMES } from '@/design/type-scale';

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // Declares these as font sizes, so a size and a colour stop competing.
      'font-size': [{ text: TYPE_SCALE_NAMES }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Worth an actual test, because the failure is invisible:

```ts
cn('text-caption', 'text-brand')   // → 'text-caption text-brand'  ✅ both kept
cn('text-caption', 'text-micro')   // → 'text-micro'               ✅ last size wins
cn('text-caption', 'text-xs')      // → 'text-xs'                  ✅ competes with built-ins
```

Adding a role to `TYPE_SCALE` updates the utility and the merge config together.
That is the only reason to accept the indirection.

## 2. Core components

### 2.1 QR pairing modal

A discriminated union, because the reconnecting case has no QR and rendering a
spinner where a code should be is the failure this component exists to prevent.

```ts
export type PairingState =
  | { kind: 'requesting' }
  | { kind: 'awaiting-scan'; qr: string; expiresAt: number }
  /** Credentials survive: the same number returns and NO code is offered. */
  | { kind: 'reconnecting'; label: string }
  | { kind: 'connected'; phone: string }
  | { kind: 'failed'; reason: string };
```

```tsx
export function QrPairingModal({ sessionName, onPaired }: Props) {
  const [state, setState] = useState<PairingState>({ kind: 'requesting' });

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await fetchSessionQr(sessionName);
        if (cancelled) return;

        if (next.connected)         setState({ kind: 'connected', phone: next.phone });
        else if (next.reconnecting) setState({ kind: 'reconnecting', label: next.label });
        else if (next.qrCode)       setState({ kind: 'awaiting-scan', qr: next.qrCode,
                                               expiresAt: Date.now() + 60_000 });
      } catch (error) {
        if (!cancelled) setState({ kind: 'failed', reason: describe(error) });
      }
    };

    poll();
    const timer = setInterval(poll, 3_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [sessionName]);
```

| Trap | Guard |
|---|---|
| Polling outlives the modal, setting state on an unmounted tree | `cancelled` flag **and** `clearInterval` in one cleanup |
| A stale QR looks identical to a live one | `expiresAt` drives a visible countdown, then explicit Refresh |
| `reconnecting` shows a spinner forever | Its own branch, with instructions to unlink on the phone |

### 2.2 Data table — configuration surface

```tsx
type Column<T> = {
  key: string;
  header: string;
  /** Numeric columns get mono + tabular + dir="ltr" automatically. */
  numeric?: boolean;
  width?: string;
  render: (row: T) => React.ReactNode;
};
```

- **Wrapper is `overflow-x-auto`, never the page.** A horizontally scrolling
  page breaks every sticky element on it.
- **Header `sticky top-0 z-10`** with an *opaque* background. Translucent
  produces unreadable overlap.
- `text-start` on headers and cells; numeric columns `text-end` — which flips
  correctly in RTL, unlike `text-right`.
- **Three states, not two**: loading → skeleton rows shaped like real rows;
  empty → a reason, not the word "empty"; error → the server's message.

```tsx
<td className={cn('px-3 py-2', column.numeric && 'numeric font-mono tabular-nums text-end')}
    dir={column.numeric ? 'ltr' : undefined}>
```

`dir="ltr"` lands on the **cell**, never the row or the table.

### 2.3 Input field with consequence text

`consequence` is **required** for any field that changes behaviour — optional is
how it gets omitted from the branch that needed it most.

```tsx
export function Field({ label, value, onChange, type = 'text',
                        consequence, error, numeric }: FieldProps) {
  const id = useId();

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-caption">{label}</Label>
      <Input
        id={id}
        type={type}
        // Emails, passwords, phone numbers and amounts are typed LTR in every
        // interface language.
        dir={numeric || type === 'email' || type === 'password' ? 'ltr' : undefined}
        value={value}
        aria-describedby={consequence ? `${id}-hint` : undefined}
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
        className={cn(numeric && 'numeric font-mono tabular-nums',
                      error && 'border-danger')}
      />
      {consequence && (
        <p id={`${id}-hint`} className="text-micro text-text-muted">{consequence}</p>
      )}
      {error && <p className="text-caption text-danger-text">{error}</p>}
    </div>
  );
}
```

`text-danger-text` for the error, not `text-danger`. The fill value fails AA as
text — the entire point of the two-value system, and the place it is most often
forgotten.

## 3. State and layout logic

### 3.1 Scroll retention when prepending

```tsx
const threadRef = useRef<HTMLDivElement>(null);
const restoreHeightRef = useRef<number | null>(null);

const loadOlder = async () => {
  // Captured BEFORE the fetch. Taken after, the DOM has already grown.
  restoreHeightRef.current = threadRef.current?.scrollHeight ?? null;
  const older = await fetchOlderMessages(conversationId, oldestId);
  setMessages((prev) => [...older.messages, ...prev]);
};

useLayoutEffect(() => {
  const container = threadRef.current;
  const previous = restoreHeightRef.current;
  if (!container || previous === null) return;

  // Keep the same content under the reader: new height minus old height is
  // exactly how far everything moved down.
  container.scrollTop += container.scrollHeight - previous;
  restoreHeightRef.current = null;
}, [messages]);
```

```css
.thread-scroll {
  /* Chrome and Firefox also compensate for prepended content, so doing both
     scrolls twice as far as intended. Ours is deterministic; theirs is not. */
  overflow-anchor: none;
}
```

`useLayoutEffect`, not `useEffect` — the correction must land before paint.

### 3.2 Focus rings

```css
@layer base {
  /* :focus-visible, not :focus — a ring on every mouse click is why people
     remove focus styling altogether, and then keyboard users lose it. */
  :where(button, a, input, select, textarea, [tabindex]):focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px hsl(var(--surface)), 0 0 0 4px hsl(var(--brand));
    border-radius: inherit;
  }
}
```

The inner ring in `--surface` separates the outer ring from the control on any
background, so one rule works on the navy rail and the white card.

Overlays move focus **into** the panel on open and **return it to the trigger**
on close:

```tsx
useEffect(() => {
  if (!open) return;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  panelRef.current?.focus();
  return () => previouslyFocused?.focus();
}, [open]);
```

### 3.3 Optimistic UI against an unofficial gateway

**Optimistic only where the server cannot meaningfully refuse.**

| Action | Optimistic? | Why |
|---|---|---|
| Toggle a label | ✅ | Local write, refusal near-impossible |
| Assign a conversation | ✅ | Permission known client-side |
| Snooze | ✅ | Local timestamp |
| Change status | ✅ | Local write |
| **Send a message** | ❌ | An unofficial gateway refuses regularly |
| Record a payment | ❌ | Money |
| Issue an invoice | ❌ | Money |

Sends render a real `PENDING` state instead — the message is persisted
server-side *before* the gateway call, so a transport error never loses what was
typed:

```tsx
const send = async () => {
  const sent = await sendReply(conversationId, body);   // the persisted row
  setMessages((prev) => [...prev, sent]);               // may already be FAILED
  if (sent.status === 'FAILED') toast.error(t(sent.failureReason));
};
```

Optimistic cases roll back to the captured previous value and surface the
server's own message:

```tsx
const setStage = async (next: string) => {
  const previous = stage;
  setStage(next);                                  // optimistic
  try {
    await updateContact(contactId, { lifecycleStage: next });
  } catch (err) {
    setStage(previous);                            // exact rollback, not a refetch
    toast.error(err?.response?.data?.error ?? t('فشل التحديث'));
  }
};
```

Rolling back by refetching hides the failure behind a loading state and races
any other edit in flight.

### 3.4 One predicate for list and counts

```ts
// One function. Both consumers.
export function scopeMatches(conv: Conv, scope: InboxScope, ctx: ScopeContext): boolean { … }

const visible = conversations.filter((c) => scopeMatches(c, scope, ctx));
const count   = conversations.filter((c) => scopeMatches(c, candidate, ctx)).length;
```

A context **object** rather than positional arguments — this signature has
already grown to four parameters, and the fifth is where a caller silently
passes the wrong thing.

## 4. Responsive component behaviour

| Component | `< md` | `md–xl` | `≥ xl` |
|---|---|---|---|
| Scope pane | Dropdown in list header | Dropdown | 232px column |
| Contact panel | Route push | Hidden | 320px column |
| Data table | Card list, key fields only | Horizontal scroll | Full |
| Modal | Full-screen sheet | Centred, `max-w-md` | Centred |
| Filter builder | Stacked | Stacked | Inline rows |

Components below `md` become **sequential, not compressed**.

## 5. Verification

A component is not finished until it has shipped in both themes, both
directions, and all of its states.

```bash
npm run check:i18n       # every literal key translated in he + en, no duplicates
npm run check:mojibake   # RTL text decoded as Latin-1 and written back as UTF-8
```

The second exists because mis-decoded Arabic is valid UTF-8 — nothing else
complains, and it is unreadable only to the person being shown it.

**Contrast is measured, not eyeballed**, against the surface the text sits on, in
both themes. Every failure found in this codebase — `text-destructive/80` at
2.62:1, sub-nav numbering at 3.1:1, tenant colours at 3.84:1 — looked fine in
review.

---

## The three things to keep

1. **Two values per semantic colour.** A fill is not a text colour, and
   conflating them fails AA quietly.
2. **One predicate per rule.** Counts and lists, scope and filter, count and
   drill-down. Two implementations agree until the day one is edited.
3. **A failure that renders as nothing is a failure nobody fixes.** Images
   hidden by an `onError` handler read as "images don't appear" rather than
   "images are broken", and survived months because of it.
