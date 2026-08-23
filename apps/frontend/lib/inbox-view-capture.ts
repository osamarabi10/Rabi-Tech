import type { InboxView, InboxViewFilter } from '@/lib/data';
import type { InboxScope } from '@/components/inbox/inbox-selector';

/**
 * Turning what an agent is currently looking at into a filter they can keep.
 *
 * "Save this view" only earns its name if the thing it saves is the thing on
 * screen. The inbox holds its filter across three separate pieces of state —
 * the scope in column 1, the status pill above the list, and the label chip —
 * and this is the one place that knows how all three map onto the stored
 * grammar.
 *
 * Two of them cannot be captured, and saying so is the point:
 *
 * - **Mentions** lives on notifications, not on the conversation, so there is
 *   no field in the grammar that could express it. A view claiming to be
 *   "mentions" would quietly be a view of everything.
 * - **Search** is server-side text matching over message bodies, not a property
 *   of a thread. A saved search would need the query re-run, which is a
 *   different feature from a saved filter.
 *
 * Both are reported rather than dropped. Silently saving a view that means
 * something narrower than what the agent could see is the failure this function
 * exists to prevent.
 */

export type Capture = {
  filter: InboxViewFilter;
  /** Human-readable list of what will be saved, for the confirmation dialog. */
  describes: string[];
  /**
   * Parts of the current view that cannot be stored, named so the dialog can
   * say which. Empty means what you see is exactly what you get.
   */
  omits: string[];
};

/** The status pill above the list. Its own vocabulary, older than the grammar. */
export type ConvStatusFilter = 'all' | 'open' | 'pending' | 'awaiting' | 'mine' | 'resolved';

const STATUS_BY_PILL: Record<string, InboxViewFilter['status']> = {
  open: ['OPEN'],
  pending: ['PENDING'],
  awaiting: ['AWAITING_CLIENT'],
  resolved: ['RESOLVED'],
};

export function captureView(
  scope: InboxScope,
  convFilter: ConvStatusFilter,
  labelFilter: string | null,
  /** Dictionary lookup, so this file holds no language of its own. */
  t: (key: string) => string,
  /** Resolves a team id to its name for the description. */
  teamName: (id: string) => string,
  /** The saved view that is the current scope, when one is. */
  lookupView: (id: string) => InboxView | undefined,
): Capture {
  const filter: InboxViewFilter = {};
  const describes: string[] = [];
  const omits: string[] = [];

  // Start from an existing view when that is what is open, so "save this view"
  // after tweaking a status pill keeps the criteria the view already carried
  // rather than silently discarding them.
  if (scope.kind === 'view') {
    const base = lookupView(scope.value);
    Object.assign(filter, base?.filter ?? {});
    // Named, not just copied. Saying nothing here would show a dialog that
    // lists a status pill and omits the six criteria it is also about to
    // save — the precise kind of quiet inaccuracy this summary exists to
    // prevent.
    if (base) describes.push(t('من العرض') + ': ' + base.name);
  } else if (scope.kind === 'team') {
    filter.teamIds = [scope.value];
    describes.push(t('فريق') + ': ' + teamName(scope.value));
  } else if (scope.kind === 'lifecycle') {
    filter.lifecycleStages = [scope.value];
    describes.push(t('مرحلة العميل') + ': ' + scope.value);
  } else if (scope.value === 'mine') {
    filter.assignee = 'me';
    describes.push(t('مُسندة لي'));
  } else if (scope.value === 'unassigned') {
    filter.assignee = 'unassigned';
    describes.push(t('غير مسندة'));
  } else if (scope.value === 'snoozed') {
    filter.includeSnoozed = true;
    describes.push(t('مؤجّلة'));
  } else if (scope.value === 'mentions') {
    omits.push(t('ذُكرت فيها'));
  }

  // The status pill wins over anything the scope said about status, because it
  // is the control the agent touched most recently.
  if (convFilter === 'mine') {
    filter.assignee = 'me';
    if (!describes.includes(t('مُسندة لي'))) describes.push(t('مُسندة لي'));
  } else if (STATUS_BY_PILL[convFilter]) {
    filter.status = STATUS_BY_PILL[convFilter];
    describes.push(t('الحالة') + ': ' + t(STATUS_LABELS[convFilter]));
  }

  if (labelFilter) {
    filter.labels = [labelFilter];
    describes.push(t('تصنيف') + ': ' + labelFilter);
  }

  if (Object.keys(filter).length === 0 && omits.length === 0) {
    describes.push(t('كل المحادثات'));
  }

  return { filter, describes, omits };
}

/** Pill value → the same word the pill itself shows. */
const STATUS_LABELS: Record<string, string> = {
  open: 'مفتوحة',
  pending: 'معلّقة',
  awaiting: 'بانتظار العميل',
  resolved: 'محلولة',
};
