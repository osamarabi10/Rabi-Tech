/**
 * Per-message text direction.
 *
 * A message's direction is a property of *its own content*, not of the interface
 * language. A Hebrew-speaking customer who writes one English sentence should
 * see that sentence render left-to-right while the surrounding UI stays RTL —
 * inheriting the interface direction is what produces the misplaced punctuation
 * and scrambled mixed-direction runs that make Arabic and Hebrew chat apps feel
 * broken.
 *
 * The rule is the Unicode first-strong heuristic: scan for the first character
 * with a strong directional property and use it. Digits, punctuation, emoji and
 * whitespace are neutral and are skipped — "!!! hello" is LTR, "!!! مرحبا" is RTL.
 */

/** Hebrew, Arabic, and the Arabic presentation/supplement blocks. */
const RTL_STRONG =
  /[֐-׿؀-ۿ܀-ݏݐ-ݿހ-޿ࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;

/** Latin, Greek, Cyrillic — enough for the languages this product serves. */
const LTR_STRONG = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

export type TextDirection = 'rtl' | 'ltr';

/**
 * Direction of a string, or `null` when it carries no directional signal at all
 * (digits, punctuation, emoji only) — the caller should then inherit.
 */
export function detectDirection(text: string): TextDirection | null {
  if (!text) return null;
  for (const char of text) {
    if (RTL_STRONG.test(char)) return 'rtl';
    if (LTR_STRONG.test(char)) return 'ltr';
  }
  return null;
}

/**
 * `dir` for a message bubble. Falls back to `auto`, which applies the same
 * first-strong rule in the browser, so an undetected string still behaves.
 */
export function messageDir(text: string): 'rtl' | 'ltr' | 'auto' {
  return detectDirection(text) ?? 'auto';
}

/** U+2068 FIRST STRONG ISOLATE — opens an isolated run. */
const FSI = '⁨';
/** U+2069 POP DIRECTIONAL ISOLATE — closes it. */
const PDI = '⁩';

/**
 * Isolates a value so it cannot reorder the text around it.
 *
 * The classic failure: a phone number or ID rendered inside an Arabic sentence
 * has its leading `+` or trailing punctuation flung to the wrong end, because
 * the bidi algorithm resolves the neutral characters against the surrounding
 * paragraph rather than the number. Wrapping in FSI…PDI scopes that resolution
 * to the value itself. This is the single most common bidi bug in RTL products.
 *
 * Prefer a `<bdi>` element in JSX where one fits; use this for plain strings
 * built by interpolation.
 */
export function isolate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `${FSI}${value}${PDI}`;
}
