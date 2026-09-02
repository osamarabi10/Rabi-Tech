'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The settings design language.
 *
 * ## Why this is a primitive file and not fifteen rewritten screens
 *
 * Every settings screen already builds from `Card` / `CardHeader` / `CardContent`.
 * That means the visual direction lives in about two hundred lines here rather
 * than spread across the 1,197-line general page and fourteen others — and it
 * means the direction can be reviewed and corrected before it is applied
 * everywhere, instead of after.
 *
 * ## What is being matched, and what is not
 *
 * Matched from Respond.io: the **shape**. A roomy single content column rather
 * than full-bleed rows; sections as titled cards with a description under the
 * title; a label-and-helper on one side with its control on the other; far more
 * whitespace than this product currently uses. Their screens read as a document
 * you scroll; ours read as a dense table. That difference is most of what makes
 * them feel calmer, and it is reproducible without copying a single colour.
 *
 * Deliberately **not** matched, because copying them here would make the product
 * worse at what distinguishes it:
 *
 * - **Colour comes from the tenant.** `--primary` is set per subscriber by the
 *   branding system. A fixed palette is the opposite of a white-label product,
 *   so the accent stays theirs and only the *treatment* is borrowed.
 * - **Direction is logical, never left.** Two of three languages are RTL. Every
 *   spacing property here is `ms/me`, `ps/pe`, `start/end` — a layout built on
 *   `ml/pl` looks correct in English and is broken in Arabic and Hebrew, which
 *   is most of the userbase.
 * - **The type scale is the role scale.** `text-caption`, `text-micro` and the
 *   rest are registered in `lib/utils.ts` so `cn()` does not drop them. Hardcoded
 *   `text-sm` here would silently render at a different size than every other
 *   screen once tailwind-merge sees a colour in the same call.
 */

/**
 * The scroll container and content column for a settings screen.
 *
 * A measured column rather than full width. Their settings top out around this
 * width and it is not decoration: a form field stretched across a 27-inch
 * monitor puts its label and its input a foot apart, and the eye loses the row.
 */
export function SettingsPage({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  /** Primary action for the whole screen, e.g. "Create". */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
          <header className="mb-6 flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
              {description && (
                <p className="mt-1 max-w-prose text-caption text-muted-foreground">{description}</p>
              )}
            </div>
            {action}
          </header>
          <div className="space-y-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * The same header language, on a screen that holds a list rather than a form.
 *
 * ## Why this exists instead of reusing SettingsPage
 *
 * `SettingsPage` centres a measured column, which is right for a form and wrong
 * for a table: a users list or a tag list squeezed into 768px starts wrapping
 * columns that were readable at full width, and the "fix" is then to hide
 * columns nobody asked to lose. Respond.io's own list screens are wider than
 * their form screens for the same reason.
 *
 * So the two share a header treatment and differ on width — which is the actual
 * distinction, rather than pretending every settings screen is the same shape.
 * The list itself stays full-bleed and scrolls under a header that does not.
 */
export function SettingsListPage({
  title,
  description,
  action,
  toolbar,
  children,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Search, filters — sits below the header and above the list. */
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
      <header className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-5 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-caption text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </header>
      {toolbar}
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}

/**
 * One titled section.
 *
 * The description under the title is the part worth copying most: it turns a
 * settings page from a list of controls into something that explains itself, and
 * it is where the answer to "what does this actually do" belongs — rather than
 * in a tooltip nobody opens, or in support.
 */
export function SettingsSection({
  title,
  description,
  action,
  id,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  id?: string;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <section
      id={id}
      // scroll-mt keeps an anchored section clear of the sticky header when
      // linked to directly, e.g. /settings/general#auto-replies from the rail.
      className={cn('scroll-mt-20 rounded-lg border border-border bg-card', className)}
    >
      <div className="flex flex-wrap items-start gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-small font-semibold">{title}</h2>
          {description && (
            <p className="mt-0.5 max-w-prose text-caption text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children !== undefined && (
        <div className={cn('px-5 py-4', contentClassName)}>{children}</div>
      )}
    </section>
  );
}

/**
 * A labelled row: what it is on one side, the control on the other.
 *
 * Stacks below `sm`. On a phone a side-by-side row squeezes the control into a
 * strip too narrow to use, and every settings screen in this product is reached
 * from a phone by somebody.
 *
 * `htmlFor` is threaded through rather than optional-by-convention: a label that
 * does not point at its control is invisible to a screen reader and does not
 * focus the input when tapped, which on a phone is most of how labels are used.
 */
export function SettingsField({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:gap-6', className)}>
      <div className="min-w-0 sm:w-1/3 sm:shrink-0 sm:pt-1.5">
        <label htmlFor={htmlFor} className="text-small font-medium">{label}</label>
        {hint && <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Divided stack of fields inside a section. */
export function SettingsFields({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-border', className)}>{children}</div>;
}

/**
 * The footer a section gets when it has something to save.
 *
 * Inside the section rather than floating at the bottom of the screen, because
 * a single page-level Save button on a screen with six independent sections
 * leaves the operator guessing which of them it applies to.
 */
export function SettingsActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3', className)}>
      {children}
    </div>
  );
}
