'use client';

import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';

/**
 * A pill in a colour the *tenant* chose — a team colour, a conversation label.
 *
 * These colours come from the database, not from the palette, so they cannot be
 * tokenised and cannot be audited at build time: a subscriber may pick anything.
 * What can be controlled is how the colour is *used*.
 *
 * On light, the colour reads as text over a 10% tint of itself. On dark that
 * inverts: the colour becomes the fill and the text is written on it in white,
 * where the tenant's colour is a background and contrast rules do not apply to
 * it. A mid-blue team colour measures about 3.3:1 as text on a dark tint, and
 * no amount of palette work fixes that — only changing which role the colour
 * plays does.
 */
export function ColorPill({
  color,
  children,
  className,
}: {
  /** Hex from tenant data, e.g. a Team.color. */
  color: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { resolved } = useTheme();
  const dark = resolved === 'dark';

  return (
    <span
      className={cn('shrink-0 rounded-full border px-2 py-0.5 text-[10px]', className)}
      style={
        dark
          ? { backgroundColor: color, color: '#fff', borderColor: color }
          : { backgroundColor: `${color}1A`, color, borderColor: `${color}40` }
      }
    >
      {children}
    </span>
  );
}
