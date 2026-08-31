# Fetch state — two patterns, one of them additive

There are two ways to model a load in this frontend. That is deliberate, and
this file says which to use where so the second one does not quietly become a
migration nobody asked for.

## The established pattern: manual state + operational-state

Most of the app models a fetch as three `useState` values and derives the
fourth state at render:

```tsx
const [items, setItems] = useState<T[]>([]);
const [loading, setLoading] = useState(true);
const [loadError, setLoadError] = useState(false);
// empty is derived: items.length === 0
```

paired with `EmptyState` / `ErrorState` / `LayoutSkeleton` from
[`components/ui/operational-state.tsx`](../apps/frontend/components/ui/operational-state.tsx).

**29 files use this.** It was deliberately hardened in `6f13e995`, which
replaced fire-and-forget `toast.error()` on load failure with a persistent,
retryable `loadError` — an error that disappears after four seconds is an error
the user cannot act on.

## The additive pattern: useResource

[`lib/async-resource.ts`](../apps/frontend/lib/async-resource.ts) models the
same load as one discriminated union:

```ts
{ status: 'loading' } | { status: 'error'; error } | { status: 'empty' } | { status: 'populated'; data }
```

It is the better model. Four states are explicit rather than three plus a
render-time inference, so an error cannot be mistaken for an empty response.
It also does two things the manual pattern does not do at all:

- **Request sequencing.** Each run takes a ticket; only the newest may write
  its result. Without this, a slow first request can land on top of a fast
  second one and render stale data.
- **Unmount safety.** A ref tracks whether the component is still mounted, so
  a late response does not `setState` into a dead tree.

## Which to use

- **New pages and components:** `useResource`.
- **`subscription-card.tsx`:** already migrated, as the first consumer.
- **Everything else:** stays on the manual pattern.

Existing pages are **not** to be migrated as a side effect of touching them.
Migrate a file only when that migration is the deliberate, stated point of the
change. A 29-file refactor is a decision, not a cleanup, and it should be
proposed and approved as one.

The cost of this arrangement is real and accepted: until those 29 files are
migrated, they carry the defects `useResource` was written to prevent. That is
recorded in [KNOWN-DEFECTS.md](KNOWN-DEFECTS.md) rather than left implicit.
