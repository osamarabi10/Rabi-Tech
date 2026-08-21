'use client';

import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/lib/theme';
import { tintedStyle } from '@/lib/tint';
import { cn } from '@/lib/utils';

/**
 * A status chip in an arbitrary colour.
 *
 * The colour may be a hex literal or a CSS token expression, so the styling
 * goes through tintedStyle() rather than string-concatenating alpha — see that
 * file for why that distinction cost every status badge its background once.
 */
export function StatusBadge({
  label,
  color,
  className,
}: {
  label: string;
  color: string;
  className?: string;
}) {
  const { resolved } = useTheme();
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent font-semibold', className)}
      style={tintedStyle(color, resolved === 'dark')}
    >
      {label}
    </Badge>
  );
}
