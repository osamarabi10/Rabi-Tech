import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * The type scale is named for role — `text-caption`, `text-micro` — and those
 * are plain CSS classes in globals.css rather than Tailwind theme sizes.
 *
 * tailwind-merge does not know them, and `text-*` is ambiguous: it could be a
 * size or a colour. Faced with `cn('text-caption', 'text-primary')` it assumed
 * one group and dropped the first, so any component that set a role size and a
 * colour in the same `cn()` call silently rendered at the inherited 16px. The
 * settings sub-navigation was doing exactly that — an 11px control shipping at
 * 16px, which nothing flagged because both classes were present in the source.
 *
 * Registering them as font sizes is the fix at the root: every existing call
 * site keeps working, and the next role added to the scale only needs a line
 * here.
 */
const ROLE_FONT_SIZES = [
  'display',
  'h1',
  'h2',
  'h3',
  'body',
  'small',
  'caption',
  'micro',
];

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ROLE_FONT_SIZES }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function renderTemplate(body: string, vars: Record<string, string>) {
  const legacy = body.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
  const contact: Record<string, string | undefined> = {
    name: vars.contactName,
    phone: vars.contactPhone,
  };
  return legacy.replace(/\$contact\.(name|phone)\b/g, (original, key: string) => contact[key] || original);
}
