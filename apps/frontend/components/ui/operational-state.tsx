import type { LucideIcon } from 'lucide-react';
import { AlertTriangle, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type StateFrameProps = {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  compact?: boolean;
};

function StateFrame({ icon: Icon, title, description, action, className, compact }: StateFrameProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 text-center', compact ? 'px-4 py-8' : 'px-6 py-12', className)}>
      {Icon && <Icon className={cn('text-muted-foreground/60', compact ? 'size-6' : 'size-8')} aria-hidden />}
      <h2 className={cn('font-semibold text-foreground', compact ? 'text-small' : 'text-body')}>{title}</h2>
      {description && <p className="max-w-sm text-small text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function EmptyState(props: StateFrameProps) {
  return <StateFrame {...props} />;
}

export function NoResultsState({ title, description, clearLabel, onClear, className, compact }: Omit<StateFrameProps, 'icon' | 'action'> & { clearLabel: string; onClear: () => void }) {
  return <StateFrame icon={SearchX} title={title} description={description} className={className} compact={compact} action={<Button type="button" variant="outline" size="sm" onClick={onClear}>{clearLabel}</Button>} />;
}

export function ErrorState({ title, description, retryLabel, onRetry, className, compact }: Omit<StateFrameProps, 'icon' | 'action'> & { retryLabel: string; onRetry: () => void }) {
  return <StateFrame icon={AlertTriangle} title={title} description={description} className={className} compact={compact} action={<Button type="button" variant="outline" size="sm" onClick={onRetry}>{retryLabel}</Button>} />;
}

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden />;
}

export function LayoutSkeleton({ label, rows = 6, className }: { label: string; rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn('space-y-3 p-4', className)}>
      <SkeletonBlock className="h-8 w-1/3" />
      {Array.from({ length: rows }).map((_, index) => <SkeletonBlock key={index} className="h-12 w-full" />)}
    </div>
  );
}
