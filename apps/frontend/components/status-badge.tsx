'use client';

import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/lib/theme';
import { useT } from '@/lib/i18n';
import { tintedStyle } from '@/lib/tint';
import { cn } from '@/lib/utils';

/**
 * A status chip in an arbitrary colour.
 *
 * The colour may be a hex literal or a CSS token expression, so the styling
 * goes through tintedStyle() rather than string-concatenating alpha — see that
 * file for why that distinction cost every status badge its background once.
 *
 * The label is translated here rather than at each call site. Most callers pass
 * a raw label straight out of `lib/constants.ts`, which is written in the Arabic
 * source language — so an English or Hebrew interface showed "مفتوح" on the
 * status chip while every control around it was translated. Doing it here is
 * idempotent: `t()` falls back to its own key, so a caller that already
 * translated its label passes through unchanged.
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
  const { t } = useT();
  return (
    <Badge
      variant="outline"
      className={cn('border-transparent font-semibold', className)}
      style={tintedStyle(color, resolved === 'dark')}
    >
      {t(label)}
    </Badge>
  );
}
