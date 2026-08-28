import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal, Search, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function ListToolbar({ primaryAction, searchValue, onSearchChange, searchLabel, clearSearchLabel, filters, className }: { primaryAction?: ReactNode; searchValue: string; onSearchChange: (value: string) => void; searchLabel: string; clearSearchLabel: string; filters?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-b border-border bg-card p-3', className)}>
      {primaryAction}
      {filters && <div className="flex flex-wrap items-center gap-2">{filters}</div>}
      <div className="relative ms-auto min-w-48 flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={searchValue} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="ps-9 pe-9" />
        {searchValue && <button type="button" onClick={() => onSearchChange('')} aria-label={clearSearchLabel} className="absolute end-2 top-1/2 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><X className="size-3.5" /></button>}
      </div>
    </div>
  );
}

export function Pager({ entityLabel, pageSize, pageSizeOptions = [25, 50, 100], start, end, total, previousLabel, nextLabel, onPageSizeChange, onPrevious, onNext, hasPrevious, hasNext }: { entityLabel: string; pageSize: number; pageSizeOptions?: number[]; start: number; end: number; total: number; previousLabel: string; nextLabel: string; onPageSizeChange: (value: number) => void; onPrevious: () => void; onNext: () => void; hasPrevious: boolean; hasNext: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card px-3 py-2 text-caption text-muted-foreground">
      <label className="flex items-center gap-2"><span>{entityLabel}</span><select className="select-field select-field-sm" value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>{pageSizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
      <div className="flex items-center gap-2">
        <span className="numeric" dir="ltr">{start}-{end} / {total}</span>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onPrevious} disabled={!hasPrevious} aria-label={previousLabel}><ChevronRight className="size-4 rtl:hidden" /><ChevronLeft className="hidden size-4 rtl:block" /></Button>
        <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onNext} disabled={!hasNext} aria-label={nextLabel}><ChevronLeft className="size-4 rtl:hidden" /><ChevronRight className="hidden size-4 rtl:block" /></Button>
      </div>
    </div>
  );
}

export function BulkActionBar({ countLabel, actions, className }: { countLabel: string; actions: ReactNode; className?: string }) {
  return <div className={cn('flex min-h-14 flex-wrap items-center gap-2 border-b border-primary/20 bg-primary/5 px-3 py-2', className)} role="toolbar" aria-label={countLabel}><strong className="text-small">{countLabel}</strong><div className="ms-auto flex flex-wrap items-center gap-2">{actions}</div></div>;
}

export type RowAction = {
  label: string;
  onSelect: () => void;
  icon?: LucideIcon;
  destructive?: boolean;
  disabled?: boolean;
};

export function RowOverflowMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8" aria-label={label}>
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              key={action.label}
              disabled={action.disabled}
              className={action.destructive ? 'text-destructive focus:text-destructive' : undefined}
              onSelect={action.onSelect}
            >
              {Icon && <Icon aria-hidden />}
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4', className)}>{children}</div>;
}
