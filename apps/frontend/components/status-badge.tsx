import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export function StatusBadge({
  label,
  color,
  className,
}: {
  label: string;
  color: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent font-semibold', className)}
      style={{ backgroundColor: `${color}20`, color }}
    >
      {label}
    </Badge>
  );
}
