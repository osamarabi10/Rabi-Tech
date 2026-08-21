import type { CSSProperties } from 'react';

/**
 * How a colour is rendered as a chip, in one place.
 *
 * Two kinds of colour arrive here and they need opposite treatment:
 *
 * **Theme-aware tokens** — `hsl(var(--status-open))`. The palette already flips
 * these per theme: light mode darkens them for text on white, dark mode lifts
 * them for text on a dark canvas. So they stay colour-as-text over a faint tint
 * in *both* themes, and the token does the work.
 *
 * **Fixed colours** — a hex a subscriber chose for a team, or one from the
 * avatar rotation. The palette does not own these, so they cannot flip. A
 * mid-tone hex as text over a dark tint lands around 2.4:1 and no palette change
 * rescues it. For these, dark swaps the roles: the colour becomes the fill and
 * the text is white on it.
 *
 * Getting this distinction wrong is visible either way. Swapping roles for a
 * *token* puts white text on an already-lifted amber fill — 1.6:1, worse than
 * where it started.
 *
 * ## Why color-mix rather than `${color}20`
 *
 * Hex-alpha concatenation only works on hex literals. When status colours became
 * tokens, three call sites kept concatenating and produced
 * `hsl(var(--status-open))20` — invalid CSS, so the tint silently vanished from
 * every status badge. Nothing caught it: a contrast audit cannot see a *missing*
 * background, only the text against whatever ends up behind it.
 */

/** A colour the palette controls, and therefore one that already themes itself. */
function isThemeAware(color: string): boolean {
  return color.includes('var(--');
}

export function tintedStyle(color: string, dark: boolean): CSSProperties {
  const tinted: CSSProperties = {
    backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
    color,
    borderColor: `color-mix(in srgb, ${color} 28%, transparent)`,
  };

  if (!dark || isThemeAware(color)) return tinted;

  return { backgroundColor: color, color: '#fff', borderColor: color };
}
