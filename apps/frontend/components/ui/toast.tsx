'use client';

import { toast as sonner } from 'sonner';

/**
 * P19 · the toast system, and the undo contract underneath it.
 *
 * ## The rule this is built around
 *
 * A toast offering undo it cannot perform is worse than no toast, because the
 * user stops looking. So undo is **not an optional boolean**. It is a
 * discriminated union with exactly two members, and a toast with no `undo` key
 * renders no undo affordance at all. An un-performable undo is not discouraged
 * here — it is unrepresentable.
 *
 * ## Two modes, and why the default is the unfailable one
 *
 * **`defer` — the primary mode. Nothing has been sent yet.** The destructive
 * call is held for the length of the window and fired only when the window
 * closes. Undo inside the window means the server never saw the action, which
 * is the only kind of undo that cannot fail. Callers show optimistic state for
 * the duration.
 *
 * **`inverse` — the escape hatch.** Some actions cannot be deferred: the caller
 * needs the server's response, or the write is already committed by the time
 * the outcome is known. Those supply an explicit inverse, and undo calls it.
 * This one *can* fail, which is why the failure path below is not optional.
 *
 * ## The window
 *
 * Eight seconds. Long enough to notice and reach for, short enough that a
 * deferred write is not left hanging while the user reads something else. It is
 * not configurable downwards below four seconds: an undo window too short to
 * use is decoration, and this component should not help anyone ship one.
 *
 * ## The flush hazard, which is the dangerous part
 *
 * A deferred commit that is lost on navigation is **silent data loss the user
 * is certain succeeded** — they saw the row disappear and no error. So a
 * pending commit is flushed, not dropped, on route change and on unload. The
 * registry below exists for that and nothing else.
 *
 * ## When undo fails
 *
 * The toast does not vanish. It converts to an error state that says the undo
 * failed and **states what is still true** — "still archived", not a bare
 * "something went wrong" — and offers retry. While the inverse is in flight the
 * control is disabled with a visible pending label, never a dead button with no
 * explanation.
 */

/** The floor is deliberate: an undo window too short to use is decoration. */
const MIN_WINDOW_MS = 4_000;
const DEFAULT_WINDOW_MS = 8_000;

export type UndoContract =
  /**
   * Nothing has reached the server. `commit` runs when the window closes, and
   * undo means it never runs at all.
   */
  | { mode: 'defer'; commit: () => Promise<unknown> }
  /**
   * The action is already committed. `inverse` reverses it, and may fail — the
   * toast is required to say so rather than disappear.
   */
  | { mode: 'inverse'; inverse: () => Promise<unknown> };

export type ToastOptions = {
  /** What is still true after this action, in the user's language. */
  description?: string;
  undo?: UndoContract;
  undoWindowMs?: number;
  /** Shown when a deferred commit fails after the window closed. */
  onCommitError?: (error: unknown) => void;
  labels: {
    undo: string;
    undoing: string;
    undone: string;
    /** Must name what is still true, e.g. "still archived". */
    undoFailed: string;
    retry: string;
    commitFailed: string;
  };
};

/*
  Pending deferred commits, keyed by toast id.

  This map is the whole reason `flushPendingCommits` can exist. Without it a
  deferred write lives only inside a setTimeout closure, and a closure is not
  something a navigation handler can find and run early.
*/
const pending = new Map<string | number, { timer: ReturnType<typeof setTimeout>; run: () => void }>();

/**
 * Fire every deferred commit immediately.
 *
 * Called on route change and on unload. Firing early is correct and dropping is
 * not: the user has already been shown the outcome, so the only honest options
 * are to perform it or to tell them it did not happen, and a page that is
 * unloading cannot tell them anything.
 */
export function flushPendingCommits() {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.run();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingCommits);
  window.addEventListener('beforeunload', flushPendingCommits);
}

function clampWindow(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_WINDOW_MS;
  return Math.max(MIN_WINDOW_MS, ms);
}

/**
 * A toast with no undo. Separate entry point rather than an optional argument,
 * so "this action is not reversible" is a decision at the call site.
 */
export function notify(message: string, description?: string) {
  return sonner(message, { description });
}

export function notifyError(message: string, description?: string) {
  return sonner.error(message, { description });
}

/**
 * A toast whose action can genuinely be taken back.
 *
 * Returns the toast id so a caller can dismiss it when the underlying row goes
 * away for another reason.
 */
export function notifyWithUndo(message: string, options: ToastOptions) {
  const { undo, labels } = options;
  const windowMs = clampWindow(options.undoWindowMs);

  if (!undo) return notify(message, options.description);

  // Bound after the guard so the narrowing survives into the closures below.
  // TypeScript widens a captured binding inside a nested function, and the two
  // modes must stay distinguishable there — that discrimination is the whole
  // guarantee this component makes.
  const contract: UndoContract = undo;

  const id = sonner(message, {
    description: options.description,
    duration: windowMs,
    action: {
      label: labels.undo,
      /*
        preventDefault, and it is load-bearing rather than tidy.

        Sonner removes a toast once its action handler returns, unless the
        handler prevents the default — see the library's own sequence:
        `action.onClick(event); if (event.defaultPrevented) return; deleteToast()`.

        This toast must survive being pressed. performUndo replaces it IN PLACE,
        by id, first with progress and then either with success or with a
        failure that carries duration: Infinity because a failed undo which
        fades out leaves somebody believing it worked. Without this line the
        replacement renders and sonner's queued removal unmounts it about
        150ms later, so the failure message existed for roughly one frame.

        That is not a hypothetical: it is what made the P19 certification flaky.
        The assertion passed when it happened to land inside that frame — which
        it did when the spec ran alone and often did not when the machine was
        busy — so the suite reported one, two or three red cells depending on
        load. The bug was in this component the whole time, and the timing was
        only what decided whether a test caught it.
      */
      onClick: (event) => {
        event.preventDefault();
        void performUndo();
      },
    },
    onAutoClose: () => { settle(); },
    onDismiss: () => { settle(); },
  });

  /*
    Deferred mode: schedule the commit for the end of the window and register it
    so a navigation can flush it. `settled` guards the double-path — sonner can
    call both onDismiss and onAutoClose, and a commit must run exactly once.
  */
  let settled = false;

  function settle() {
    if (settled) return;
    settled = true;
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.run();
  }

  if (contract.mode === 'defer') {
    const run = () => {
      void contract.commit().catch((error) => {
        // The action the user believed happened did not. Say so, and say it in
        // a toast that does not auto-dismiss — this is the one message they
        // cannot afford to miss.
        sonner.error(labels.commitFailed, { duration: Infinity });
        options.onCommitError?.(error);
      });
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      settled = true;
      run();
    }, windowMs);
    pending.set(id, { timer, run });
  }

  async function performUndo() {
    if (contract.mode === 'defer') {
      // Nothing was sent. Cancel the scheduled commit and there is nothing to
      // fail — this is the mode that makes the common case unfailable.
      settled = true;
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(id);
      }
      sonner.success(labels.undone, { id });
      return;
    }

    /*
      Inverse mode. The action is already on the server, so this is a real
      request that can fail.

      The pending state replaces the toast in place rather than dismissing it,
      so the control cannot be pressed twice and the user is not left looking at
      an undo button that appears to have done nothing.
    */
    settled = true;
    sonner.loading(labels.undoing, { id, duration: Infinity });
    try {
      await contract.inverse();
      sonner.success(labels.undone, { id, duration: 4_000 });
    } catch {
      /*
        The failure path, and the reason `undoFailed` must name what is still
        true. Duration is Infinity on purpose: a failed undo that fades out
        leaves the user believing it worked, which is the exact outcome this
        whole component exists to prevent.
      */
      sonner.error(labels.undoFailed, {
        id,
        duration: Infinity,
        action: {
          // Same reason as the undo action above: pressing retry must not be
          // what removes the message explaining why the last attempt failed.
          label: labels.retry,
          onClick: (event) => {
            event.preventDefault();
            void performUndo();
          },
        },
      });
    }
  }

  return id;
}
