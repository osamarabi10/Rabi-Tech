import { PlatformShell } from '@/components/platform/platform-shell';

/**
 * The owner console is English-only, and must not inherit tenant direction.
 *
 * ## The bug this fixes
 *
 * `app/layout.tsx` sets `dir={branding.direction}` on `<html>`, which is
 * correct — the tenant console is Arabic and Hebrew as well as English. The
 * platform console had no override, so an owner whose own organization is Arabic
 * got `dir="rtl"` around English text.
 *
 * `truncate` is `text-overflow: ellipsis`, and the ellipsis follows the
 * direction. In RTL it clips the *start*, so the sidebar read
 * "…y and service operations" instead of "Reliability and service oper…".
 * Every logical property in the console was mirrored the same way: `ms/me`,
 * `ps/pe`, `start-*`/`end-*` all flipped, and `text-start` right-aligned
 * English.
 *
 * ## Why here rather than on the shell component
 *
 * This element wraps every route under `/platform`, so there is no page that
 * can render outside it. Putting it on `PlatformShell` would leave anything
 * rendered beside the shell — a modal portal, an error boundary — back on the
 * inherited direction.
 *
 * `dir` inherits, so nested components get `ltr` without doing anything. The
 * only way to lose it is for a descendant to set its own `dir`, which is why
 * the console must not use `dir="auto"` on containers. `dir="ltr"` on a
 * *number* stays correct and is unaffected.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <div dir="ltr" className="contents">
      <PlatformShell>{children}</PlatformShell>
    </div>
  );
}
