/**
 * The grammar of a saved view.
 *
 * Two rules shape everything here.
 *
 * **Every field must be answerable from a `Conv` the client already holds.**
 * Counts in the inbox selector are computed client-side, because the
 * conversation list endpoint has no pagination. A view whose filter needed a
 * server round-trip would show a count that disagrees with the list it opens —
 * the exact failure that hit the snooze counts twice. When the list is
 * paginated, views move server-side together with the other scopes.
 *
 * **The filter is user input stored as JSON.** It is validated here on write
 * and never trusted on read. A malformed filter that reaches the client breaks
 * the inbox for everyone who can see the view, and for a shared view that is
 * the entire workspace. Unknown keys are rejected rather than ignored: silently
 * dropping a key someone typed means a view that does not filter the way its
 * author believes it does.
 */

/** Mirrors `ConversationStatus`. `CLOSED` does not exist in this product. */
const STATUSES = ['OPEN', 'PENDING', 'RESOLVED', 'AWAITING_CLIENT'] as const;
export type InboxViewStatus = (typeof STATUSES)[number];

export type InboxViewFilter = {
  /** Any-of. Empty or absent means every status. */
  status?: InboxViewStatus[];
  /**
   * `'me'` resolves per-viewer rather than being frozen at save time, so one
   * shared "my open threads" view means the right thing to each member. A
   * hardcoded user id in a shared view is a view that is wrong for everyone
   * but one person.
   */
  assignee?: 'me' | 'unassigned' | { userIds: string[] };
  teamIds?: string[];
  /**
   * The number a thread arrived on, not the gateway it was served by.
   *
   * Conversations carry a `sessionId`; `OrganizationChannel` is the gateway
   * deployment. Filtering by channel on a shared gateway would match every
   * conversation in the workspace — the same conflation that left one
   * subscriber reading FAILED for weeks while its gateway answered 200.
   */
  sessionNames?: string[];
  labels?: string[];
  lifecycleStages?: string[];
  /** `firstResponseAt === null` — nobody has replied yet. */
  unansweredOnly?: boolean;
  /** Snoozed threads stay out of every view unless one asks for them. */
  includeSnoozed?: boolean;
};

const KEYS = [
  'status',
  'assignee',
  'teamIds',
  'sessionNames',
  'labels',
  'lifecycleStages',
  'unansweredOnly',
  'includeSnoozed',
] as const;

/**
 * Caps on a blob a user controls.
 *
 * Without them a filter is an unbounded write: a megabyte of label strings
 * stored per view, sent to every member of the workspace on every inbox load.
 */
const MAX_ITEMS = 50;
const MAX_ITEM_LENGTH = 200;

export class InboxViewFilterError extends Error {
  constructor(message: string, readonly key?: string) {
    super(message);
    this.name = 'InboxViewFilterError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A list of non-empty strings, deduplicated.
 *
 * Duplicates are dropped rather than rejected: two identical labels is a
 * clumsy filter, not an invalid one, and refusing the save would be a worse
 * answer than fixing it.
 */
function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) {
    throw new InboxViewFilterError(`الحقل «${key}» لازم يكون قائمة`, key);
  }
  if (value.length > MAX_ITEMS) {
    throw new InboxViewFilterError(`الحقل «${key}» فيه عناصر أكثر من اللازم (الحد ${MAX_ITEMS})`, key);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new InboxViewFilterError(`الحقل «${key}» لازم يكون قائمة نصوص`, key);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ITEM_LENGTH) {
      throw new InboxViewFilterError(`قيمة طويلة جدًا في «${key}» (الحد ${MAX_ITEM_LENGTH} حرف)`, key);
    }
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function boolean(value: unknown, key: string): boolean {
  if (typeof value !== 'boolean') {
    throw new InboxViewFilterError(`الحقل «${key}» لازم يكون صح أو خطأ`, key);
  }
  return value;
}

/**
 * Validate a filter and return the normalized value to store.
 *
 * Returns a fresh object rather than the input: whatever else the caller sent
 * is not carried into the database by reference.
 *
 * Keys whose value normalizes to empty are dropped. An empty array already
 * means "no constraint" everywhere in this grammar, so storing it would
 * preserve a distinction that has no meaning and that the evaluator would have
 * to keep pretending to honour.
 */
export function validateInboxViewFilter(input: unknown): InboxViewFilter {
  if (!isPlainObject(input)) {
    throw new InboxViewFilterError('الفلتر لازم يكون كائن');
  }

  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new InboxViewFilterError(`حقل غير معروف في الفلتر: «${key}»`, key);
    }
  }

  const out: InboxViewFilter = {};

  if (input.status !== undefined) {
    const list = stringList(input.status, 'status');
    for (const value of list) {
      if (!(STATUSES as readonly string[]).includes(value)) {
        throw new InboxViewFilterError(`حالة غير معروفة: «${value}»`, 'status');
      }
    }
    if (list.length) out.status = list as InboxViewStatus[];
  }

  if (input.assignee !== undefined) {
    const assignee = input.assignee;
    if (assignee === 'me' || assignee === 'unassigned') {
      out.assignee = assignee;
    } else if (isPlainObject(assignee)) {
      const extra = Object.keys(assignee).find((k) => k !== 'userIds');
      if (extra) {
        throw new InboxViewFilterError(`حقل غير معروف في «assignee»: «${extra}»`, 'assignee');
      }
      const userIds = stringList(assignee.userIds, 'assignee.userIds');
      if (userIds.length) out.assignee = { userIds };
    } else {
      throw new InboxViewFilterError('قيمة «assignee» غير صالحة', 'assignee');
    }
  }

  for (const key of ['teamIds', 'sessionNames', 'labels', 'lifecycleStages'] as const) {
    if (input[key] === undefined) continue;
    const list = stringList(input[key], key);
    if (list.length) out[key] = list;
  }

  for (const key of ['unansweredOnly', 'includeSnoozed'] as const) {
    if (input[key] === undefined) continue;
    // `false` is the default for both, so storing it preserves nothing.
    if (boolean(input[key], key)) out[key] = true;
  }

  return out;
}
