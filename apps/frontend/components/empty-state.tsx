import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one empty state.
 *
 * There were ten variants across the app at three different type scales, some
 * centred and some not, some inside a card and some bare. They all say the same
 * thing — "there is nothing here yet" — and the inconsistency is visible any
 * time a user moves between two pages.
 *
 * Deliberately supports a `hint`: an empty list that only says "no automations"
 * tells the user what they can already see. Saying what would put something
 * there is the part that helps.
 */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className,
  compact,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
  /** For narrow panes such as the conversation list, where a tall block would push content off-screen. */
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-4 py-8' : 'px-6 py-12',
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn('text-muted-foreground/50', compact ? 'h-6 w-6' : 'h-8 w-8')}
          aria-hidden
        />
      )}
      <p className={cn('font-medium text-foreground', compact ? 'text-xs' : 'text-sm')}>{title}</p>
      {hint && (
        <p className={cn('max-w-sm text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
          {hint}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
