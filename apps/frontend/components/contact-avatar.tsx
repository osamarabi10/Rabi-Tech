'use client';

import { avatarColor } from '@/lib/constants';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useTheme } from '@/lib/theme';
import { tintedStyle } from '@/lib/tint';
import { cn } from '@/lib/utils';

/**
 * A contact's initial on their colour.
 *
 * `AVATAR_COLORS` is a fixed rotation so one contact keeps the same colour
 * everywhere — that is the point of it, and it should not become a token.
 *
 * But the rendering has to differ by theme. On light, the colour reads as text
 * over a 13% tint of itself. On dark that same dark purple over a dark tint
 * lands around 2.4:1, so dark inverts the relationship: the colour becomes the
 * fill and the initial is written on it in white, where the colour is a
 * background and contrast rules do not apply to it.
 *
 * Extracted because the inbox list and the contacts table had the same inline
 * style duplicated, so the dark bug existed in both and would have been fixed
 * in one.
 */
export function ContactAvatar({
  phone,
  label,
  className,
  textClassName,
}: {
  phone: string;
  /** Usually the contact's name; the first character is shown. */
  label?: string | null;
  className?: string;
  textClassName?: string;
}) {
  const { resolved } = useTheme();
  const color = avatarColor(phone);
  const dark = resolved === 'dark';

  return (
    <Avatar className={cn('h-8 w-8', className)}>
      <AvatarFallback
        className={cn('text-xs font-semibold', textClassName)}
        style={tintedStyle(color, dark)}
      >
        {(label || '?').charAt(0)}
      </AvatarFallback>
    </Avatar>
  );
}
