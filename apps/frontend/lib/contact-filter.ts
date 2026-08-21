/**
 * Shared client-side vocabulary for the contact filter DSL.
 *
 * Why this file exists: the "is this rule complete enough to send?" test used to
 * be written out three times — once in the contacts page and twice in the
 * campaign composer — as a literal `['isEmpty','isNotEmpty'].includes(...)`.
 * Every one of those sites silently *drops* rules it considers incomplete, so
 * adding an operator that legitimately carries no value (or carries two) meant
 * the filter would quietly stop working in whichever site nobody remembered to
 * update. A dropped rule is the worst kind of bug here: the audience gets
 * bigger, no error appears, and the messages have already been sent.
 *
 * The backend owns the real vocabulary — `lib/contact-filter-dsl.ts` is what
 * actually compiles to SQL and what rejects unknown fields. This mirror exists
 * only so the builder can render sensible inputs and avoid sending obvious
 * rubbish. Keep the two in lockstep; the backend is the authority.
 */

import type { ContactFilterDsl, ContactFilterRule } from '@/lib/data';

type Node = ContactFilterRule | ContactFilterDsl;

function isGroup(node: Node): node is ContactFilterDsl {
  return Array.isArray((node as ContactFilterDsl).$and) || Array.isArray((node as ContactFilterDsl).$or);
}

/**
 * Operators that are complete on their own. Asking "does this rule have a
 * value?" is wrong for these — "email is empty" has no value by definition.
 */
export const VALUELESS_OPERATORS = new Set<string>(['isEmpty', 'isNotEmpty', 'hasNoBroadcasts']);

/**
 * Operators taking a second value. `between` is the obvious one (a range needs
 * two ends); `receivedCampaignWithinDays` pairs a campaign with a day count.
 * A rule using these is incomplete until *both* halves are filled, which the
 * old single-`value` check could not express.
 */
export const TWO_VALUE_OPERATORS = new Set<string>(['between', 'receivedCampaignWithinDays']);

function filled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0 && value.every(filled);
  return String(value).trim().length > 0;
}

/**
 * Whether a rule carries enough to be worth sending to the server.
 *
 * Deliberately permissive about *correctness* — that is the backend's job, and
 * it returns a real error. This only strips rules the user has not finished
 * typing, so the audience count does not thrash on every keystroke.
 */
export function isRuleComplete(rule: ContactFilterRule): boolean {
  if (!rule?.operator) return false;
  if (!rule.field && rule.category !== 'tag') return false;
  if (VALUELESS_OPERATORS.has(rule.operator)) return true;
  if (TWO_VALUE_OPERATORS.has(rule.operator)) {
    return filled(rule.value) && filled(rule.value2);
  }
  return filled(rule.value);
}

/**
 * Drop unfinished rules, keeping the tree shape.
 *
 * Recursive because a group is a node too: the flat version treated a group as
 * a rule with no operator, judged it incomplete, and silently deleted the whole
 * branch — the exact class of bug this module exists to prevent. A group that
 * ends up empty is dropped, since an empty group matches everything and would
 * quietly widen the audience.
 */
export function pruneFilter(node: Node): Node | null {
  if (!isGroup(node)) return isRuleComplete(node as ContactFilterRule) ? node : null;
  const op: '$and' | '$or' = (node as ContactFilterDsl).$or ? '$or' : '$and';
  const children = (((node as ContactFilterDsl).$or || (node as ContactFilterDsl).$and || []) as Node[])
    .map(pruneFilter)
    .filter((child): child is Node => child !== null);
  if (!children.length) return null;
  return { [op]: children } as ContactFilterDsl;
}

/**
 * The filter to send, or null when nothing is filled in. Null means "everyone",
 * which every caller already treats as the unfiltered case.
 */
export function activeFilter(filter: ContactFilterDsl | undefined | null): ContactFilterDsl | null {
  if (!filter) return null;
  return pruneFilter(filter) as ContactFilterDsl | null;
}

/** Flat convenience for callers that only ever build a single AND list. */
export function activeRules(rules: ContactFilterRule[] | undefined): ContactFilterRule[] {
  return (rules || []).filter(isRuleComplete);
}

/** How many actual rules a (possibly nested) filter contains, for the "N filters" badge. */
export function countRules(node: Node | null | undefined): number {
  if (!node) return 0;
  if (!isGroup(node)) return 1;
  const children = ((node.$or || node.$and || []) as Node[]);
  return children.reduce((total, child) => total + countRules(child), 0);
}
